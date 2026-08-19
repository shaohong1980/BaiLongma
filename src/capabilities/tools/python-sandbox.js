// tools/python-sandbox.js —— Python 代码沙箱执行器（P0）
//
// 功能：
//   - 通过 child_process spawn 执行 Python 代码（隔离工作目录在沙箱内）
//   - 自动注入 matplotlib Agg 后端，图表保存为 PNG
//   - 超时控制（默认 30s，上限 120s）
//   - 返回 stdout、stderr、exit_code、生成的图片列表
//   - 自动检测 python 可执行文件（python / python3 / py）
//
// 安全边界：
//   - 工作目录固定在 sandbox/python/<session_id>/
//   - 不限制网络/文件系统（Python 本身没有沙箱机制，依赖用户信任）
//   - 超时强制 kill 进程树
//   - 输出大小限制（stdout/stderr 各 100KB）

import fs from 'fs'
import path from 'path'
import { spawn, spawnSync } from 'child_process'
import crypto from 'crypto'
import { paths } from '../../paths.js'
import { throwIfAborted } from '../abort-utils.js'

const PYTHON_WORK_DIR = path.join(paths.sandboxDir, 'python')
const MAX_OUTPUT_BYTES = 100 * 1024  // 100KB per stream
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 120_000

function toolJson(payload) {
  return JSON.stringify(payload, null, 2)
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
}

// 检测可用的 Python 可执行文件
let cachedPythonCmd = null
export function detectPython() {
  if (cachedPythonCmd) return cachedPythonCmd
  const candidates = process.platform === 'win32'
    ? ['python', 'py', 'python3']
    : ['python3', 'python']
  for (const cmd of candidates) {
    try {
      // 用 --version 快速检测，不实际运行代码
      const result = spawnSyncSafe(cmd, ['--version'], { timeout: 3000 })
      if (result.exitCode === 0) {
        cachedPythonCmd = cmd
        return cmd
      }
    } catch { /* try next */ }
  }
  return null
}

// 同步 spawn 包装（仅用于检测，不用于执行用户代码）
function spawnSyncSafe(cmd, args, opts) {
  try {
    return spawnSync(cmd, args, { ...opts, encoding: 'utf8' })
  } catch {
    return { exitCode: -1, stdout: '', stderr: '' }
  }
}

// 构建执行前的 preamble：设置 matplotlib 后端、输出目录、异常捕获
function buildPreamble(outputDir) {
  return `
import sys
import os
import traceback

# 输出目录（图表保存位置）
__output_dir__ = r'${outputDir.replace(/\\/g, '\\\\')}'
os.makedirs(__output_dir__, exist_ok=True)

# matplotlib 非交互后端 + 自动保存图表
try:
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    _orig_show = plt.show
    def _auto_save_show(*args, **kwargs):
        import uuid
        _fig = plt.gcf()
        if _fig.get_axes():
            _path = os.path.join(__output_dir__, f'plot_{uuid.uuid4().hex[:8]}.png')
            _fig.savefig(_path, dpi=150, bbox_inches='tight')
            print(f'[PLOT_SAVED] {_path}', file=sys.stderr)
        plt.close(_fig)
    plt.show = _auto_save_show
except ImportError:
    pass

# pandas 显示设置
try:
    import pandas as pd
    pd.set_option('display.max_columns', 20)
    pd.set_option('display.width', 200)
except ImportError:
    pass

print('[PYTHON_READY]', file=sys.stderr)
`
}

