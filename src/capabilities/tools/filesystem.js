import fs from 'fs'
import path from 'path'
import { throwIfAborted } from '../abort-utils.js'
import { SANDBOX_ROOT, assertInSandbox, isPathInside, normalizeSandboxPath } from '../sandbox.js'
import { guardFilePath, DEFAULT_FILE_GUARD } from '../security-guards.js'
import { config } from '../../config.js'
import { streamWriteFileExecutionPreview } from '../../write-file-preview.js'

const PROTECTED_FILES = new Set(['readme.txt', 'world.txt', 'package.json'])

// QwenPaw FileGuard 移植：文件读写前先过敏感路径策略。
// 沙箱内只拦「系统级凭证文件」（私钥/SSH/SAM/浏览器凭证），避免误伤沙箱项目里的 .env 开发文件；
// 沙箱外（fileSandbox 关闭时可绕过的路径）命中的敏感路径一律拦。
function assertFileNotGuarded(resolved) {
  const mode = config.security?.fileGuard ?? DEFAULT_FILE_GUARD
  if (mode === 'off') return
  const result = guardFilePath(resolved, { mode })
  if (!result.blocked) return
  const inSandbox = isPathInside(SANDBOX_ROOT, resolved)
  const systemCredential = /\.(pem|key|pfx|p12|keyring|keychain)$/i.test(resolved)
    || /(^|[\\/])\.ssh([\\/]|$)/i.test(resolved)
    || /(^|[\\/])SAM$|(^|[\\/])NTUSER\.DAT$/i.test(resolved)
    || /(Login Data|Cookies|Web Data)/i.test(resolved)
    || /(^|[\\/])\.aws([\\/])/.test(resolved)
  if (!inSandbox || systemCredential) {
    throw new Error(`访问被拒绝（FileGuard）：${result.reasons.join('; ')}`)
  }
}

function toolJson(payload) {
  return JSON.stringify(payload, null, 2)
}
export async function execReadFile(args, context = {}) {
  throwIfAborted(context.signal)
  const rawPath = args.path || args.filename || args.file_path
  if (!rawPath) return '错误：未提供文件路径'
  const filePath = normalizeSandboxPath(rawPath)
  const resolved = path.resolve(SANDBOX_ROOT, filePath)
  assertInSandbox(resolved)
  assertFileNotGuarded(resolved)
  const content = fs.readFileSync(resolved, 'utf-8')
  const hasRange = args.start_line !== undefined || args.end_line !== undefined || args.max_lines !== undefined
  if (!hasRange) return content

  const lines = content.split(/\r?\n/)
  const start = Math.max(1, parseInt(args.start_line ?? 1, 10) || 1)
  const maxLines = args.max_lines !== undefined
    ? Math.max(0, parseInt(args.max_lines, 10) || 0)
    : null
  const requestedEnd = args.end_line !== undefined
    ? Math.max(start, parseInt(args.end_line, 10) || start)
    : null
  const end = maxLines !== null
    ? Math.min(lines.length, start + maxLines - 1)
    : Math.min(lines.length, requestedEnd ?? lines.length)
  const selected = maxLines === 0 ? [] : lines.slice(start - 1, end)
  return toolJson({
    ok: true,
    tool: 'read_file',
    path: filePath,
    absolute_path: resolved,
    start_line: start,
    end_line: end,
    total_lines: lines.length,
    truncated: end < lines.length || start > 1,
    content: selected.join('\n'),
  })
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '?'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export async function execListDir(args, context = {}) {
  throwIfAborted(context.signal)
  const rawPath = args.path || args.dir || args.directory || '.'
  const dirPath = normalizeSandboxPath(rawPath)
  const resolved = path.resolve(SANDBOX_ROOT, dirPath)
  assertInSandbox(resolved)
  assertFileNotGuarded(resolved)
  const entries = fs.readdirSync(resolved, { withFileTypes: true })
  const result = entries.map(e => {
    const type = e.isDirectory() ? '[目录]' : '[文件]'
    let extra = ''
    if (e.isFile()) {
      try { extra = ` (${formatBytes(fs.statSync(path.join(resolved, e.name)).size)})` } catch { /* 忽略单个文件 stat 失败 */ }
    }
    return `${type} ${e.name}${extra}`
  }).join('\n')
  const relDisplay = dirPath === '.' ? '.' : dirPath.replace(/\\/g, '/')
  return `目录（相对路径）：${relDisplay}\n\n${result || '（空目录）'}`
}

export async function execWriteFile(args, context = {}) {
  throwIfAborted(context.signal)
  const rawPath = args.path || args.filename || args.file_path
  const content = args.content ?? args.text ?? args.data
  if (!rawPath) return '错误：未提供文件路径'
  if (content === undefined) return '错误：未提供写入内容'
  const filePath = normalizeSandboxPath(rawPath)
  if (PROTECTED_FILES.has(path.basename(filePath).toLowerCase())) {
    return `错误：${path.basename(filePath)} 是系统文件，不可修改`
  }
  const resolved = path.resolve(SANDBOX_ROOT, filePath)
  assertInSandbox(resolved)
  assertFileNotGuarded(resolved)
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  streamWriteFileExecutionPreview({ path: filePath, content })
  fs.writeFileSync(resolved, content, 'utf-8')
  const verifiedContent = fs.readFileSync(resolved, 'utf-8')
  const verified = verifiedContent === String(content)
  const bytes = Buffer.byteLength(verifiedContent, 'utf-8')
  streamWriteFileExecutionPreview({ path: filePath, content, bytes, verified })
  if (!verified) {
    return toolJson({
      ok: false,
      tool: 'write_file',
      path: filePath,
      absolute_path: resolved,
      bytes,
      verified: false,
      error: 'read-back verification did not match written content',
    })
  }
  return toolJson({
    ok: true,
    tool: 'write_file',
    path: filePath,
    absolute_path: resolved,
    bytes,
    verified: true,
    content_preview: verifiedContent.slice(0, 120),
  })
}

export async function execDeleteFile(args, context = {}) {
  throwIfAborted(context.signal)
  const rawPath = args.path || args.filename || args.file_path
  if (!rawPath) return '错误：未提供路径'
  const filePath = normalizeSandboxPath(rawPath)
  if (PROTECTED_FILES.has(path.basename(filePath).toLowerCase())) {
    return `错误：${path.basename(filePath)} 是系统文件，不可删除`
  }
  const resolved = path.resolve(SANDBOX_ROOT, filePath)
  assertInSandbox(resolved)
  assertFileNotGuarded(resolved)
  if (!fs.existsSync(resolved)) return `错误：路径不存在：${filePath}`
  const stat = fs.statSync(resolved)
  if (stat.isDirectory()) {
    fs.rmSync(resolved, { recursive: true, force: true })
    const verifiedAbsent = !fs.existsSync(resolved)
    return toolJson({
      ok: verifiedAbsent,
      tool: 'delete_file',
      path: filePath,
      kind: 'directory',
      verified_absent: verifiedAbsent,
    })
  } else {
    fs.unlinkSync(resolved)
    const verifiedAbsent = !fs.existsSync(resolved)
    return toolJson({
      ok: verifiedAbsent,
      tool: 'delete_file',
      path: filePath,
      kind: 'file',
      verified_absent: verifiedAbsent,
    })
  }
}

export async function execMakeDir(args, context = {}) {
  throwIfAborted(context.signal)
  const rawPath = args.path || args.dir || args.directory
  if (!rawPath) return '错误：未提供目录路径'
  const dirPath = normalizeSandboxPath(rawPath)
  const resolved = path.resolve(SANDBOX_ROOT, dirPath)
  assertInSandbox(resolved)
  assertFileNotGuarded(resolved)
  fs.mkdirSync(resolved, { recursive: true })
  const verified = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
  return toolJson({
    ok: verified,
    tool: 'make_dir',
    path: dirPath,
    absolute_path: resolved,
    verified,
  })
}

function copyRecursive(src, dest) {
  const st = fs.statSync(src)
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true })
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry))
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(src, dest)
  }
}

