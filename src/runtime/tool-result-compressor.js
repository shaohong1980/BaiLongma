// tool-result-compressor.js —— 工具结果压缩（TokenJuice 思路，参考 hermes-agent context_compressor）
//
// 目标：大段「信息型/只读」工具输出在进入模型上下文之前，先压成一行信息量足够的摘要，
// 全文写入 data/tool-outputs/<id>.txt 并把路径交给模型——需要细节时用 read_file 按需取回。
// 这样既保住正确性（细节不丢），又显著省 token（OpenHuman TokenJuice 声称同类工具输出可省 80%）。
//
// 原则：
//  - 只压缩白名单里的「只读/信息型」工具，绝不压缩有副作用的工具（send_message / write_file / 安装等）。
//  - 只压缩超过阈值的超大结果；小结果原样放行，避免摘要本身引入噪声。
//  - 摘要永远带"全文在哪"的路径，模型可以按需读回；摘要行本身就是可执行信息（exit code、行数、命中数）。
//  - 永不 throw：任何解析失败都回退到原结果，压缩环节绝不能拖垮工具循环。

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { compressLongText } from './text-compressor.js'
import { getTextCompressionConfig } from '../config.js'

// 超过该字符数的结果才考虑压缩（低于阈值直接放行）
export const COMPRESS_AFTER_CHARS = 6000
// 压缩时写入 data/tool-outputs 的文件体上限（超出截断并标注，防止无限吃磁盘）
export const MAX_SAVED_CHARS = 100000
// 工具输出文件保留时长
export const TOOL_OUTPUT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

function safeStr(v) {
  return typeof v === 'string' ? v : (v == null ? '' : String(v))
}

function shortStr(v, max = 80) {
  const s = safeStr(v).replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max - 3)}...` : s
}

// 从工具结果文本里抓 JSON 顶层字段（容错：结果可能是 JSON、纯文本、或 XML）。
function extractJson(raw) {
  const text = safeStr(raw)
  if (text.startsWith('{')) {
    try { return JSON.parse(text) } catch { /* fallthrough */ }
  }
  const m = text.match(/\{[\s\S]*\}/)
  if (m) {
    try { return JSON.parse(m[0]) } catch { /* fallthrough */ }
  }
  return null
}

function countLines(content) {
  const text = safeStr(content)
  return text ? text.split('\n').length : 0
}

// ── 核心：把一次工具调用 + 结果压成一行信息量足够的摘要（hermes `_summarize_tool_result` 的移植） ──
export function summarizeToolResult(name, args, content) {
  try {
    return summarizeToolResultUnsafe(name, args, content)
  } catch {
    const len = safeStr(content).length
    return `[${name}] (${len.toLocaleString()} chars result)`
  }
}

function summarizeToolResultUnsafe(name, rawArgs, content) {
  const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) ? rawArgs : {}
  const text = safeStr(content)
  const len = text.length
  const lines = countLines(text)
  const parsed = extractJson(text)
  const ok = parsed ? parsed.ok !== false : undefined
  const okFlag = ok === false ? ' failed' : ''

  switch (name) {
    case 'read_file': {
      const p = safeStr(args.path || args.file || '?')
      const from = args.start_line || args.offset || 1
      return `[read_file] read ${shortStr(p, 120)} from line ${from} (${len.toLocaleString()} chars)${okFlag}`
    }
    case 'list_dir': {
      const p = safeStr(args.path || '.')
      const items = Array.isArray(parsed?.items) ? parsed.items.length : (Array.isArray(parsed?.entries) ? parsed.entries.length : '?')
      return `[list_dir] ${shortStr(p, 120)} → ${items} entries${okFlag}`
    }
    case 'exec_command':
    case 'exec_quick_command':
    case 'exec_task_command':
    case 'exec_background_command': {
      const cmd = shortStr(args.command || args.cmd || '?', 90)
      const exit = parsed?.exit_code ?? parsed?.exitCode ?? '?'
      const outLines = safeStr(parsed?.stdout || parsed?.output || text).split('\n').filter(l => l.trim()).length
      return `[${name}] ran \`${cmd}\` → exit ${exit}, ~${outLines.toLocaleString()} lines${parsed?.timed_out ? ' (timed out)' : ''}${okFlag}`
    }
    case 'run_node_script': {
      const code = shortStr(args.code || '', 60).replace(/\n/g, ' ')
      const outLines = text.split('\n').filter(l => l.trim()).length
      return `[run_node_script] \`${code}\` → ${outLines.toLocaleString()} lines output${okFlag}`
    }
    case 'web_search': {
      const q = shortStr(args.query || args.q || args.keyword || '?', 80)
      const count = Array.isArray(parsed?.results) ? parsed.results.length : (Array.isArray(parsed?.items) ? parsed.items.length : '?')
      return `[web_search] query='${q}' → ${count} results${okFlag}`
    }
    case 'fetch_url':
    case 'browser_read': {
      const u = shortStr(args.url || '?', 100)
      const bodyPath = parsed?.body_path || parsed?.bodyPath || ''
      const bodyPart = bodyPath ? ` body_path=${shortStr(bodyPath, 120)}` : ''
      return `[${name}] ${u} (${len.toLocaleString()} chars)${bodyPart}${okFlag}`
    }
    case 'search_memory':
    case 'probe_memory': {
      const kw = shortStr(args.keyword || args.query || '?', 60)
      const hits = Array.isArray(parsed?.memories) ? parsed.memories.length : (Array.isArray(parsed?.hits) ? parsed.hits.length : '?')
      return `[${name}] '${kw}' → ${hits} memory hits${okFlag}`
    }
    case 'list_processes': {
      const n = Array.isArray(parsed?.processes) ? parsed.processes.length : '?'
      return `[list_processes] ${n} processes${okFlag}`
    }
    case 'list_tools': {
      return `[list_tools] (${len.toLocaleString()} chars)`
    }
    case 'recall_memory': {
      const n = Array.isArray(parsed?.memories) ? parsed.memories.length : '?'
      return `[recall_memory] ${n} memories recalled`
    }
    case 'search_memories':
    case 'searchMemories': {
      const n = Array.isArray(parsed?.memories) ? parsed.memories.length : '?'
      return `[${name}] ${n} memories`
    }
    default:
      // 通用回退：列前两个参数 + 字节数
      const firstArg = Object.entries(args).slice(0, 2).map(([k, v]) => `${k}=${shortStr(v, 40)}`).join(' ')
      let tail = `(${len.toLocaleString()} chars result)`
      // ② CJK 友好通用压缩：大结果附一段内容摘要，让模型拿到信息量而非只有字符数
      //   （OpenHuman 思路的本地化——摘要带"全文在哪"，这里更进一步把摘要本身变聪明）
      try {
        const tc = getTextCompressionConfig()
        if (tc.enabled && len > 800) {
          const preview = compressLongText(text, { maxChars: Math.min(Number(tc.maxChars) || 1200, 400) })
          if (preview && preview.length < len) tail += `; summary: ${preview}`
        }
      } catch { /* 绝不影响主流程 */ }
      return `[${name}]${firstArg ? ' ' + firstArg : ''} ${tail}`
  }
}

