// workbench.js —— 工作台（Workbench）存储与查询
//
// 提供待办事项（todo）与每周复盘（weekly review）的持久化：
//   - 待办事项：title/detail/priority/tags，status=pending（待办）| done（完成事项）。
//   - 每周复盘：按 ISO 周（如 "2026-W33"）一份，按周 upsert。
// 数据在 workbench_todos / workbench_reviews 表，由 Agent 工具（manage_todo / weekly_review）
// 与工作台 API 共同维护。Agent 侧只增不删的语义：完成即 status=done，历史保留。

import { getDB } from '../db.js'

const VALID_TODO_STATUS = new Set(['pending', 'done'])

function clampInt(v, min, max, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback
}

function parseTags(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map(String).slice(0, 12))
  if (typeof value === 'string' && value.trim()) {
    try {
      const arr = JSON.parse(value)
      if (Array.isArray(arr)) return JSON.stringify(arr.map(String).slice(0, 12))
    } catch (e) { console.warn('[src/memory/workbench.js] op failed:', e?.message || e) }
  }
  return '[]'
}

// ─── 待办事项 ───────────────────────────────────────────────────────────────

export function createTodo({ title, detail = '', priority = 3, tags = [] } = {}) {
  const cleanTitle = String(title || '').trim()
  if (!cleanTitle) return { ok: false, error: 'title 必填' }
  const db = getDB()
  const info = db.prepare(`
    INSERT INTO workbench_todos (title, detail, priority, tags)
    VALUES (?, ?, ?, ?)
  `).run(cleanTitle, String(detail || '').trim(), clampInt(priority, 1, 5, 3), parseTags(tags))
  return { ok: true, todo: getTodoById(info.lastInsertRowid) }
}

export function getTodoById(id) {
  return getDB().prepare('SELECT * FROM workbench_todos WHERE id = ?').get(id) || null
}

// 更新待办（任意字段；status 有限枚举）。status 改为 done 时自动补 completed_at。
export function updateTodo(id, patch = {}) {
  const db = getDB()
  const todo = getTodoById(id)
  if (!todo) return { ok: false, error: '待办不存在' }
  const fields = []
  const vals = []
  if (patch.title !== undefined) { fields.push('title = ?'); vals.push(String(patch.title).trim() || todo.title) }
  if (patch.detail !== undefined) { fields.push('detail = ?'); vals.push(String(patch.detail || '').trim()) }
  if (patch.priority !== undefined) { fields.push('priority = ?'); vals.push(clampInt(patch.priority, 1, 5, todo.priority)) }
  if (patch.tags !== undefined) { fields.push('tags = ?'); vals.push(parseTags(patch.tags)) }
  if (patch.status !== undefined) {
    const s = String(patch.status).toLowerCase()
    if (!VALID_TODO_STATUS.has(s)) return { ok: false, error: 'status 必须是 pending / done' }
    fields.push('status = ?'); vals.push(s)
    if (s === 'done') { fields.push('completed_at = ?'); vals.push(new Date().toISOString()) }
    else if (s === 'pending') { fields.push('completed_at = NULL'); }
  }
  if (!fields.length) return { ok: true, todo }
  fields.push('updated_at = datetime(\'now\')')
  vals.push(id)
  db.prepare(`UPDATE workbench_todos SET ${fields.join(', ')} WHERE id = ?`).run(...vals)
  return { ok: true, todo: getTodoById(id) }
}

// 完成一条待办（快捷入口）
export function completeTodo(id, completedAt = new Date().toISOString()) {
  const db = getDB()
  const r = db.prepare(`
    UPDATE workbench_todos
    SET status = 'done', completed_at = ?, updated_at = datetime('now')
    WHERE id = ? AND status = 'pending'
  `).run(completedAt, id)
  return r.changes > 0 ? { ok: true, todo: getTodoById(id) } : { ok: false, error: '待办不存在或已完成' }
}

// 删除待办（仅从清单移除；如需保留历史请用完成）
export function deleteTodo(id) {
  const r = getDB().prepare('DELETE FROM workbench_todos WHERE id = ?').run(id)
  return r.changes > 0 ? { ok: true } : { ok: false, error: '待办不存在' }
}

// 列出待办：status 为空返回全部（pending 在前），否则按状态过滤
export function listTodos({ status = null, limit = 100 } = {}) {
  const db = getDB()
  if (status && VALID_TODO_STATUS.has(String(status).toLowerCase())) {
    return db.prepare(`
      SELECT * FROM workbench_todos
      WHERE status = ?
      ORDER BY CASE status WHEN 'pending' THEN priority END DESC, created_at DESC, id DESC
      LIMIT ?
    `).all(String(status).toLowerCase(), limit)
  }
  return db.prepare(`
    SELECT * FROM workbench_todos
    ORDER BY CASE status WHEN 'pending' THEN priority END DESC, created_at DESC, id DESC
    LIMIT ?
  `).all(limit)
}

// 工作台汇总：待办数量 + 完成数量 + 最近完成（给对话上下文 / 状态展示用）
export function getWorkbenchSnapshot() {
  const db = getDB()
  const pending = db.prepare(`SELECT COUNT(*) AS c FROM workbench_todos WHERE status = 'pending'`).get().c
  const done = db.prepare(`SELECT COUNT(*) AS c FROM workbench_todos WHERE status = 'done'`).get().c
  const recentDone = db.prepare(`
    SELECT * FROM workbench_todos WHERE status = 'done'
    ORDER BY completed_at DESC, id DESC LIMIT 5
  `).all()
  return { pending, done, recentDone }
}

// ─── 每周复盘 ───────────────────────────────────────────────────────────────

// 取当前（或指定时间）的 ISO 周 key，形如 "2026-W33"
export function currentWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`
}

// 保存每周复盘（按 week_key upsert）。content / mood 缺省时保留旧值。
export function saveWeeklyReview({ weekKey = null, content = '', mood = '' } = {}) {
  const key = (weekKey && String(weekKey).trim()) || currentWeekKey()
  const cleanContent = String(content || '').trim()
  const cleanMood = String(mood || '').trim()
  const db = getDB()
  const existing = getWeeklyReview(key)
  if (existing) {
    db.prepare(`
      UPDATE workbench_reviews
      SET content = ?, mood = ?, updated_at = datetime('now')
      WHERE week_key = ?
    `).run(
      cleanContent || existing.content,
      cleanMood || existing.mood,
      key,
    )
  } else {
    db.prepare(`
      INSERT INTO workbench_reviews (week_key, content, mood)
      VALUES (?, ?, ?)
    `).run(key, cleanContent, cleanMood)
  }
  return { ok: true, review: getWeeklyReview(key) }
}

export function getWeeklyReview(weekKey) {
  const key = (weekKey && String(weekKey).trim()) || currentWeekKey()
  return getDB().prepare('SELECT * FROM workbench_reviews WHERE week_key = ?').get(key) || null
}

export function deleteWeeklyReview(weekKey) {
  const key = (weekKey && String(weekKey).trim()) || currentWeekKey()
  const r = getDB().prepare('DELETE FROM workbench_reviews WHERE week_key = ?').run(key)
  return r.changes > 0 ? { ok: true } : { ok: false, error: '复盘不存在' }
}

export function listWeeklyReviews(limit = 20) {
  return getDB().prepare(`
    SELECT * FROM workbench_reviews
    ORDER BY week_key DESC
    LIMIT ?
  `).all(limit)
}