export async function execRenameFile(args, context = {}) {
  throwIfAborted(context.signal)
  const rawPath = args.path || args.from || args.source
  const newName = args.new_name || args.newName || args.new_path || args.dest || args.to
  if (!rawPath) return '错误：未提供源路径'
  if (!newName) return '错误：未提供新名称或新路径'
  const srcPath = normalizeSandboxPath(rawPath)
  const srcResolved = path.resolve(SANDBOX_ROOT, srcPath)
  assertInSandbox(srcResolved)
  assertFileNotGuarded(srcResolved)
  if (!fs.existsSync(srcResolved)) return `错误：源路径不存在：${srcPath}`

  const destRaw = args.new_path || args.newPath || args.dest || args.to || newName
  const bareName = !String(destRaw).includes('/') && !String(destRaw).includes('\\')
  const destResolved = bareName
    ? path.join(path.dirname(srcResolved), String(destRaw))
    : path.resolve(SANDBOX_ROOT, normalizeSandboxPath(destRaw))
  assertInSandbox(destResolved)
  assertFileNotGuarded(destResolved)
  if (fs.existsSync(destResolved)) return `错误：目标已存在：${path.relative(SANDBOX_ROOT, destResolved) || destResolved}`

  fs.renameSync(srcResolved, destResolved)
  const verified = fs.existsSync(destResolved) && !fs.existsSync(srcResolved)
  return toolJson({
    ok: verified,
    tool: 'rename_file',
    from: srcPath.replace(/\\/g, '/'),
    to: path.relative(SANDBOX_ROOT, destResolved).replace(/\\/g, '/') || String(destRaw),
    verified,
  })
}

