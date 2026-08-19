// observability/index.js —— 可观测性统一入口
//
// 整合：
//   - tracer.js：Span 追踪（OTel 兼容）
//   - insights.js：用量与成本统计（已有）
//
// 对外暴露：
//   tracer, startSpan, trace, getTraces, getTraceDetail, getSpanStats, exportTracesOtel
//   getUsageSummary, getToolUsageSummary, formatUsageReport
//   getCostBreakdown（新增：按模型/按天的成本明细）

import { tracer, startTracerFlush, stopTracerFlush, initTracerSchema, getTraces, getTraceDetail, getSpanStats, exportTracesOtel, SPAN_KIND, SPAN_STATUS } from './tracer.js'
import { getUsageSummary, getToolUsageSummary, formatUsageReport, recordUsageEvent } from '../runtime/insights.js'
import { getDB } from '../db.js'

export {
  tracer, startTracerFlush, stopTracerFlush, initTracerSchema,
  getTraces, getTraceDetail, getSpanStats, exportTracesOtel,
  SPAN_KIND, SPAN_STATUS,
  getUsageSummary, getToolUsageSummary, formatUsageReport, recordUsageEvent,
}

export function startSpan(name, options) {
  return tracer.startSpan(name, options)
}

export function trace(name, options, fn) {
  return tracer.trace(name, options, fn)
}

// ─── 成本明细（按模型/按天）────────────────────────────────────────
export function getCostBreakdown({ days = 7 } = {}) {
  const db = getDB()
  const n = Math.max(1, Math.min(Number(days) || 7, 365))

  // 按天 + 模型聚合
  const byDayModel = db.prepare(`
    SELECT date(created_at) AS day, provider, model,
           COUNT(*) AS calls,
           SUM(input_tokens) AS input_tokens,
           SUM(output_tokens) AS output_tokens,
           SUM(total_tokens) AS total_tokens,
           SUM(cost_estimate) AS cost
    FROM usage_events
    WHERE date(created_at) >= date('now', ?)
    GROUP BY day, provider, model
    ORDER BY day DESC, cost DESC
  `).all(`-${n - 1} days`)

  // 按模型汇总
  const byModel = db.prepare(`
    SELECT provider, model,
           COUNT(*) AS calls,
           SUM(total_tokens) AS total_tokens,
           SUM(cost_estimate) AS cost,
           AVG(duration_ms) AS avg_duration
    FROM usage_events
    WHERE date(created_at) >= date('now', ?)
    GROUP BY provider, model
    ORDER BY cost DESC
  `).all(`-${n - 1} days`)

  // 总成本
  const total = db.prepare(`
    SELECT COUNT(*) AS calls,
           SUM(total_tokens) AS total_tokens,
           SUM(cost_estimate) AS total_cost,
           SUM(input_tokens) AS input_tokens,
           SUM(output_tokens) AS output_tokens
    FROM usage_events
    WHERE date(created_at) >= date('now', ?)
  `).get(`-${n - 1} days`)

  // 每日趋势
  const daily = db.prepare(`
    SELECT date(created_at) AS day,
           COUNT(*) AS calls,
           SUM(total_tokens) AS total_tokens,
           SUM(cost_estimate) AS cost
    FROM usage_events
    WHERE date(created_at) >= date('now', ?)
    GROUP BY day ORDER BY day ASC
  `).all(`-${n - 1} days`)

  // Top 10 最昂贵的单次调用
  const topExpensive = db.prepare(`
    SELECT created_at, provider, model, total_tokens, cost_estimate, duration_ms
    FROM usage_events
    WHERE date(created_at) >= date('now', ?)
    ORDER BY cost_estimate DESC LIMIT 10
  `).all(`-${n - 1} days`)

  return {
    days: n,
    total: {
      calls: total.calls || 0,
      total_tokens: total.total_tokens || 0,
      input_tokens: total.input_tokens || 0,
      output_tokens: total.output_tokens || 0,
      total_cost: Number((total.total_cost || 0).toFixed(4)),
    },
    by_model: byModel.map(m => ({ ...m, cost: Number((m.cost || 0).toFixed(4)) })),
    by_day_model: byDayModel.map(m => ({ ...m, cost: Number((m.cost || 0).toFixed(4)) })),
    daily_trend: daily.map(d => ({ ...d, cost: Number((d.cost || 0).toFixed(4)) })),
    top_expensive: topExpensive.map(t => ({ ...t, cost_estimate: Number((t.cost_estimate || 0).toFixed(4)) })),
  }
}

// 综合仪表盘数据（一次调用拿到所有可观测性数据）
export function getDashboardData({ days = 7 } = {}) {
  const cost = getCostBreakdown({ days })
  const spans = getSpanStats({ days })
  const tools = getToolUsageSummary({ days, limit: 10 })
  const usage = getUsageSummary({ days })

  return {
    period: { days },
    cost,
    traces: spans,
    tools,
    latency: usage.latency,
    generated_at: new Date().toISOString(),
  }
}
