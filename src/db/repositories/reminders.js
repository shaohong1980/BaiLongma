import { getDB } from '../connection.js'
import { CANONICAL_USER_ID, normalizeConversationPartyId } from '../utils.js'

export function createReminder({ userId, dueAt, task, systemMessage, source = '', recurrenceType = null, recurrenceConfig = null }) {
  const db = getDB()
  const normalizedUserId = normalizeConversationPartyId(userId || CANONICAL_USER_ID)
  const configStr = recurrenceConfig ? JSON.stringify(recurrenceConfig) : null
  return db.prepare(`
    INSERT INTO reminders (user_id, due_at, task, system_message, status, source, recurrence_type, recurrence_config)
    VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
  `).run(normalizedUserId, dueAt, task, systemMessage, source, recurrenceType, configStr)
}

export function findMergeableOneOffReminder(userId, dueAtIsoMinute) {
  const db = getDB()
  const normalizedUserId = normalizeConversationPartyId(userId || CANONICAL_USER_ID)
  return db.prepare(`
    SELECT * FROM reminders
    WHERE status = 'pending'
      AND recurrence_type IS NULL
      AND user_id = ?
      AND substr(due_at, 1, 16) = ?
    ORDER BY id ASC
    LIMIT 1
  `).get(normalizedUserId, dueAtIsoMinute) || null
}

export function appendReminderTask(id, additionalTask, newSystemMessage) {
  const db = getDB()
  const row = db.prepare(`SELECT task FROM reminders WHERE id = ?`).get(id)
  if (!row) return { changes: 0 }
  const mergedTask = `${row.task}; ${additionalTask}`
  return db.prepare(`
    UPDATE reminders
    SET task = ?, system_message = ?
    WHERE id = ? AND status = 'pending'
  `).run(mergedTask, newSystemMessage, id)
}

export function getDueReminders(now = new Date().toISOString(), limit = 20) {
  const db = getDB()
  return db.prepare(`
    SELECT * FROM reminders
    WHERE status = 'pending' AND due_at <= ?
    ORDER BY due_at ASC, id ASC
    LIMIT ?
  `).all(now, limit)
}

export function markReminderFired(id, firedAt = new Date().toISOString()) {
  const db = getDB()
  return db.prepare(`
    UPDATE reminders
    SET status = 'fired', fired_at = ?
    WHERE id = ? AND status = 'pending'
  `).run(firedAt, id)
}

export function advanceReminderDueAt(id, nextDueAtIso) {
  const db = getDB()
  return db.prepare(`
    UPDATE reminders
    SET due_at = ?
    WHERE id = ? AND status = 'pending'
  `).run(nextDueAtIso, id)
}

export function cancelReminder(id, cancelledAt = new Date().toISOString()) {
  const db = getDB()
  return db.prepare(`
    UPDATE reminders
    SET status = 'cancelled', cancelled_at = ?
    WHERE id = ? AND status = 'pending'
  `).run(cancelledAt, id)
}

export function listPendingReminders(limit = 50) {
  const db = getDB()
  return db.prepare(`
    SELECT * FROM reminders
    WHERE status = 'pending'
    ORDER BY due_at ASC, id ASC
    LIMIT ?
  `).all(limit)
}

export function getReminderById(id) {
  const db = getDB()
  return db.prepare(`SELECT * FROM reminders WHERE id = ?`).get(id) || null
}

export function getNextPendingReminder() {
  const db = getDB()
  return db.prepare(`
    SELECT * FROM reminders
    WHERE status = 'pending'
    ORDER BY due_at ASC, id ASC
    LIMIT 1
  `).get() || null
}