// 该工具是否适合压缩（只读/信息型白名单）
const COMPRESSIBLE_TOOLS = new Set([
  'read_file',
  'list_dir',
  'exec_command',
  'exec_quick_command',
  'exec_task_command',
  'exec_background_command',
  'run_node_script',
  'web_search',
  'fetch_url',
  'browser_read',
  'search_memory',
  'probe_memory',
  'recall_memory',
  'list_processes',
  'list_tools',
  'search_memories',
])

export function isToolCompressible(name) {
  return COMPRESSIBLE_TOOLS.has(name)
}

function ensureToolOutputDir(dataDir) {
  const dir = path.join(dataDir || path.resolve(process.cwd(), 'data'), 'tool-outputs')
  try { fs.mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
  return dir
}

// 计算一个稳定的输出文件 id：用工具名 + 参数哈希，同一调用重跑不会无限堆积文件。
function outputIdFor(name, args) {
  const argHash = crypto.createHash('sha1')
    .update(name + ':' + JSON.stringify(args || {}))
    .digest('hex')
    .slice(0, 12)
  return `${name.replace(/[^a-z0-9_-]/gi, '_')}-${argHash}`
}

// 压缩为模型输入用的工具结果字符串。
// 返回 { content }：小结果原样；大结果 → 摘要 + 全文路径（全文已写盘，模型可 read_file 读回）。
export function compressToolResultForModel(name, args, result, { dataDir = null, threshold = COMPRESS_AFTER_CHARS, enabled = true } = {}) {
  const raw = safeStr(result)
  if (!enabled || raw.length <= threshold || !isToolCompressible(name)) {
    return { content: raw }
  }
  try {
    const dir = ensureToolOutputDir(dataDir)
    const id = outputIdFor(name, args)
    const filePath = path.join(dir, `${id}.txt`)
    const savedBody = raw.length > MAX_SAVED_CHARS
      ? `${raw.slice(0, MAX_SAVED_CHARS)}\n\n[...truncated: original was ${raw.length.toLocaleString()} chars]`
      : raw
    try {
      fs.writeFileSync(filePath, savedBody, 'utf-8')
    } catch {
      return { content: raw }
    }
    const summary = summarizeToolResult(name, args, raw)
    return {
      content: `${summary}\n[full output (${raw.length.toLocaleString()} chars) saved to ${filePath}; read it with read_file if you need details beyond this summary]`,
      savedPath: filePath,
      summarized: true,
    }
  } catch {
    return { content: raw }
  }
}

// 惰性清理过期工具输出文件（在压缩点顺带触发，节流，绝不 throw）
let lastCleanupAt = 0
export function cleanupOldToolOutputs({ dataDir = null, force = false } = {}) {
  const now = Date.now()
  if (!force && now - lastCleanupAt < 6 * 60 * 60 * 1000) return
  lastCleanupAt = now
  try {
    const dir = path.join(dataDir || path.resolve(process.cwd(), 'data'), 'tool-outputs')
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry)
      try {
        const st = fs.statSync(full)
        if (st.isFile() && now - st.mtimeMs > TOOL_OUTPUT_MAX_AGE_MS) fs.unlinkSync(full)
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

