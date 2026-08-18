// token-budget.js —— 上下文 token 预算器
//
// 目标（对齐主流 Agent 的 context management）：显式感知每轮上下文各段的 token 占用，
// 对低价值段做长度保护，防止上下文失控导致超窗口/成本飙升。不自动裁剪高价值段
// （系统提示/记忆/对话窗口由注入器已有阈值管理）——这里只做：①低价值段长度上限；
// ②全轮 token 统计观测（超阈值告警，供后续调整注入策略）。

// 中文为主，约 1.8 字符/token；英文约 4 字符/token。取 2.5 保守估算。
const CHARS_PER_TOKEN = 2.5
// 单个低价值段（终端流上下文 / 预取 / 主线路摘要）的长度上限
const MAX_LOW_VALUE_CHARS = 6000
// 全轮上下文（系统提示+上下文块+对话窗口）的告警阈值（约 40k token，留足余量）
const WARN_TOTAL_TOKENS = 100000

export function estimateTokens(text) {
  if (!text) return 0
  return Math.ceil(String(text).length / CHARS_PER_TOKEN)
}

// 低价值段超长时保留头尾（信息量两头最密：开头标题/结尾结论），避免整段丢弃。
export function capLowValueSegment(text, maxChars = MAX_LOW_VALUE_CHARS) {
  if (!text) return ''
  const s = String(text)
  if (s.length <= maxChars) return s
  const head = s.slice(0, Math.floor(maxChars * 0.6))
  const tail = s.slice(-Math.floor(maxChars * 0.4))
  return `${head}\n…[已截断 ${s.length - maxChars} 字符（原 ${s.length}）]…\n${tail}`
}

// 汇总各段 token 占用（观测用），返回 { total, detail }。
export function summarizeContextBudget(segments) {
  let total = 0
  const detail = {}
  for (const [name, text] of Object.entries(segments)) {
    const t = estimateTokens(text)
    detail[name] = t
    total += t
  }
  return { total, detail }
}

// 超阈值告警（不抛错，仅提示便于调优注入策略）
export function warnIfOverBudget(total, { budget = WARN_TOTAL_TOKENS, label = '' } = {}) {
  if (total > budget) {
    console.warn(`[context] ${label}上下文估算 ${total} tokens 超过告警阈值 ${budget}——检查注入策略`)
  }
}

// ── 自动降级（P1：超预算时裁剪低价值段，而非只观测）──
// 对话窗口是最大、最可变的部分：从最旧的消息开始裁，保留最近 minKeep 条作为连续性底线。
// 只裁对话历史，不动 system/contextBlock/当前 input。
export function estimateMessagesTokens(messages) {
  if (!Array.isArray(messages)) return 0
  return messages.reduce((sum, m) => sum + estimateTokens(m?.content || ''), 0)
}

export function degradeConversation(rows, fixedTokens = 0, { budget = WARN_TOTAL_TOKENS, minKeep = 6 } = {}) {
  if (!Array.isArray(rows) || rows.length <= minKeep) return rows
  let total = fixedTokens + rows.reduce((sum, r) => sum + estimateTokens(r?.content || ''), 0)
  if (total <= budget) return rows
  let cut = 0
  while (rows.length - cut > minKeep && total > budget) {
    total -= estimateTokens(rows[cut]?.content || '')
    cut++
  }
  const degraded = rows.slice(cut)
  if (cut > 0) {
    console.warn(`[context] 自动降级：对话窗口从 ${rows.length} 条裁到 ${degraded.length} 条（估算 ${total} tokens）`)
  }
  return degraded
}
