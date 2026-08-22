// trace.js —— 多Agent办公室 执行轨迹（B'）：记录每个角色干活时的真实动作
// 粒度比台账更细：引擎启动、工具调用、工具结果、命令、A2A 调用、回复、错误。
// 供「执行轨迹」页签做时间线展示：老板能看清"信息传递"背后每个角色到底做了什么。
import fs from 'fs'
import path from 'path'
import { paths } from '../paths.js'
import { emitEvent } from '../events.js'

const TRACE_FILE = path.join(paths.dataDir, 'agent-traces.json')
const MAX_PER_AGENT = 60   // 每位 agent 最多保留 60 条
const MAX_TOTAL = 400

let traces = []   // [{ts, agentId, agentName, kind, tool, detail, ok, ms}]

function load() {
  try {
    if (fs.existsSync(TRACE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(TRACE_FILE, 'utf-8'))
      traces = Array.isArray(raw) ? raw : []
    }
  } catch { traces = [] }
}
function persist() {
  try { fs.mkdirSync(path.dirname(TRACE_FILE), { recursive: true }); fs.writeFileSync(TRACE_FILE, JSON.stringify(traces, null, 2), 'utf-8') } catch (e) { console.warn('[src/multi-agent/trace.js] op failed:', e?.message || e) }
}

/**
 * 记录一条执行轨迹并实时推给前端（office_trace）。
 * kind: engine | tool_call | tool_result | command | a2a | reply | error
 */
export function recordTrace({ agentId = '', agentName = '', kind = '', tool = '', detail = '', ok = true, ms = 0 }) {
  if (!agentId) return null
  const entry = {
    ts: new Date().toISOString(),
    agentId,
    agentName: String(agentName || ''),
    kind: String(kind || ''),
    tool: String(tool || '').slice(0, 80),
    detail: String(detail || '').slice(0, 300),
    ok: !!ok,
    ms: Number(ms) || 0,
  }
  traces.push(entry)
  // 每 agent 限 60 条；总限 400 条（保留最新）
  const count = {}
  traces = traces.filter(e => {
    count[e.agentId] = (count[e.agentId] || 0) + 1
    return count[e.agentId] <= MAX_PER_AGENT
  }).slice(-MAX_TOTAL)
  persist()
  try { emitEvent('office_trace', entry) } catch (e) { console.warn('[src/multi-agent/trace.js] op failed:', e?.message || e) }
  return entry
}

// 取轨迹（可按 agentId 过滤，最新在前）
export function getTraces(agentId = null, limit = 40) {
  const list = agentId ? traces.filter(e => e.agentId === agentId) : traces
  return list.slice(-Math.max(1, Number(limit) || 40)).reverse()
}

export function clearTraces() { traces = []; persist() }

load()
