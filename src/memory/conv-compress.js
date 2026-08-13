// conv-compress.js —— 主线会话窗口外历史压缩（参考 hermes context_compressor 的 compaction）
//
// 问题：注入器每轮只把「最近 N 条对话」放进上下文（用户对话 20 条 / TICK 40 条），
// 超过的部分直接丢弃——长会话里更早的对话对模型彻底不可见，连续性断裂。
//
// 做法：拉一个更大的窗口（最近 60 条），把「最新 N 条之外」的旧部分压成 1-2 句主线摘要，
// 随上下文注入（<mainline-history-summary>），窗口内新消息照常展示。
//
// 设计约束：
//  - 只在该 sender 的「窗口外内容足够多」时才触发（默认 ≥6 条且 ≥500 字符）；
//    绝大多数短会话零开销。
//  - 侧车缓存 data/conv-compression.json，键 = sender + era（最旧行 id）；era 不变就不重压，
//    新消息推着窗口滚动、era 变化时才生成新摘要。
//  - 压缩在热路径内联执行但有 6s 超时 + 失败缓存（1h 内不重试），绝不阻塞主对话。
//  - 永不 throw。

import fs from 'fs'
import path from 'path'
import { paths } from '../paths.js'

const CACHE_FILE = path.join(paths.dataDir, 'conv-compression.json')
const WINDOW_ROWS = 20          // 与 injector 的主窗口一致
const MAX_FETCH_ROWS = 60       // 拉取的更大窗口，用于取溢出部分
const MIN_OVERFLOW_ROWS = 6     // 溢出至少几条才值得压
const MIN_OVERFLOW_CHARS = 500  // 溢出至少多少字符才值得压
const MAX_SUMMARY_TOKENS = 120
const LLM_TIMEOUT_MS = 6000     // 热路径压缩的硬超时
const RETRY_AFTER_MS = 60 * 60 * 1000   // 失败/空摘要 1h 内不重试
const MAX_CACHE_KEYS = 64       // 侧车缓存上限（防止无限膨胀）
const MAX_LINE_CHARS = 220

export const COMPRESSION_PROMPT = `You are the conversation-window compressor. A long conversation with one person exceeds the context window: the newest messages are already visible to the agent, and the OLDER portion below is about to be dropped. Compress ONLY that older portion into 1-2 sentences that preserve what the agent needs to continue the conversation:
- Who this person is and what history/relationship you share.
- What was discussed, decided, or done; what the person cares about; any open threads or commitments.
- What concrete facts or artifacts were established.
Do NOT restate or paraphrase the newest messages. Do NOT use bullet points. Speak in first person ("我" is you, the assistant). Write in Chinese. Output only the summary, no prefix.`

// —— pure data helpers（可单测，不碰 db/llm）——

export function buildMainlineCompressionInput(overflowRows = [], newestRows = []) {
  const lines = []
  if (overflowRows.length) {
    lines.push('[Older portion to compress — before the shown window]')
    for (const c of overflowRows) {
      const from = String(c.from_id || c.from || c.sender || '?').replace(/^ID:/i, '')
      const content = String(c.content || c.message || '').replace(/\s+/g, ' ').slice(0, MAX_LINE_CHARS)
      if (!content) continue
      lines.push(`- ${from}: ${content}`)
    }
  }
  if (newestRows.length) {
    lines.push('', '[Newest messages already visible to the agent (continuity anchor — do NOT repeat these in the summary)]')
    for (const c of newestRows.slice(-6)) {
      const from = String(c.from_id || c.from || c.sender || '?').replace(/^ID:/i, '')
      const content = String(c.content || c.message || '').replace(/\s+/g, ' ').slice(0, MAX_LINE_CHARS)
      if (!content) continue
      lines.push(`- ${from}: ${content}`)
    }
  }
  return lines.join('\n')
}

