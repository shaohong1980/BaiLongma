// workflow/index.js —— 工作流引擎统一入口
import { createWorkflowEngine } from './engine.js'
import { validateWorkflow, renderTemplate, WORKFLOW_TEMPLATES, NODE_TYPES } from './schema.js'
import { getDB } from '../db.js'
import crypto from 'crypto'

export { createWorkflowEngine, validateWorkflow, renderTemplate, WORKFLOW_TEMPLATES, NODE_TYPES }

function generateId() {
  return 'wfdef_' + crypto.randomBytes(6).toString('hex')
}

// ─── 工作流定义存储 ────────────────────────────────────────────────
export function saveWorkflow(workflow) {
  const validation = validateWorkflow(workflow)
  if (!validation.valid) {
    return { ok: false, error: '工作流验证失败', errors: validation.errors }
  }
  const db = getDB()
  const id = workflow.id || generateId()
  const now = new Date().toISOString()
  db.prepare(`
    INSERT OR REPLACE INTO workflow_definitions (id, name, description, definition_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, COALESCE((SELECT created_at FROM workflow_definitions WHERE id = ?), ?), ?)
  `).run(id, workflow.name || id, workflow.description || '', JSON.stringify(workflow), id, now, now)
  return { ok: true, id, name: workflow.name }
}

export function getWorkflow(id) {
  const db = getDB()
  const row = db.prepare('SELECT * FROM workflow_definitions WHERE id = ?').get(id)
  if (!row) return null
  return { ...row, definition: JSON.parse(row.definition_json) }
}

export function listWorkflows({ limit = 50, offset = 0 } = {}) {
  const db = getDB()
  const rows = db.prepare(`
    SELECT id, name, description, created_at, updated_at
    FROM workflow_definitions ORDER BY updated_at DESC LIMIT ? OFFSET ?
  `).all(limit, offset)
  const total = db.prepare('SELECT COUNT(*) AS c FROM workflow_definitions').get().c
  return { workflows: rows, total, limit, offset }
}

export function deleteWorkflow(id) {
  const db = getDB()
  const existing = db.prepare('SELECT id, name FROM workflow_definitions WHERE id = ?').get(id)
  if (!existing) return { ok: false, error: `工作流不存在: ${id}` }
  db.prepare('DELETE FROM workflow_definitions WHERE id = ?').run(id)
  return { ok: true, deleted: id, name: existing.name }
}

// ─── 执行记录存储 ──────────────────────────────────────────────────
export function saveExecution(execution) {
  const db = getDB()
  db.prepare(`
    INSERT INTO workflow_executions (id, workflow_id, status, input_json, output_json, log_json, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    execution.execution_id,
    execution.workflow_id || '',
    execution.status || 'completed',
    JSON.stringify(execution.input || {}),
    JSON.stringify(execution.output || execution.context || {}),
    JSON.stringify(execution.log || []),
    execution.started_at || new Date().toISOString(),
    new Date().toISOString(),
  )
}

export function listExecutions({ workflowId = null, limit = 20, offset = 0 } = {}) {
  const db = getDB()
  const conditions = []
  const params = []
  if (workflowId) { conditions.push('workflow_id = ?'); params.push(workflowId) }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const rows = db.prepare(`
    SELECT id, workflow_id, status, started_at, finished_at
    FROM workflow_executions ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset)
  const total = db.prepare(`SELECT COUNT(*) AS c FROM workflow_executions ${where}`).get(...params).c
  return { executions: rows, total, limit, offset }
}
