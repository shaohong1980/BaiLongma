// documents.js —— 文档读取工具（零依赖）
//
// 多模态文档方向（①）：用纯 JS 直接处理最常见文档——文本格式（txt/md/json/log）直读、
// CSV 解析为表格预览、JSON 校验；二进制办公格式（pdf/docx/xlsx/pptx）检测后引导到
// 对应技能包（避免引入重型原生库）。后续若需深度解析可加库并扩展此工具。
import fs from 'fs'
import path from 'path'
import { SANDBOX_ROOT, assertInSandbox, normalizeSandboxPath } from '../sandbox.js'
import { throwIfAborted } from '../abort-utils.js'

const TEXT_EXTS = new Set(['.txt', '.md', '.markdown', '.json', '.csv', '.log', '.js', '.py', '.html', '.css', '.yaml', '.yml', '.xml', '.ini', '.conf'])
const BINARY_DOC_EXTS = { '.pdf': 'PDF', '.docx': 'Word', '.xlsx': 'Excel', '.pptx': 'PowerPoint' }

function toolJson(payload) {
  return JSON.stringify(payload, null, 2)
}

function parseCsvPreview(content) {
  const lines = content.split(/\r?\n/).filter(l => l.trim())
  if (!lines.length) return { rows: 0, columns: 0, headers: [], preview: '' }
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''))
  const rows = lines.length - 1
  return { rows, columns: headers.length, headers, preview: lines.slice(0, 6).join('\n') }
}

export async function execReadDocument(args = {}, context = {}) {
  throwIfAborted(context.signal)
  const rawPath = args.path || args.file
  if (!rawPath) return toolJson({ ok: false, tool: 'read_document', error: '缺少 path（支持 txt/md/json/csv/log 及代码文件）' })
  const filePath = normalizeSandboxPath(rawPath)
  const resolved = path.resolve(SANDBOX_ROOT, filePath)
  assertInSandbox(resolved)
  if (!fs.existsSync(resolved)) return toolJson({ ok: false, tool: 'read_document', error: '文件不存在', path: filePath })

  const stat = fs.statSync(resolved)
  if (!stat.isFile()) return toolJson({ ok: false, tool: 'read_document', error: '目标不是文件', path: filePath })

  const ext = path.extname(resolved).toLowerCase()
  const maxBytes = Math.min(Number(args.max_bytes) || 200000, 500000)
  if (stat.size > maxBytes) {
    return toolJson({ ok: false, tool: 'read_document', error: `文件过大（${stat.size} bytes，上限 ${maxBytes}）`, path: filePath, hint: '用 read_file 分段读取，或用 exec_command 处理' })
  }

  // 二进制办公格式：检测后引导（不引入重型原生库）
  if (BINARY_DOC_EXTS[ext]) {
    return toolJson({
      ok: false,
      tool: 'read_document',
      error: `${BINARY_DOC_EXTS[ext]} 是二进制格式，read_document 不支持直接提取文本`,
      hint: '如需处理该文档：①参考 docx/pdf/pptx/xlsx 技能包；②或让用户先另存为 txt/md 再读',
      path: filePath,
      size: stat.size,
      format: BINARY_DOC_EXTS[ext],
    })
  }

  if (!TEXT_EXTS.has(ext) && !args.force) {
    return toolJson({ ok: false, tool: 'read_document', error: `不支持的格式 .${ext}`, hint: '支持 txt/md/json/csv/log 及常见代码/配置文本；二进制办公文档走对应技能', path: filePath })
  }

  let content
  try {
    content = fs.readFileSync(resolved, 'utf-8')
  } catch (err) {
    return toolJson({ ok: false, tool: 'read_document', error: `读取失败：${err.message}`, path: filePath })
  }

  if (ext === '.csv') {
    const { rows, columns, headers, preview } = parseCsvPreview(content)
    return toolJson({ ok: true, tool: 'read_document', path: filePath, format: 'csv', rows, columns, headers, preview })
  }
  if (ext === '.json') {
    let valid = false
    try { JSON.parse(content); valid = true } catch (e) { console.warn('[src/capabilities/tools/documents.js] op failed:', e?.message || e) }
    return toolJson({ ok: true, tool: 'read_document', path: filePath, format: 'json', valid, size: stat.size, chars: content.length, content: content.slice(0, Number(args.max_chars) || 30000) })
  }
  return toolJson({
    ok: true,
    tool: 'read_document',
    path: filePath,
    format: ext.slice(1) || 'text',
    size: stat.size,
    chars: content.length,
    content: content.slice(0, Number(args.max_chars) || 30000),
  })
}