export function needsCompression(rows, { windowRows = WINDOW_ROWS } = {}) {
  if (!Array.isArray(rows) || rows.length <= windowRows) return false
  const overflow = rows.slice(0, rows.length - windowRows)
  const chars = overflow.reduce((n, c) => n + String(c.content || c.message || '').length, 0)
  return overflow.length >= MIN_OVERFLOW_ROWS && chars >= MIN_OVERFLOW_CHARS
}

function cleanSummary(content) {
  if (!content) return ''
  let s = String(content)
  s = s.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
  s = s.replace(/^<mainline-history-summary>\s*/, '').replace(/\s*<\/mainline-history-summary>\s*$/, '')
  s = s.trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith('「') && s.endsWith('」'))) s = s.slice(1, -1).trim()
  return s
}

// —— 侧车缓存 ——

function readCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return {}
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'))
    return (parsed && typeof parsed === 'object') ? parsed : {}
  } catch {
    return {}
  }
}

function writeCache(cache) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true })
    const keys = Object.keys(cache)
    if (keys.length > MAX_CACHE_KEYS) {
      const sorted = keys
        .map(k => [k, cache[k]?.generatedAt || 0])
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_CACHE_KEYS)
      const pruned = {}
      for (const [k] of sorted) pruned[k] = cache[k]
      cache = pruned
    }
    const tmp = `${CACHE_FILE}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf-8')
    fs.renameSync(tmp, CACHE_FILE)
  } catch { /* best-effort */ }
}

function eraKey(senderId, rows) {
  return `${senderId || 'timeline'}:${rows?.[0]?.id ?? 'none'}`
}

// —— 主入口：拉大窗口 → 需要才压 → 缓存 → 返回摘要 ——
// callLLM：兼容 focus-compress 的用法（{ systemPrompt, message, temperature, thinking, tools, maxTokens, mustReply }）。
export async function getMainlineSummary({ senderId = null, maxRows = MAX_FETCH_ROWS, windowRows = WINDOW_ROWS, callLLM = null } = {}) {
  try {
    const { getRecentConversation, getRecentConversationTimeline } = await import('../db.js')
    let rows = []
    try {
      rows = senderId
        ? getRecentConversation(senderId, maxRows, 24)
        : getRecentConversationTimeline(maxRows, 24 * 7)
    } catch {
      return { summary: '', overflowCount: 0 }
    }
    if (!needsCompression(rows, { windowRows })) {
      return { summary: '', overflowCount: 0 }
    }

    const overflow = rows.slice(0, rows.length - windowRows)
    const newest = rows.slice(-windowRows)
    const key = eraKey(senderId, rows)
    const cache = readCache()
    const entry = cache[key]
    const now = Date.now()

    if (entry) {
      if (entry.summary) return { summary: entry.summary, overflowCount: overflow.length }
      if (now - (entry.generatedAt || 0) < RETRY_AFTER_MS) {
        return { summary: '', overflowCount: overflow.length }  // 上次失败，短期节流
      }
    }

    if (!callLLM) return { summary: '', overflowCount: overflow.length }

    let summary = ''
    const input = buildMainlineCompressionInput(overflow, newest)
    try {
      summary = await Promise.race([
        (async () => {
          const r = await callLLM({
            systemPrompt: COMPRESSION_PROMPT,
            message: input,
            temperature: 0.2,
            thinking: false,
            tools: [],
            maxTokens: MAX_SUMMARY_TOKENS,
            mustReply: false,
          })
          return cleanSummary(r?.content || '')
        })(),
        new Promise(resolve => setTimeout(() => resolve(''), LLM_TIMEOUT_MS)),
      ])
    } catch (err) {
      console.warn('[conv-compress] callLLM failed:', err?.message || err)
    }

    cache[key] = { summary, generatedAt: now }
    writeCache(cache)
    return { summary, overflowCount: overflow.length }
  } catch {
    return { summary: '', overflowCount: 0 }
  }
}

// 摘要进 prompt 的格式化（供 index.js 塞进 extraContext）
export function formatMainlineSummary(summary) {
  if (!summary) return ''
  return `<mainline-history-summary>\n${summary}\n</mainline-history-summary>`
}

