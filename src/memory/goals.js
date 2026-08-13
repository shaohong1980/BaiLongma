// goals.js —— 长期目标（Goals）存储与推进
//
// 提供目标 CRUD + 「推进」：从 active 目标里挑一个，产出推进建议/动作。
// 数据在 goals 表；由 Agent 工具（set_goal/list_goals/update_goal/complete_goal）
// 维护，晨间简报读取活跃目标做进展汇总。

import { getDB } from '../db.js'

const VALID_STATUS = new Set(['active', 'paused', 'done', 'abandoned'])

function clampInt(v, min, max, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback
}

// 建目标
export function createGoal({ title, description = '', priority = 3, due_at = null }) {
  if (!title || !String(title).trim()) return { ok: false, error: 'title 必填' }
  const db = getDB()
  const info = db.prepare(`
    INSERT INTO goals (title, description, status, priority, progress, due_at)
    VALUES (?, ?, 'active', ?, 0, ?)
  `).run(String(title).trim(), String(description || '').trim(), clampInt(priority, 1, 5, 3), due_at || null)
  const goal = getGoalById(info.lastInsertRowid)
  return { ok: true, goal }
}

// 更新目标（任意字段；status 有限枚举）
export function updateGoal(id, patch = {}) {
  const db = getDB()
  const goal = getGoalById(id)
  if (!goal) return { ok: false, error: '目标不存在' }
  const fields = []
  const vals = []
  if (patch.title !== undefined) { fields.push('title = ?'); vals.push(String(patch.title).trim() || goal.title) }
  if (patch.description !== undefined) { fields.push('description = ?'); vals.push(String(patch.description || '').trim()) }
  if (patch.priority !== undefined) { fields.push('priority = ?'); vals.push(clampInt(patch.priority, 1, 5, goal.priority)) }
  if (patch.progress !== undefined) { fields.push('progress = ?'); vals.push(clampInt(patch.progress, 0, 100, goal.progress)) }
  if (patch.due_at !== undefined) { fields.push('due_at = ?'); vals.push(patch.due_at || null) }
  if (patch.result_note !== undefined) { fields.push('result_note = ?'); vals.push(String(patch.result_note || '').trim() || null) }
  if (patch.status !== undefined) {
    const s = String(patch.status).toLowerCase()
    if (!VALID_STATUS.has(s)) return { ok: false, error: 'status 必须是 active/paused/done/abandoned' }
    fields.push('status = ?'); vals.push(s)
    if (s === 'done') { fields.push('progress = ?'); vals.push(100) }
  }
  if (!fields.length) return { ok: true, goal }
  fields.push('updated_at = datetime(\'now\')')
  vals.push(id)
  db.prepare(`UPDATE goals SET ${fields.join(', ')} WHERE id = ?`).run(...vals)
  return { ok: true, goal: getGoalById(id) }
}

export function getGoalById(id) {
  return getDB().prepare('SELECT * FROM goals WHERE id = ?').get(id) || null
}

export function listGoals({ status = null, limit = 50 } = {}) {
  const db = getDB()
  if (status && VALID_STATUS.has(String(status).toLowerCase())) {
    return db.prepare('SELECT * FROM goals WHERE status = ? ORDER BY priority DESC, updated_at DESC LIMIT ?').all(String(status).toLowerCase(), limit)
  }
  return db.prepare('SELECT * FROM goals ORDER BY status = \'active\' DESC, priority DESC, updated_at DESC LIMIT ?').all(limit)
}

// 挑一个该推进的 active 目标（优先高优先级、未推进最久）
export function pickGoalToAdvance() {
  const db = getDB()
  return db.prepare(`
    SELECT * FROM goals
    WHERE status = 'active'
    ORDER BY (last_tick_at IS NULL) DESC, priority DESC, COALESCE(last_tick_at, '1970-01-01') ASC
    LIMIT 1
  `).get() || null
}

// 记录一次推进（更新时间戳）
export function markGoalTicked(id) {
  getDB().prepare(`UPDATE goals SET last_tick_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(id)
}

// 晨间简报用：活跃目标列表（含进度/优先级）
export function listActiveGoals() {
  return listGoals({ status: 'active', limit: 20 })
}

