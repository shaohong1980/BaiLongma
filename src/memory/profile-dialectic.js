// profile-dialectic.js —— 用户画像辩证更新（参考 hermes Honcho 的 dialectic）
//
// 识别器把用户偏好写成 fact_user_* 时，如果新事实与既有事实矛盾（"喜欢咖啡"→"戒咖啡了"），
// 不做静默覆盖，而是显式标记：
//   - 旧事实挂 superseded_by=<新 mem_id>，正文追加"已被更正"注记
//   - 新事实挂 corrects=<旧 mem_id>
// 这样画像既保留"她以前喜欢咖啡"的历史（说话时能体现了解），又让最新状态可查询。
//
// 启发式、保守：只在「主题高度重叠 + 语义肯定/否定冲突（或极高重叠改口）」时触发，
// 绝不因词面巧合误伤。所有写操作 best-effort，不阻塞主 upsert 流程。

import { searchMemories, getMemoryByMemId, upsertMemoryByMemId } from '../db.js'
import { extractKeywords } from './keywords.js'

const NEGATION_MARKERS = /(不|没|别再|不要|不再|戒|停|取消|讨厌|不喜欢|不能|不想|不要了|quit|stop|no longer|don'?t|cancel|hate|dislike|never|won'?t)/i
const POSITIVE_MARKERS = /(喜欢|爱|想要|愿意|prefer|like|love|want|enjoy)/i

function normalizeText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase()
}

// 主题相似度：共享关键词 / 较小关键词集（overlap coefficient）。
// 用 overlap 而不是 jaccard：中文事实是短文本，bigram jaccard 对"喜欢喝咖啡 vs 戒咖啡了"
// 这类同主题但措辞不同的句子会稀释到 0.14，而 overlap 能保留"咖啡/用户"这种核心重叠。
export function topicSimilarity(a, b) {
  const textA = normalizeText(`${a.title || ''} ${a.content || ''}`)
  const textB = normalizeText(`${b.title || ''} ${b.content || ''}`)
  if (!textA || !textB) return 0
  const ka = new Set(extractKeywords(textA, 12).map(k => String(k).toLowerCase()).filter(k => k && k.length >= 2))
  const kb = new Set(extractKeywords(textB, 12).map(k => String(k).toLowerCase()).filter(k => k && k.length >= 2))
  if (ka.size === 0 || kb.size === 0) return 0
  let shared = 0
  for (const k of ka) if (kb.has(k)) shared++
  return shared / Math.min(ka.size, kb.size)
}

function hasNegation(text) {
  return NEGATION_MARKERS.test(normalizeText(text))
}
function hasPositive(text) {
  return POSITIVE_MARKERS.test(normalizeText(text))
}

// mem_id 主题匹配：识别器给 fact 的命名本身就编码了主题（fact_user_coffee / fact_user_coffee_quit）。
// 共享 ≥3 个 _ 分段（fact + 主体 + 主题）或一方是另一方前缀 → 同一主题，比纯文本重叠可靠得多。
export function memIdTopicMatch(a, b) {
  const ma = String(a?.mem_id || '')
  const mb = String(b?.mem_id || '')
  if (!ma || !mb || ma === mb) return 0
  if (ma.startsWith(mb + '_') || mb.startsWith(ma + '_')) return 1
  const segA = ma.split('_')
  const segB = mb.split('_')
  let common = 0
  for (let i = 0; i < Math.min(segA.length, segB.length); i++) {
    if (segA[i] === segB[i]) common++
    else break
  }
  return common >= 3 ? 1 : 0
}

