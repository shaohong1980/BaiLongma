// text-compressor.js —— 通用长文压缩（CJK 友好，OpenHuman 思路的本地化补充）
//
// 与 tool-result-compressor.js（工具结果压缩）的关系：
//   tool-result-compressor 负责"把大工具结果压成一行摘要 + 全文落盘按需取回"；
//   本模块负责"给任意一段长文本生成一个信息量足够、体量可控的压缩版"——
//   既被 tool-result-compressor 的通用分支用来生成更聪明的摘要行，
//   也可被 read_file / fetch_url / web_search 等任何需要"先给模型看浓缩版"的地方复用。
//
// 设计：纯函数、零依赖、绝不 throw。CJK 文本按中文句读切分 + 句级打分，
// 保留信息密度最高的句子（含数字/引号/关键词/问句/结论信号），去重、保序、控长。
// 英文/混合文本同样按标点切分并打分，不依赖任何云端模型——离线、零配置、可测。

// 判断文本是否以 CJK 为主（用于微调拼接策略：CJK 句间不加空格）
export function isCJK(text) {
  const s = String(text || '')
  if (!s) return false
  let cjk = 0
  let total = 0
  for (const ch of s) {
    if (/\s/.test(ch)) continue
    total++
    if (/[㐀-䶿一-鿿\u3000-\u303f＀-￯]/.test(ch)) cjk++
    if (total >= 240) break
  }
  return total > 0 && cjk / total > 0.2
}

// 句读切分：先按换行拆，再对每段按句末标点拆；保留标点（标点随句走，拼接更安全）
function splitSentences(text) {
  const src = String(text || '')
  const out = []
  for (const line of src.split(/\r?\n+/)) {
    // 在句末标点（。！？!?；;）之后断开，标点留在上一句
    const segs = line.split(/(?<=[。！？!?；;])/)
    for (const seg of segs) {
      const t = seg.trim()
      if (t) out.push(t)
    }
  }
  return out
}

// 信息密度信号词（中英文混合）——命中即加分，让"结论/步骤/异常"类句子优先保留
const SIGNAL_RE = /(如何|怎么|怎样|为什么|什么|哪些|步骤|注意|重要|必须|应该|需要|错误|失败|成功|结果|原因|解决|总结|关键|建议|结论|例如|比如|即|whether|why|how|step|note|important|must|error|fail|success|result|summary|key|conclusion)/i

function scoreSentence(s, idx, total) {
  let score = 0
  const len = s.length
  if (idx === 0) score += 3           // 首句常为导语
  else if (idx < Math.max(1, total * 0.15)) score += 1
  if (len >= 8 && len <= 140) score += 2        // 长度甜区
  else if (len > 140) score += 0.5
  else if (len < 4) score -= 3                   // 太碎，噪声
  if (/\d/.test(s)) score += 1                   // 含数字（日期/版本/指标）
  if (/[""'']/.test(s)) score += 0.5       // 含引号（引用/术语）
  if (/[A-Za-z]{2,}/.test(s)) score += 0.5
  if (SIGNAL_RE.test(s)) score += 1.5
  return score
}

/**
 * 通用长文压缩：保留信息密度最高的句子，去重、保序、控长。
 * @param {string} text        原文
 * @param {object} [opts]
 * @param {number} [opts.maxChars=1200]  压缩后最大字符数
 * @returns {string} 压缩文本（出错时回退到截断原文，永不抛出）
 */
export function compressLongText(text, { maxChars = 1200 } = {}) {
  const fallback = (t) => String(t || '').slice(0, maxChars)
  try {
    const src = String(text || '').trim()
    if (!src) return ''
    if (src.length <= maxChars) return src   // 本就不长，原样返回

    const sentences = splitSentences(src)
    if (sentences.length <= 1) {
      return src.slice(0, maxChars) + (src.length > maxChars ? '…' : '')
    }

    const n = sentences.length
    const items = sentences.map((s, i) => ({ s, i, score: scoreSentence(s, i, n) }))
    // 先按信息分降序、同分保序；再预算贪心选取
    items.sort((a, b) => b.score - a.score || a.i - b.i)

    let budget = maxChars
    const chosen = []
    for (const it of items) {
      if (budget <= 0) break
      let piece = it.s
      if (piece.length > budget) piece = piece.slice(0, budget) + '…'
      // 去重：若已被已选的更长句完整包含，跳过
      let dup = false
      for (const c of chosen) {
        if (c.text.length > piece.length && c.text.includes(piece)) { dup = true; break }
      }
      if (dup) continue
      chosen.push({ idx: it.i, text: piece })
      budget -= piece.length
    }

    // 还原原始顺序
    chosen.sort((a, b) => a.idx - b.idx)
    // CJK 句间不加空格；拉丁为主时加空格，避免词边界粘连
    return chosen.map(c => c.text).join(isCJK(src) ? '' : ' ')
  } catch {
    return fallback(text)
  }
}
