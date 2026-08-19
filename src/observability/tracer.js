// observability/tracer.js —— 轻量 Span 追踪器（OpenTelemetry 概念兼容）
//
// 设计目标：
//   1. 零依赖，纯 SQLite 持久化
//   2. 兼容 OTel 核心概念：trace_id / span_id / parent_span_id / name / kind / status / attributes / events
//   3. 支持嵌套 span（LLM 调用 → 工具执行 → 记忆检索）
//   4. 内存缓冲 + 批量写库，不阻塞热路径
//   5. 可导出为 OTel JSON 格式（供 Langfuse / Phoenix 等平台导入）
//
// 使用方式：
//   const tracer = createTracer()
//   const span = tracer.startSpan('llm.call', { attributes: { model: 'gpt-4o' } })
//   // ... do work ...
//   span.end({ status: 'ok', attributes: { tokens: 100 } })
//   // 或用装饰器：tracer.trace('tool.exec', { tool: 'write_file' }, async () => { ... })

import crypto from 'crypto'
import { getDB } from '../db.js'

const SPAN_KIND = {
  INTERNAL: 0,
  SERVER: 1,
  CLIENT: 2,
  PRODUCER: 3,
  CONSUMER: 4,
}

const SPAN_STATUS = {
  UNSET: 0,
  OK: 1,
  ERROR: 2,
}

// 内存缓冲：批量写库，减少 SQLite 写锁竞争
const buffer = []
const FLUSH_INTERVAL_MS = 5000
const MAX_BUFFER_SIZE = 100
let flushTimer = null
let flushInProgress = false

function generateId(bytes = 8) {
  return crypto.randomBytes(bytes).toString('hex')
}

function nowIso() {
  return new Date().toISOString()
}

// ─── Span 类 ───────────────────────────────────────────────────────
class Span {
  constructor({ traceId, spanId, parentSpanId = null, name, kind = SPAN_KIND.INTERNAL, attributes = {} }) {
    this.trace_id = traceId
    this.span_id = spanId
    this.parent_span_id = parentSpanId
    this.name = name
    this.kind = kind
    this.status = SPAN_STATUS.UNSET
    this.attributes = { ...attributes }
    this.events = []
    this.start_time = nowIso()
    this.start_time_ms = Date.now()
    this.end_time = null
    this.duration_ms = null
    this._ended = false
  }

  setAttribute(key, value) {
    this.attributes[key] = value
    return this
  }

  addEvent(name, attributes = {}) {
    this.events.push({ name, timestamp: nowIso(), attributes })
    return this
  }

  setStatus(status, message = '') {
    this.status = typeof status === 'string'
      ? (SPAN_STATUS[status.toUpperCase()] ?? SPAN_STATUS.UNSET)
      : status
    if (message) this.attributes.status_message = message
    return this
  }

  end({ status, attributes = {} } = {}) {
    if (this._ended) return this
    this._ended = true
    this.end_time = nowIso()
    this.duration_ms = Date.now() - this.start_time_ms
    if (status) this.setStatus(status)
    Object.assign(this.attributes, attributes)
    buffer.push(this)
    if (buffer.length >= MAX_BUFFER_SIZE) flush()
    return this
  }

  // 派生嵌套子 span
  startChild(name, attributes = {}) {
    return new Span({
      traceId: this.trace_id,
      spanId: generateId(),
      parentSpanId: this.span_id,
      name,
      attributes,
    })
  }

  toJSON() {
    return {
      trace_id: this.trace_id,
      span_id: this.span_id,
      parent_span_id: this.parent_span_id,
      name: this.name,
      kind: this.kind,
      status: this.status,
      start_time: this.start_time,
      end_time: this.end_time,
      duration_ms: this.duration_ms,
      attributes: this.attributes,
      events: this.events,
    }
  }
}

// ─── Tracer 单例 ───────────────────────────────────────────────────
class Tracer {
  constructor() {
    this._currentTrace = null
  }