// 判定两条事实是否"主题相关但语义冲突"。返回 { score } 或 null。
export function detectFactContradiction(a, b) {
  if (!a || !b) return null
  const textA = `${a.title || ''} ${a.content || ''}`
  const textB = `${b.title || ''} ${b.content || ''}`
  // 主题锚：mem_id 同主题（识别器命名）优先；否则退回文本 overlap。
  const memMatch = memIdTopicMatch(a, b)
  const textScore = topicSimilarity(a, b)
  const score = Math.max(memMatch, textScore)
  if (score < 0.22) return null   // 主题不够重叠 → 不算矛盾

  const na = hasNegation(textA)
  const nb = hasNegation(textB)
  const pa = hasPositive(textA)
  const pb = hasPositive(textB)
  // 冲突：一方明确肯定、一方明确否定
  if ((pa && nb) || (na && pb)) return { score }
  // 一方带否定、另一方不带 → 也视为潜在改口（如"不喝咖啡了" vs "每天喝咖啡"）
  if (na !== nb && (na || nb)) return { score }
  // 极高重叠 + 内容实质不同 → 改口/纠正（保守阈值放高）
  if (score >= 0.6) return { score }
  return null
}

// 查新 fact 与既有 fact 的矛盾。existingFacts 可由调用方传入，也可用 keywords 现查。
export function findFactContradiction(newFact, existingFacts = null) {
  const candidates = existingFacts
  const list = Array.isArray(candidates) ? candidates : searchExistingFacts(newFact)
  for (const old of list) {
    if (!old || old.mem_id === newFact?.mem_id) continue
    const r = detectFactContradiction(newFact, old)
    if (r) return { old, score: r.score }
  }
  return null
}

// 按新 fact 的主题（title）现查现有 fact 记忆。
// 注意：不能用"title+content"全文去搜——那会命中新 fact 自己的措辞（如"戒咖啡了"的"戒"），
// 反而找不到旧 fact（"喜欢喝咖啡"不含"戒"）。主题是 title，用它才能同时命中新旧两条。
function searchExistingFacts(newFact) {
  try {
    let query = String(newFact?.title || '').trim()
    if (!query) {
      const kws = extractKeywords(String(newFact?.content || ''), 6)
      query = kws.slice(0, 2).join(' ')
    }
    if (!query) return []
    const hits = searchMemories(query, 8)
    return hits.filter(m => {
      const type = m.type || m.event_type || ''
      return type === 'fact' || String(m.mem_id || '').startsWith('fact_')
    })
  } catch {
    return []
  }
}

// getMemoryByMemId 返回的是 DB 原始行——tags 是 JSON 字符串而非数组，这里统一解析。
function parseTags(row) {
  const raw = row?.tags
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string' && raw.trim()) {
    try { const p = JSON.parse(raw); if (Array.isArray(p)) return p } catch (e) { console.warn('[src/memory/profile-dialectic.js] op failed:', e?.message || e) }
    try { const p = JSON.parse(`[${raw}]`); if (Array.isArray(p)) return p } catch (e) { console.warn('[src/memory/profile-dialectic.js] op failed:', e?.message || e) }
  }
  return []
}

// 执行辩证修正：标记旧事实 superseded、新事实 corrects。best-effort，返回 warning 文本或 null。
export function applyDialecticCorrection(newMemId, oldMemory) {
  if (!newMemId || !oldMemory?.mem_id) return null
  const warnParts = []
  try {
    const old = getMemoryByMemId(oldMemory.mem_id)
    if (old) {
      const tags = parseTags(old)
      const updated = {
        ...old,
        tags: [...new Set([...tags, `superseded_by:${newMemId}`])],
        detail: (old.detail ? String(old.detail) + '\n' : '') + `[辩证修正] ${new Date().toISOString().slice(0, 10)} 被新事实 ${newMemId} 更正`,
      }
      upsertMemoryByMemId(updated)
      warnParts.push(`既有记忆「${old.title || old.mem_id}」与本次写入矛盾，已标记被 ${newMemId} 更正（保留历史，不再当作当前状态）。`)
    }
  } catch (err) {
    console.warn('[profile-dialectic] mark old failed:', err?.message)
  }
  try {
    const fresh = getMemoryByMemId(newMemId)
    if (fresh) {
      const tags = parseTags(fresh)
      upsertMemoryByMemId({
        ...fresh,
        tags: [...new Set([...tags, `corrects:${oldMemory.mem_id}`])],
      })
    }
  } catch (err) {
    console.warn('[profile-dialectic] mark new failed:', err?.message)
  }
  return warnParts.length ? warnParts.join(' ') : null
}

