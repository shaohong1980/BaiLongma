// insights.js —— 用量洞察（参考 hermes-agent agent/insights.py）
//
// quota.js 只做内存级 RPM/TPM 限流，重启即清零；action_logs 记录了工具轨迹但没有汇总。
// 这里补上持久化的用量记录与报告：
//   - recordUsageEvent：每次 LLM 调用落一条 usage_events（token + 估算成本）
//   - getUsageSummary / getToolUsageSummary：按天/按周聚合
//   - formatUsageReport：人类可读的中文报告，供晨间简报/API/设置页使用
//
// 成本估算：按 provider 的每百万 token 单价（美元），只做粗估，标注"估算"。

import { getDB } from '../db.js'

// 每百万 token 单价（USD）：input / output。官方价格变化大，这里用近似值，报告里标注"估算"。
// 模型名是项目里的假设型号（deepseek-v4-pro / gpt-5.5 等），价格取同档近似。
const PRICE_PER_M = {
  deepseek:  { input: 0.28, output: 0.42 },
  openai:    { input: 2.50, output: 10.00 },
  minimax:   { input: 0.20, output: 0.50 },
  qwen:      { input: 0.50, output: 2.00 },
  moonshot:  { input: 0.60, output: 2.00 },
  zhipu:     { input: 0.50, output: 2.00 },
  mimo:      { input: 0.30, output: 0.80 },
  custom:    { input: 0, output: 0 },
}

function estimateCost(provider, inputTokens, outputTokens) {
  const p = PRICE_PER_M[provider] || { input: 0, output: 0 }
  return (inputTokens / 1e6) * p.input + (outputTokens / 1e6) * p.output
}

// 记录一次 LLM 调用的用量。best-effort：写库失败绝不抛（不影响调用链）。
export function recordUsageEvent({ provider = null, model = null, inputTokens = 0, outputTokens = 0, source = 'llm', durationMs = 0 } = {}) {
  try {
    const inT = Math.max(0, Number(inputTokens) || 0)
    const outT = Math.max(0, Number(outputTokens) || 0)
    const total = inT + outT
    if (total <= 0) return null
    const db = getDB()
    const info = db.prepare(`
      INSERT INTO usage_events (provider, model, input_tokens, output_tokens, total_tokens, cost_estimate, source, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(provider || null, model || null, inT, outT, total, estimateCost(provider, inT, outT), source || 'llm', Math.max(0, Number(durationMs) || 0))
    return Number(info.lastInsertRowid)
  } catch (err) {
    console.warn('[insights] recordUsageEvent failed:', err?.message)
    return null
  }
}

// 按天聚合用量。days=1 只算今天；days=7 算最近 7 天（含今天）。
export function getUsageSummary({ days = 1 } = {}) {
  const db = getDB()
  const n = Math.max(1, Math.min(Number(days) || 1, 365))
  const rows = db.prepare(`
    SELECT
      date(created_at) AS day,
      COUNT(*)              AS calls,
      SUM(input_tokens)     AS input_tokens,
      SUM(output_tokens)    AS output_tokens,
      SUM(total_tokens)     AS total_tokens,
      SUM(cost_estimate)    AS cost_estimate
    FROM usage_events
    WHERE date(created_at) >= date('now', ?)
    GROUP BY date(created_at)
    ORDER BY day ASC
  `).all(`-${n - 1} days`)

  const byProvider = db.prepare(`
    SELECT provider, COUNT(*) AS calls, SUM(total_tokens) AS total_tokens
    FROM usage_events
    WHERE date(created_at) >= date('now', ?)
    GROUP BY provider ORDER BY calls DESC
  `).all(`-${n - 1} days`)

  const totals = rows.reduce((acc, r) => {
    acc.calls += r.calls || 0
    acc.input += r.input_tokens || 0
    acc.output += r.output_tokens || 0
    acc.total += r.total_tokens || 0
    acc.cost += r.cost_estimate || 0
    return acc
  }, { calls: 0, input: 0, output: 0, total: 0, cost: 0 })

  // 延迟分位（P1）：取 duration_ms 的 p50 / p95
  const latency = computeLatencyPercentiles(db, n)

  return { days: n, byDay: rows, byProvider, totals, latency }
}

// 计算 duration_ms 的 p50 / p95（毫秒）
function computeLatencyPercentiles(db, n) {
  try {
    const rows = db.prepare(`
      SELECT duration_ms AS d FROM usage_events
      WHERE duration_ms > 0 AND date(created_at) >= date('now', ?)
    `).all(`-${n - 1} days`)
    if (!rows.length) return { p50: null, p95: null, count: 0 }
    const arr = rows.map(r => r.d).sort((a, b) => a - b)
    const p = (q) => {
      const idx = Math.min(arr.length - 1, Math.floor(arr.length * q))
      return arr[idx]
    }
    return { p50: p(0.5), p95: p(0.95), count: arr.length }
  } catch {
    return { p50: null, p95: null, count: 0 }
  }
}

// 工具使用 Top-N（来自 action_logs，只统计成功且有名称的）。
export function getToolUsageSummary({ days = 1, limit = 8 } = {}) {
  const db = getDB()
  const n = Math.max(1, Math.min(Number(days) || 1, 365))
  const cap = Math.max(1, Math.min(Number(limit) || 8, 50))
  return db.prepare(`
    SELECT tool, COUNT(*) AS count
    FROM action_logs
    WHERE tool IS NOT NULL AND tool != '' AND status != 'error'
      AND timestamp >= datetime('now', ?)
    GROUP BY tool ORDER BY count DESC LIMIT ?
  `).all(`-${n - 1} days`, cap)
}

function fmtTokens(n) {
  const v = Number(n) || 0
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`
  return String(v)
}

function fmtCost(c) {
  const v = Number(c) || 0
  if (v >= 1) return `$${v.toFixed(2)}`
  if (v >= 0.01) return `$${v.toFixed(3)}`
  return `$${v.toFixed(4)}`
}

// 生成人类可读的中文用量报告（供晨间简报 / /insights API）。
export function formatUsageReport({ days = 1 } = {}) {
  const s = getUsageSummary({ days })
  const t = s.totals
  if (t.calls === 0 && t.total === 0) {
    return `最近 ${s.days} 天暂无用量记录。`
  }
  const lines = [`### 用量（最近 ${s.days} 天）`]
  lines.push(`- LLM 调用 ${t.calls} 次，共 ${fmtTokens(t.total)} token（输入 ${fmtTokens(t.input)} / 输出 ${fmtTokens(t.output)}）`)
  if (t.cost > 0) lines.push(`- 估算成本 ${fmtCost(t.cost)}（按公开单价粗估）`)
  if (s.byProvider.length) {
    const prov = s.byProvider.map(p => `${p.provider || '?'} ${p.calls}次`).join('、')
    lines.push(`- 按服务商：${prov}`)
  }
  const tools = getToolUsageSummary({ days })
  if (tools.length) {
    const toolStr = tools.slice(0, 6).map(r => `${r.tool}×${r.count}`).join('、')
    lines.push(`- 常用工具：${toolStr}`)
  }
  return lines.join('\n')
}