  // 开始一个新 trace（顶层 span）
  startSpan(name, { traceId = null, parentSpanId = null, kind = SPAN_KIND.INTERNAL, attributes = {} } = {}) {
    const tid = traceId || this._currentTrace || generateId(16)
    if (!this._currentTrace) this._currentTrace = tid
    return new Span({
      traceId: tid,
      spanId: generateId(),
      parentSpanId,
      name,
      kind,
      attributes,
    })
  }

  // 装饰器：自动 start/end，捕获异常
  async trace(name, options = {}, fn) {
    if (typeof options === 'function') { fn = options; options = {} }
    const span = this.startSpan(name, options)
    try {
      const result = await fn(span)
      span.end({ status: 'ok' })
      return result
    } catch (err) {
      span.end({ status: 'error', attributes: { error: err.message, error_type: err.name } })
      throw err
    }
  }

  // 设置当前 trace ID（用于跨函数传递）
  setCurrentTrace(traceId) {
    this._currentTrace = traceId
  }

  getCurrentTrace() {
    return this._currentTrace
  }

  clearCurrentTrace() {
    this._currentTrace = null
  }
}

export const tracer = new Tracer()

// ─── 持久化 ────────────────────────────────────────────────────────
export function initTracerSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trace_spans (
      trace_id       TEXT NOT NULL,
      span_id        TEXT NOT NULL,
      parent_span_id TEXT,
      name           TEXT NOT NULL,
      kind           INTEGER NOT NULL DEFAULT 0,
      status         INTEGER NOT NULL DEFAULT 0,
      start_time     TEXT NOT NULL,
      end_time       TEXT,
      duration_ms    INTEGER,
      attributes     TEXT NOT NULL DEFAULT '{}',
      events         TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (trace_id, span_id)
    );
    CREATE INDEX IF NOT EXISTS idx_trace_spans_trace ON trace_spans(trace_id);
    CREATE INDEX IF NOT EXISTS idx_trace_spans_name ON trace_spans(name);
    CREATE INDEX IF NOT EXISTS idx_trace_spans_start ON trace_spans(start_time DESC);
    CREATE INDEX IF NOT EXISTS idx_trace_spans_status ON trace_spans(status);
  `)
}

function flush() {
  if (flushInProgress || buffer.length === 0) return
  flushInProgress = true
  const batch = buffer.splice(0, buffer.length)
  try {
    const db = getDB()
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO trace_spans
        (trace_id, span_id, parent_span_id, name, kind, status, start_time, end_time, duration_ms, attributes, events)
      VALUES (@trace_id, @span_id, @parent_span_id, @name, @kind, @status, @start_time, @end_time, @duration_ms, @attributes, @events)
    `)
    const insertMany = db.transaction((spans) => {
      for (const s of spans) {
        stmt.run({
          ...s.toJSON(),
          attributes: JSON.stringify(s.attributes),
          events: JSON.stringify(s.events),
        })
      }
    })
    insertMany(batch)
  } catch (err) {
    console.warn('[tracer] flush failed:', err.message)
    // 写失败的 span 丢回缓冲区（避免无限增长，最多保留 200 条）
    if (buffer.length < 200) buffer.unshift(...batch)
  } finally {
    flushInProgress = false
  }
}

// 启动定时 flush
export function startTracerFlush() {
  if (flushTimer) return
  flushTimer = setInterval(flush, FLUSH_INTERVAL_MS)
  flushTimer.unref?.() // 不阻止进程退出
}

export function stopTracerFlush() {
  if (flushTimer) {
    clearInterval(flushTimer)
    flushTimer = null
  }
  flush() // 退出前刷一次
}