export async function execCopyFile(args, context = {}) {
  throwIfAborted(context.signal)
  const rawPath = args.path || args.from || args.source
  const destRaw = args.dest || args.to || args.destination
  if (!rawPath) return '错误：未提供源路径'
  if (!destRaw) return '错误：未提供目标路径'
  const srcPath = normalizeSandboxPath(rawPath)
  const srcResolved = path.resolve(SANDBOX_ROOT, srcPath)
  assertInSandbox(srcResolved)
  assertFileNotGuarded(srcResolved)
  if (!fs.existsSync(srcResolved)) return `错误：源路径不存在：${srcPath}`
  if (PROTECTED_FILES.has(path.basename(srcResolved).toLowerCase())) {
    return `错误：${path.basename(srcResolved)} 是系统文件，不可复制`
  }
  const destNorm = normalizeSandboxPath(destRaw)
  let destResolved = path.resolve(SANDBOX_ROOT, destNorm)
  // dest 若是目录，则复制到该目录下并保留原文件名
  if (fs.existsSync(destResolved) && fs.statSync(destResolved).isDirectory()) {
    destResolved = path.join(destResolved, path.basename(srcResolved))
  }
  assertInSandbox(destResolved)
  assertFileNotGuarded(destResolved)
  if (fs.existsSync(destResolved)) return `错误：目标已存在：${path.relative(SANDBOX_ROOT, destResolved) || destResolved}`
  if (isPathInside(destResolved, srcResolved)) return '错误：不能复制到自身或其子目录内'

  copyRecursive(srcResolved, destResolved)
  const verified = fs.existsSync(destResolved)
  return toolJson({
    ok: verified,
    tool: 'copy_file',
    from: srcPath.replace(/\\/g, '/'),
    to: path.relative(SANDBOX_ROOT, destResolved).replace(/\\/g, '/') || String(destRaw),
    kind: fs.statSync(srcResolved).isDirectory() ? 'directory' : 'file',
    verified,
  })
}

export async function execMoveFile(args, context = {}) {
  throwIfAborted(context.signal)
  const rawPath = args.path || args.from || args.source
  const destRaw = args.dest || args.to || args.destination
  if (!rawPath) return '错误：未提供源路径'
  if (!destRaw) return '错误：未提供目标路径'
  const srcPath = normalizeSandboxPath(rawPath)
  const srcResolved = path.resolve(SANDBOX_ROOT, srcPath)
  assertInSandbox(srcResolved)
  assertFileNotGuarded(srcResolved)
  if (!fs.existsSync(srcResolved)) return `错误：源路径不存在：${srcPath}`
  const destNorm = normalizeSandboxPath(destRaw)
  let destResolved = path.resolve(SANDBOX_ROOT, destNorm)
  if (fs.existsSync(destResolved) && fs.statSync(destResolved).isDirectory()) {
    destResolved = path.join(destResolved, path.basename(srcResolved))
  }
  assertInSandbox(destResolved)
  assertFileNotGuarded(destResolved)
  if (fs.existsSync(destResolved)) return `错误：目标已存在：${path.relative(SANDBOX_ROOT, destResolved) || destResolved}`
  if (isPathInside(destResolved, srcResolved)) return '错误：不能移动到自身或其子目录内'

  try {
    fs.renameSync(srcResolved, destResolved)
  } catch (err) {
    // 跨盘/跨卷：回退为复制+删除
    if (err && (err.code === 'EXDEV' || err.code === 'EPERM')) {
      copyRecursive(srcResolved, destResolved)
      fs.rmSync(srcResolved, { recursive: true, force: true })
    } else {
      throw err
    }
  }
  const verified = fs.existsSync(destResolved) && !fs.existsSync(srcResolved)
  return toolJson({
    ok: verified,
    tool: 'move_file',
    from: srcPath.replace(/\\/g, '/'),
    to: path.relative(SANDBOX_ROOT, destResolved).replace(/\\/g, '/') || String(destRaw),
    verified,
  })
}

function globToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

function walkFind(dir, re, results, maxResults) {
  if (results.length >= maxResults) return
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (results.length >= maxResults) return
    if (re.test(e.name)) {
      const rel = path.relative(SANDBOX_ROOT, path.join(dir, e.name)).replace(/\\/g, '/')
      results.push(`${e.isDirectory() ? '[目录]' : '[文件]'} ${rel}`)
    }
    if (e.isDirectory()) walkFind(path.join(dir, e.name), re, results, maxResults)
  }
}

export async function execFindFile(args, context = {}) {
  throwIfAborted(context.signal)
  const rawPath = args.path || args.dir || args.directory || '.'
  const pattern = args.pattern || args.name || args.query
  if (!pattern) return '错误：未提供搜索模式（pattern）'
  const dirPath = normalizeSandboxPath(rawPath)
  const resolved = path.resolve(SANDBOX_ROOT, dirPath)
  assertInSandbox(resolved)
  assertFileNotGuarded(resolved)
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return `错误：目录不存在：${dirPath}`
  }
  const maxResults = Math.max(1, parseInt(args.max_results, 10) || 50)
  const re = globToRegExp(pattern)
  const results = []
  walkFind(resolved, re, results, maxResults)
  const relDisplay = dirPath === '.' ? '.' : dirPath.replace(/\\/g, '/')
  if (!results.length) return `未找到匹配「${pattern}」的文件（目录：${relDisplay}）`
  return `匹配「${pattern}」（目录：${relDisplay}，最多 ${maxResults} 条）：\n\n${results.join('\n')}`
}