// 执行 Python 代码
export async function execRunPython(args = {}, context = {}) {
  throwIfAborted(context.signal)

  const code = String(args.code || '').trim()
  if (!code) return toolJson({ ok: false, tool: 'run_python', error: '缺少 code（要执行的 Python 代码）' })

  const pythonCmd = detectPython()
  if (!pythonCmd) {
    return toolJson({
      ok: false,
      tool: 'run_python',
      error: '未检测到 Python 环境',
      hint: '请安装 Python 3.8+ 并确保在 PATH 中可用。Windows: 从 python.org 安装；macOS: brew install python；Linux: apt install python3',
    })
  }

  const timeoutMs = Math.min(
    Math.max(Number(args.timeout_ms) || DEFAULT_TIMEOUT_MS, 1000),
    MAX_TIMEOUT_MS
  )

  // 创建会话工作目录
  const sessionId = crypto.randomBytes(4).toString('hex')
  const workDir = path.join(PYTHON_WORK_DIR, sessionId)
  ensureDir(workDir)
  const outputDir = path.join(workDir, 'outputs')
  ensureDir(outputDir)

  // 写入代码文件（preamble + 用户代码）
  const scriptPath = path.join(workDir, 'script.py')
  const fullScript = buildPreamble(outputDir) + '\n# === 用户代码 ===\n' + code + '\n'
  try {
    fs.writeFileSync(scriptPath, fullScript, 'utf-8')
  } catch (err) {
    return toolJson({ ok: false, tool: 'run_python', error: `写入脚本失败: ${err.message}` })
  }

  // 执行
  const result = await new Promise((resolve) => {
    const child = spawn(pythonCmd, [scriptPath], {
      cwd: workDir,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch {}
      // Windows 下 kill 可能不杀子进程，用 taskkill 兜底
      if (process.platform === 'win32') {
        try { spawn('taskkill', ['/pid', String(child.pid), '/f', '/t']) } catch {}
      }
    }, timeoutMs)

    child.stdout.on('data', (d) => {
      if (stdoutBytes < MAX_OUTPUT_BYTES) {
        const chunk = d.toString('utf-8')
        stdout += chunk
        stdoutBytes += Buffer.byteLength(chunk)
      }
    })
    child.stderr.on('data', (d) => {
      if (stderrBytes < MAX_OUTPUT_BYTES) {
        const chunk = d.toString('utf-8')
        stderr += chunk
        stderrBytes += Buffer.byteLength(chunk)
      }
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ exitCode: -1, stdout, stderr, error: err.message, timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ exitCode: code, stdout, stderr, timedOut })
    })
  })

  // 扫描生成的图片
  const plots = []
  try {
    if (fs.existsSync(outputDir)) {
      const files = fs.readdirSync(outputDir).filter(f => f.endsWith('.png'))
      for (const f of files) {
        const fullPath = path.join(outputDir, f)
        const stat = fs.statSync(fullPath)
        plots.push({ path: fullPath, name: f, size: stat.size })
      }
    }
  } catch { /* ignore */ }

  // 清理 stderr 中的 [PYTHON_READY] 标记
  const cleanStderr = result.stderr.replace(/\[PYTHON_READY\]\s*/g, '').trim()

  const output = {
    ok: result.exitCode === 0 && !result.timedOut,
    tool: 'run_python',
    exit_code: result.exitCode,
    timed_out: result.timedOut,
    stdout: result.stdout.slice(0, 8000),
    stdout_truncated: result.stdout.length > 8000,
    stderr: cleanStderr.slice(0, 4000),
    stderr_truncated: cleanStderr.length > 4000,
    plots,
    session_id: sessionId,
    work_dir: workDir,
  }

  if (result.timedOut) {
    output.error = `执行超时（${timeoutMs / 1000}s），进程已被强制终止`
  } else if (result.exitCode !== 0) {
    output.error = `Python 执行失败（exit code ${result.exitCode}）`
  }
  if (plots.length > 0) {
    output.hint = `生成了 ${plots.length} 张图表，可用 read_file 查看或通过 UI 展示。路径在沙箱内。`
  }

  return toolJson(output)
}

// 列出 Python 环境已安装的包（供 Agent 判断能用什么库）
export function execPythonPackages() {
  const pythonCmd = detectPython()
  if (!pythonCmd) return toolJson({ ok: false, tool: 'python_packages', error: '未检测到 Python 环境' })

  return new Promise((resolve) => {
    const child = spawn(pythonCmd, ['-m', 'pip', 'list', '--format=json'], {
      windowsHide: true,
      timeout: 10000,
    })
    let out = ''
    child.stdout.on('data', d => { out += d.toString() })
    child.on('close', (code) => {
      if (code !== 0) {
        resolve(toolJson({ ok: false, tool: 'python_packages', error: 'pip list 失败' }))
        return
      }
      try {
        const pkgs = JSON.parse(out)
        const important = pkgs.filter(p =>
          /numpy|pandas|matplotlib|scipy|scikit|requests|beautifulsoup|openpyxl|xlrd|pillow|seaborn|plotly|networkx|sympy/i.test(p.name)
        )
        resolve(toolJson({
          ok: true,
          tool: 'python_packages',
          total: pkgs.length,
          key_packages: important.map(p => ({ name: p.name, version: p.version })),
          all_packages: pkgs.map(p => p.name),
        }))
      } catch {
        resolve(toolJson({ ok: true, tool: 'python_packages', raw: out.slice(0, 4000) }))
      }
    })
    child.on('error', (err) => {
      resolve(toolJson({ ok: false, tool: 'python_packages', error: err.message }))
    })
  })
}
