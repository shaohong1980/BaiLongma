// run-tests.mjs —— 统一测试运行器
//
// 自动发现 src/test-*.js / scripts/smoke-*.mjs，逐个运行并汇总结果。
// 运行器智能选择：
//   - 源码直接/间接依赖 better-sqlite3 等原生模块（Electron ABI）→ ELECTRON_RUN_AS_NODE=1 electron
//   - 纯逻辑测试 → node（更快）
// 用法：
//   node scripts/run-tests.mjs                 # 跑全部
//   node scripts/run-tests.mjs src/test-a2a-client.js   # 跑指定文件
//   node scripts/run-tests.mjs --node src/test-*.js     # 全部强制 node
//   node scripts/run-tests.mjs --electron ...           # 全部强制 electron
import { readdirSync, readFileSync, statSync } from 'fs'
import { spawn } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const ELECTRON_CMD = process.platform === 'win32'
  ? path.join(ROOT, 'node_modules', '.bin', 'electron.cmd')
  : path.join(ROOT, 'node_modules', '.bin', 'electron')

// 需要 Electron ABI 的关键依赖（better-sqlite3 等原生模块在普通 node 下 ABI 不匹配）
const NATIVE_IMPORT_RE = /better-sqlite3|sherpa-onnx-node|@huggingface\/transformers/i
// import db.js / db/ 的测试会拉起 better-sqlite3（含动态 import() 形式）
const DB_IMPORT_RE = /['"][^'"]*\/db(?:\/[^'"]*|\.js[^'"]*)?['"]/i

function needsElectron(file, src) {
  if (NATIVE_IMPORT_RE.test(src)) return true
  if (DB_IMPORT_RE.test(src)) return true
  return false
}

function walkTestFiles(dir, out = []) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      walkTestFiles(full, out)
    } else if (/^test-.*\.js$/.test(e.name) && !full.includes('/ui/')) {
      out.push(full)
    } else if (/^smoke-.*\.mjs$/.test(e.name)) {
      out.push(full)
    }
  }
  return out
}

function runOne(file, { forceRunner = null, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    let src = ''
    try { src = readFileSync(file, 'utf-8') } catch {}
    const useElectron = forceRunner === 'electron' || (forceRunner !== 'node' && needsElectron(file, src))
    const cmd = useElectron ? ELECTRON_CMD : process.execPath
    const env = useElectron ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env
    const child = spawn(cmd, [file], { env, shell: useElectron, windowsHide: true })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => { try { child.kill() } catch {} }, timeoutMs)
    child.stdout?.on('data', d => { stdout += d; if (stdout.length > 8000) stdout = stdout.slice(-8000) })
    child.stderr?.on('data', d => { stderr += d; if (stderr.length > 4000) stderr = stderr.slice(-4000) })
    child.on('close', (code) => {
      clearTimeout(timer)
      const tail = (stdout.trim().split('\n').slice(-6).join('\n') + (stderr.trim() ? '\n[stderr] ' + stderr.trim().split('\n').slice(-3).join('\n') : '')).trim()
      resolve({ file, useElectron, code, tail })
    })
    child.on('error', (err) => { clearTimeout(timer); resolve({ file, useElectron, code: -1, tail: 'spawn error: ' + err.message }) })
  })
}

const args = process.argv.slice(2)
const forceRunner = args.includes('--node') ? 'node' : (args.includes('--electron') ? 'electron' : null)
const explicit = args.filter(a => !a.startsWith('--'))

let files
if (explicit.length) {
  files = explicit.map(f => path.resolve(ROOT, f)).filter(f => statSync(f).isFile())
} else {
  files = walkTestFiles(path.join(ROOT, 'src'))
}

if (!files.length) { console.log('没有找到测试文件'); process.exit(1) }

console.log(`运行 ${files.length} 个测试文件（${forceRunner ? `强制 ${forceRunner}` : '自动选择运行器'}）...\n`)
let pass = 0, fail = 0
const failures = []

for (let i = 0; i < files.length; i++) {
  const rel = path.relative(ROOT, files[i]).replace(/\\/g, '/')
  const t0 = Date.now()
  const r = await runOne(files[i], { forceRunner })
  const ms = Date.now() - t0
  const tag = r.useElectron ? 'electron' : 'node'
  if (r.code === 0) {
    pass++
    console.log(`PASS [${tag}] ${rel} (${ms}ms)`)
  } else {
    fail++
    failures.push({ rel, tag, tail: r.tail })
    console.log(`FAIL [${tag}] ${rel} (${ms}ms)`)
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
if (failures.length) {
  console.log('\n失败详情：')
  for (const f of failures) {
    console.log(`\n=== ${f.rel} [${f.tag}] ===`)
    console.log(f.tail)
  }
}
process.exit(fail === 0 ? 0 : 1)
