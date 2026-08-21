// preview.js —— 文件预览 API（AionUi Preview Panel 思路移植）
//
// 提供沙箱内文件的元信息 / 原始流 / 文本内容 / 目录列表，供 Brain UI 预览面板使用。
// 安全：路径必须落在 sandbox 内（isPathInside），且经过 FileGuard 敏感路径拦截。
// 零依赖：不引入 docx/xlsx/mammoth 等重型库——Office 二进制格式返回 previewable:false，
// 前端给出友好提示；PDF/图片/音视频直接以原生元素预览；文本/代码/Markdown/Diff 内联渲染。
import fs from 'fs'
import path from 'path'
import { SANDBOX_ROOT } from '../../capabilities/sandbox.js'
import { guardFilePath } from '../../capabilities/security-guards.js'
import { isPathInside, jsonResponse } from '../utils.js'

const PREVIEW_TEXT_MAX = 500 * 1024
const PREVIEW_TEXT_PREVIEW_CHARS = 120 * 1024
const LIST_MAX_DEPTH = 5
const LIST_MAX_ENTRIES = 300

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico', '.tif', '.tiff', '.avif'])
const TEXT_EXTS = new Set(['.txt', '.md', '.markdown', '.json', '.csv', '.log', '.yaml', '.yml', '.xml', '.ini', '.conf', '.toml', '.sql', '.env', '.gitignore', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.java', '.go', '.rs', '.c', '.cpp', '.h', '.hpp', '.css', '.sh', '.bash', '.ps1', '.bat'])
const HTML_EXTS = new Set(['.html', '.htm'])
const DIFF_EXTS = new Set(['.diff', '.patch'])
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac', '.opus'])
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.mkv', '.m4v'])
const OFFICE_EXTS = { '.pdf': 'PDF', '.docx': 'Word', '.doc': 'Word', '.xlsx': 'Excel', '.xls': 'Excel', '.pptx': 'PowerPoint', '.ppt': 'PowerPoint', '.odt': 'Word', '.ods': 'Excel', '.odp': 'PowerPoint' }
const MIME = {
  '.pdf': 'application/pdf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.avif': 'image/avif',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.aac': 'audio/aac', '.opus': 'audio/ogg',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.m4v': 'video/mp4',
}

// 解析预览路径：接受 sandbox 相对路径或 sandbox 内绝对路径；返回沙箱内绝对路径或 null。
function resolvePreviewPath(rawPath) {
  const raw = String(rawPath || '').trim()
  if (!raw) return null
  let candidate = raw
  if (!path.isAbsolute(candidate)) {
    candidate = path.resolve(SANDBOX_ROOT, candidate)
  }
  if (!isPathInside(SANDBOX_ROOT, candidate)) return null
  return candidate
}

function classifyPreview(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  const name = path.basename(filePath)
  if (IMAGE_EXTS.has(ext)) return { kind: 'image', format: ext.slice(1), previewable: true }
  if (ext === '.pdf') return { kind: 'pdf', format: 'pdf', previewable: true }
  if (HTML_EXTS.has(ext)) return { kind: 'html', format: 'html', previewable: true }
  if (DIFF_EXTS.has(ext)) return { kind: 'diff', format: 'diff', previewable: true }
  if (TEXT_EXTS.has(ext) || ext === '.md') return { kind: ext === '.md' || ext === '.markdown' ? 'markdown' : 'text', format: ext.slice(1) || 'text', previewable: true }
  if (AUDIO_EXTS.has(ext)) return { kind: 'audio', format: ext.slice(1), previewable: true }
  if (VIDEO_EXTS.has(ext)) return { kind: 'video', format: ext.slice(1), previewable: true }
  if (OFFICE_EXTS[ext]) return { kind: 'office', format: OFFICE_EXTS[ext], previewable: ext === '.pdf' }
  return { kind: 'other', format: ext.slice(1) || 'unknown', previewable: false }
}

function isSensitive(filePath) {
  const guard = guardFilePath(filePath)
  return guard.blocked
}

// jsonResponse 不返回值；路由处理完成后必须返回 true 表示已处理。
function respond(res, status, body) {
  jsonResponse(res, status, body)
  return true
}

export async function handlePreviewRoutes(req, res, url) {
  // GET /preview/meta?path=...
  if (req.method === 'GET' && url.pathname === '/preview/meta') {
    const p = resolvePreviewPath(url.searchParams.get('path'))
    if (!p) return respond(res, 400, { ok: false, error: 'invalid or unsafe path' })
    if (!fs.existsSync(p)) return respond(res, 404, { ok: false, error: 'not found' })
    const stat = fs.statSync(p)
    if (!stat.isFile()) return respond(res, 400, { ok: false, error: 'not a file' })
    const cls = classifyPreview(p)
    const sensitive = isSensitive(p)
    return respond(res, 200, {
      ok: true,
      name: path.basename(p),
      rel: path.relative(SANDBOX_ROOT, p).replace(/\\/g, '/'),
      ext: path.extname(p),
      size: stat.size,
      modified: stat.mtime?.toISOString?.() || null,
      ...cls,
      sensitive,
      text_previewable: cls.previewable && (cls.kind === 'text' || cls.kind === 'markdown' || cls.kind === 'diff' || cls.kind === 'html'),
    })
  }

  // GET /preview/raw?path=... （PDF/图片/音视频/HTML 用原生元素或 iframe）
  if (req.method === 'GET' && url.pathname === '/preview/raw') {
    const p = resolvePreviewPath(url.searchParams.get('path'))
    if (!p || isSensitive(p)) { res.writeHead(403); res.end('forbidden'); return true }
    if (!fs.existsSync(p)) { res.writeHead(404); res.end('not found'); return true }
    const cls = classifyPreview(p)
    const contentType = MIME[path.extname(p).toLowerCase()] || 'application/octet-stream'
    if (cls.kind === 'office' || !cls.previewable) { res.writeHead(415); res.end('not previewable'); return true }
    try {
      const stat = fs.statSync(p)
      res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': stat.size, 'Cache-Control': 'no-cache' })
      fs.createReadStream(p).pipe(res)
    } catch { res.writeHead(404); res.end('not found') }
    return true
  }

  // GET /preview/text?path=... （文本/代码/Markdown/Diff 内联渲染）
  if (req.method === 'GET' && url.pathname === '/preview/text') {
    const p = resolvePreviewPath(url.searchParams.get('path'))
    if (!p || isSensitive(p)) return respond(res, 403, { ok: false, error: 'forbidden' })
    if (!fs.existsSync(p)) return respond(res, 404, { ok: false, error: 'not found' })
    const stat = fs.statSync(p)
    if (!stat.isFile()) return respond(res, 400, { ok: false, error: 'not a file' })
    const cls = classifyPreview(p)
    if (!cls.previewable || cls.kind === 'pdf' || cls.kind === 'image' || cls.kind === 'audio' || cls.kind === 'video') {
      return respond(res, 415, { ok: false, error: 'not a text-previewable file' })
    }
    if (stat.size > PREVIEW_TEXT_MAX) {
      return respond(res, 413, { ok: false, error: 'file too large for inline text preview', size: stat.size, hint: '用 read_file 分段读取' })
    }
    let content = ''
    try {
      content = fs.readFileSync(p, 'utf-8')
    } catch {
      return respond(res, 422, { ok: false, error: 'cannot decode as UTF-8 text' })
    }
    const truncated = content.length > PREVIEW_TEXT_PREVIEW_CHARS
    if (truncated) content = content.slice(0, PREVIEW_TEXT_PREVIEW_CHARS)
    return respond(res, 200, {
      ok: true,
      name: path.basename(p),
      rel: path.relative(SANDBOX_ROOT, p).replace(/\\/g, '/'),
      kind: cls.kind,
      format: cls.format,
      size: stat.size,
      truncated,
      content,
    })
  }

  // GET /preview/list?depth=..&max=..
  if (req.method === 'GET' && url.pathname === '/preview/list') {
    const depth = Math.min(parseInt(url.searchParams.get('depth') || '3', 10) || 3, LIST_MAX_DEPTH)
    const max = Math.min(parseInt(url.searchParams.get('max') || '100', 10) || 100, LIST_MAX_ENTRIES)
    const out = []
    const walk = (dir, d) => {
      if (out.length >= max) return
      if (d > depth) return
      let entries = []
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      entries.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      for (const e of entries) {
        if (out.length >= max) return
        if (e.name === 'node_modules' || e.name === '.git' || e.name === '.cache') continue
        const full = path.join(dir, e.name)
        if (isSensitive(full)) continue
        if (e.isDirectory()) {
          out.push({ name: e.name, rel: path.relative(SANDBOX_ROOT, full).replace(/\\/g, '/'), type: 'dir' })
          walk(full, d + 1)
        } else if (e.isFile()) {
          const cls = classifyPreview(full)
          out.push({ name: e.name, rel: path.relative(SANDBOX_ROOT, full).replace(/\\/g, '/'), type: 'file', kind: cls.kind, format: cls.format, previewable: cls.previewable })
        }
      }
    }
    walk(SANDBOX_ROOT, 0)
    return respond(res, 200, { ok: true, root: SANDBOX_ROOT, count: out.length, entries: out })
  }

  return false
}

