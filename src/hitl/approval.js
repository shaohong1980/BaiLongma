// hitl/approval.js —— 人机交互审批节点（HITL）
//
// 功能：
//   1. Agent 可主动请求用户审批（request_approval 工具）
//   2. 审批请求持久化到 SQLite，支持跨重启恢复
//   3. 状态机：pending → approved / rejected / expired
//   4. 超时自动过期（默认 24h）
//   5. 审批通过后可触发回调（继续执行后续逻辑）
//   6. API 端点：列出待审批、审批通过/拒绝
//
// 使用场景：
//   - 危险操作前确认（删除文件、发送消息、执行命令）
//   - 长任务中间节点审核
//   - 合同/财务等需要人工确认的场景

import { getDB } from '../db.js'
import { emitEvent } from '../events.js'
import crypto from 'crypto'

const DEFAULT_TIMEOUT_MS = 24 * 60 * 60 * 1000 // 24h
const STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
}

// 内存中的等待回调 Map：approval_id → { resolve, reject, timer }
const pendingCallbacks = new Map()

function generateId() {
  return 'apr_' + crypto.randomBytes(6).toString('hex')
}

// 注：approvals 表结构统一在 src/db/schema.js 初始化（initializeSchema），此处不重复建表。

// ─── 创建审批请求 ──────────────────────────────────────────────────
export function createApproval({
  title,
  description = '',
  context = {},
  riskLevel = 'medium',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  callbackData = null,
} = {}) {
  if (!title || !String(title).trim()) {
    return { ok: false, error: '缺少 title' }
  }

  const id = generateId()
  const expiresAt = new Date(Date.now() + timeoutMs).toISOString()
  const db = getDB()

  db.prepare(`
    INSERT INTO approvals (id, title, description, context, risk_level, status, expires_at, callback_data)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(
    id,
    String(title).trim(),
    String(description || ''),
    JSON.stringify(context || {}),
    ['low', 'medium', 'high'].includes(riskLevel) ? riskLevel : 'medium',
    expiresAt,
    callbackData ? JSON.stringify(callbackData) : '',
  )

  const approval = {
    id,
    title,
    description,
    context,
    risk_level: riskLevel,
    status: STATUS.PENDING,
    created_at: new Date().toISOString(),
    expires_at: expiresAt,
  }

  // 通知前端：有待审批项
  emitEvent('approval_requested', approval)

  return { ok: true, approval, message: `审批请求已创建：${title}` }
}

// ─── 等待审批（Promise，Agent 工具中使用）──────────────────────────
export function waitForApproval(approvalId, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    // 先检查是否已经被处理
    const existing = getApproval(approvalId)
    if (existing && existing.status !== STATUS.PENDING) {
      resolve(existing)
      return
    }

    const timer = setTimeout(() => {
      pendingCallbacks.delete(approvalId)
      expireApproval(approvalId)
      resolve({ id: approvalId, status: STATUS.EXPIRED, error: '审批超时未处理' })
    }, timeoutMs)

    pendingCallbacks.set(approvalId, { resolve, reject, timer })
  })
}

// ─── 审批操作 ──────────────────────────────────────────────────────
export function resolveApproval(approvalId, { action, reason = '', resolvedBy = 'user' } = {}) {
  if (!approvalId) return { ok: false, error: '缺少 approval_id' }
  if (!['approve', 'reject'].includes(action)) return { ok: false, error: 'action 必须是 approve 或 reject' }

  const db = getDB()
  const existing = db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId)
  if (!existing) return { ok: false, error: `审批不存在: ${approvalId}` }
  if (existing.status !== STATUS.PENDING) {
    return { ok: false, error: `审批已处理（当前状态: ${existing.status}）`, approval: existing }
  }

  const newStatus = action === 'approve' ? STATUS.APPROVED : STATUS.REJECTED
  const resolvedAt = new Date().toISOString()

  db.prepare(`
    UPDATE approvals SET status = ?, resolved_at = ?, resolved_by = ?, reason = ? WHERE id = ?
  `).run(newStatus, resolvedAt, resolvedBy, String(reason || ''), approvalId)

  const updated = { ...existing, status: newStatus, resolved_at: resolvedAt, resolved_by: resolvedBy, reason }

  // 触发等待中的回调
  const callback = pendingCallbacks.get(approvalId)
  if (callback) {
    clearTimeout(callback.timer)
    pendingCallbacks.delete(approvalId)
    callback.resolve(updated)
  }

  // 通知前端
  emitEvent('approval_resolved', { id: approvalId, status: newStatus, reason })

  return { ok: true, approval: updated, message: action === 'approve' ? '已通过' : '已拒绝' }
}

// 过期审批
export function expireApproval(approvalId) {
  const db = getDB()
  const existing = db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId)
  if (!existing || existing.status !== STATUS.PENDING) return
  db.prepare(`UPDATE approvals SET status = 'expired', resolved_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), approvalId)
  emitEvent('approval_expired', { id: approvalId })
}

// 清理过期审批（定时调用）
export function cleanupExpiredApprovals() {
  const db = getDB()
  const expired = db.prepare(`
    SELECT id FROM approvals WHERE status = 'pending' AND expires_at < datetime('now')
  `).all()
  for (const e of expired) expireApproval(e.id)
  return expired.length
}

// ─── 查询 ──────────────────────────────────────────────────────────
export function getApproval(approvalId) {
  const db = getDB()
  const row = db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId)
  if (!row) return null
  return { ...row, context: safeJson(row.context), callback_data: safeJson(row.callback_data) }
}

export function listApprovals({ status = null, limit = 50, offset = 0 } = {}) {
  const db = getDB()
  const conditions = []
  const params = []
  if (status) { conditions.push('status = ?'); params.push(status) }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  const rows = db.prepare(`
    SELECT id, title, description, risk_level, status, created_at, resolved_at, expires_at
    FROM approvals ${where}
    ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset)

  const total = db.prepare(`SELECT COUNT(*) AS c FROM approvals ${where}`).get(...params).c
  return { approvals: rows, total, limit, offset }
}

export function getPendingCount() {
  const db = getDB()
  return db.prepare(`SELECT COUNT(*) AS c FROM approvals WHERE status = 'pending'`).get().c
}

function safeJson(str) {
  try { return str ? JSON.parse(str) : {} } catch { return {} }
}

export { STATUS, DEFAULT_TIMEOUT_MS }
