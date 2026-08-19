// tools/observability.js —— 可观测性工具执行器（P1）
import { getCostBreakdown, getTraces, getTraceDetail, getDashboardData } from '../../observability/index.js'

function toolJson(payload) {
  return JSON.stringify(payload, null, 2)
}

// cost_stats：成本统计
export function execCostStats(args = {}) {
  const days = Math.min(Math.max(Number(args.days) || 7, 1), 365)
  try {
    const data = getCostBreakdown({ days })
    return toolJson({
      ok: true,
      tool: 'cost_stats',
      period: `${data.days}天`,
      total: data.total,
      by_model: data.by_model,
      daily_trend: data.daily_trend,
      top_expensive: data.top_expensive.slice(0, 5),
    })
  } catch (err) {
    return toolJson({ ok: false, tool: 'cost_stats', error: err.message })
  }
}

// trace_list：列出 trace
export function execTraceList(args = {}) {
  const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100)
  const offset = Math.max(Number(args.offset) || 0, 0)
  const statusMap = { ok: 1, error: 2, unset: 0 }
  const status = args.status ? statusMap[args.status] : null
  const name = args.name ? String(args.name).trim() : null

  try {
    const result = getTraces({ limit, offset, status, name })
    return toolJson({
      ok: true,
      tool: 'trace_list',
      total: result.total,
      traces: result.traces.map(t => ({
        trace_id: t.trace_id,
        name: t.name,
        status: t.status_name,
        start_time: t.start_time,
        duration_ms: t.duration_ms,
        attributes: t.attributes,
      })),
    })
  } catch (err) {
    return toolJson({ ok: false, tool: 'trace_list', error: err.message })
  }
}

// trace_detail：trace 详情
export function execTraceDetail(args = {}) {
  const traceId = String(args.trace_id || '').trim()
  if (!traceId) return toolJson({ ok: false, tool: 'trace_detail', error: '缺少 trace_id' })
  try {
    const detail = getTraceDetail(traceId)
    if (!detail) return toolJson({ ok: false, tool: 'trace_detail', error: `trace 不存在: ${traceId}` })
    return toolJson({
      ok: true,
      tool: 'trace_detail',
      trace_id: detail.trace_id,
      span_count: detail.span_count,
      spans: detail.spans.map(s => ({
        span_id: s.span_id,
        parent_span_id: s.parent_span_id,
        name: s.name,
        status: s.status_name,
        start_time: s.start_time,
        duration_ms: s.duration_ms,
        attributes: s.attributes,
        events: s.events,
      })),
    })
  } catch (err) {
    return toolJson({ ok: false, tool: 'trace_detail', error: err.message })
  }
}

// observability_dashboard：综合仪表盘
export function execObservabilityDashboard(args = {}) {
  const days = Math.min(Math.max(Number(args.days) || 7, 1), 365)
  try {
    const data = getDashboardData({ days })
    return toolJson({
      ok: true,
      tool: 'observability_dashboard',
      period: data.period,
      generated_at: data.generated_at,
      cost_summary: {
        total_cost: data.cost.total.total_cost,
        total_calls: data.cost.total.calls,
        total_tokens: data.cost.total.total_tokens,
      },
      trace_summary: data.traces.totals,
      top_tools: data.tools,
      latency: data.latency,
    })
  } catch (err) {
    return toolJson({ ok: false, tool: 'observability_dashboard', error: err.message })
  }
}