// ─── 查询 ──────────────────────────────────────────────────────────
export function getTraces({ limit = 20, offset = 0, status = null, name = null } = {}) {
  const db = getDB()
  const conditions = []
  const params = []
  if (status !== null) { conditions.push('status = ?'); params.push(Number(status)) }
  if (name) { conditions.push('name = ?'); params.push(name) }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  // 按 trace_id 分组，取每个 trace 的顶层 span（parent_span_id IS NULL）
  const rows = db.prepare(`
    SELECT trace_id, name, status, start_time, end_time, duration_ms, attributes
    FROM trace_spans
    ${where}
    ORDER BY start_time DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset)

  const total = db.prepare(`SELECT COUNT(*) AS c FROM trace_spans ${where}`).get(...params).c

  return {
    traces: rows.map(r => ({
      ...r,
      attributes: safeJson(r.attributes),
      status_name: statusName(r.status),
    })),
    total,
    limit,
    offset,
  }
}

export function getTraceDetail(traceId) {
  const db = getDB()
  const spans = db.prepare(`
    SELECT * FROM trace_spans WHERE trace_id = ? ORDER BY start_time ASC
  `).all(traceId)
  if (spans.length === 0) return null
  return {
    trace_id: traceId,
    span_count: spans.length,
    spans: spans.map(s => ({
      ...s,
      attributes: safeJson(s.attributes),
      events: safeJson(s.events),
      status_name: statusName(s.status),
    })),
  }
}

export function getSpanStats({ days = 1 } = {}) {
  const db = getDB()
  const n = Math.max(1, Math.min(Number(days) || 1, 365))
  const byName = db.prepare(`
    SELECT name, COUNT(*) AS count,
           AVG(duration_ms) AS avg_duration,
           MAX(duration_ms) AS max_duration,
           SUM(CASE WHEN status = 2 THEN 1 ELSE 0 END) AS error_count
    FROM trace_spans
    WHERE date(start_time) >= date('now', ?)
    GROUP BY name ORDER BY count DESC LIMIT 30
  `).all(`-${n - 1} days`)

  const totals = db.prepare(`
    SELECT COUNT(*) AS total_spans,
           SUM(CASE WHEN status = 1 THEN 1 ELSE 0 END) AS ok_count,
           SUM(CASE WHEN status = 2 THEN 1 ELSE 0 END) AS error_count,
           AVG(duration_ms) AS avg_duration
    FROM trace_spans
    WHERE date(start_time) >= date('now', ?)
  `).get(`-${n - 1} days`)

  return { days: n, by_name: byName, totals }
}

// 导出为 OTel JSON 格式（供 Langfuse / Phoenix 导入）
export function exportTracesOtel({ days = 1, limit = 100 } = {}) {
  const db = getDB()
  const n = Math.max(1, Math.min(Number(days) || 1, 365))
  const spans = db.prepare(`
    SELECT * FROM trace_spans
    WHERE date(start_time) >= date('now', ?)
    ORDER BY start_time DESC LIMIT ?
  `).all(`-${n - 1} days`, limit)

  const resourceSpans = {}
  for (const s of spans) {
    const tid = s.trace_id
    if (!resourceSpans[tid]) resourceSpans[tid] = []
    resourceSpans[tid].push({
      traceId: s.trace_id,
      spanId: s.span_id,
      parentSpanId: s.parent_span_id,
      name: s.name,
      kind: s.kind,
      startTimeUnixNano: new Date(s.start_time).getTime() * 1e6,
      endTimeUnixNano: s.end_time ? new Date(s.end_time).getTime() * 1e6 : null,
      attributes: Object.entries(safeJson(s.attributes)).map(([key, value]) => ({ key, value: { stringValue: String(value) } })),
      events: safeJson(s.events).map(e => ({
        name: e.name,
        timeUnixNano: new Date(e.timestamp).getTime() * 1e6,
        attributes: Object.entries(e.attributes || {}).map(([k, v]) => ({ key: k, value: { stringValue: String(v) } })),
      })),
      status: { code: s.status },
    })
  }

  return {
    resourceSpans: Object.entries(resourceSpans).map(([traceId, spanList]) => ({
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'bailongma' } }] },
      scopeSpans: [{ scope: { name: 'bailongma' }, spans: spanList }],
    })),
  }
}

function safeJson(str) {
  try { return JSON.parse(str) } catch { return {} }
}

function statusName(code) {
  return { 0: 'unset', 1: 'ok', 2: 'error' }[code] || 'unknown'
}

export { SPAN_KIND, SPAN_STATUS }
