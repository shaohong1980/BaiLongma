// tools/hitl.js —— HITL 审批工具执行器（P1）
import { createApproval, waitForApproval, listApprovals, getPendingCount } from '../../hitl/approval.js'

function toolJson(payload) {
  return JSON.stringify(payload, null, 2)
}

// request_approval：创建审批请求并等待结果
export async function execRequestApproval(args = {}, context = {}) {
  const title = String(args.title || '').trim()
  if (!title) return toolJson({ ok: false, tool: 'hitl_request', error: '缺少 title' })

  const description = String(args.description || '').trim()
  const riskLevel = ['low', 'medium', 'high'].includes(args.risk_level) ? args.risk_level : 'medium'
  const timeoutMs = Math.min(Math.max(Number(args.timeout_ms) || 86400000, 5000), 604800000) // 5s ~ 7d
  const contextData = args.context && typeof args.context === 'object' ? args.context : {}

  // 创建审批
  const created = createApproval({
    title,
    description,
    riskLevel,
    timeoutMs,
    context: contextData,
  })

  if (!created.ok) {
    return toolJson({ ok: false, tool: 'hitl_request', error: created.error })
  }

  const approvalId = created.approval.id

  // 如果是被中断的信号，立即返回
  if (context.signal?.aborted) {
    return toolJson({
      ok: false,
      tool: 'hitl_request',
      error: '执行被中断',
      approval_id: approvalId,
      approval_status: 'pending',
    })
  }

  // 等待审批结果（最多等 timeoutMs，但实际工具执行有自己的超时，这里设一个合理的等待上限）
  // 注意：工具执行通常有超时，这里用 min(timeoutMs, 120000) 作为等待上限
  const waitTimeout = Math.min(timeoutMs, 120000)
  const result = await waitForApproval(approvalId, { timeoutMs: waitTimeout })

  const approved = result.status === 'approved'
  return toolJson({
    ok: true,
    tool: 'hitl_request',
    approval_id: approvalId,
    approved,
    status: result.status,
    reason: result.reason || '',
    title,
    message: approved
      ? `用户已通过审批：${title}`
      : result.status === 'rejected'
        ? `用户已拒绝审批：${title}`
        : `审批等待超时（${waitTimeout / 1000}s），状态仍为 pending。可稍后用 list_approvals 查询结果。`,
    hint: result.status === 'pending'
      ? '审批仍在等待中。用户可在 UI 或通过 API /approvals/:id/approve 处理。'
      : approved
        ? '可以继续执行后续操作。'
        : '不应执行被拒绝的操作。',
  })
}

// list_approvals：列出审批
export function execListApprovals(args = {}) {
  const status = args.status ? String(args.status) : null
  const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 200)
  const offset = Math.max(Number(args.offset) || 0, 0)

  try {
    const result = listApprovals({ status, limit, offset })
    const pendingCount = getPendingCount()
    return toolJson({
      ok: true,
      tool: 'hitl_list',
      pending_count: pendingCount,
      total: result.total,
      approvals: result.approvals,
    })
  } catch (err) {
    return toolJson({ ok: false, tool: 'hitl_list', error: err.message })
  }
}
