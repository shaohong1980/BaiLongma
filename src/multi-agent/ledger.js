// ledger.js —— 每 Agent 工作台账（B）：记录每个角色做了什么、结果、耗时
// 对应 Star-Office-UI 的"谁在干嘛 / 昨天干了啥"：办公室 UI 可展示每位员工的近期完成。
import fs from 'fs'
import path from 'path'
import { paths } from '../paths.js'

const LEDGER_FILE = path.join(paths.dataDir, 'agent-ledger.json')
const MAX_PER_AGENT = 30   // 每位 agent 最多保留 30 条
const MAX_TOTAL = 200

let entries = []   // [{ts, agentId, agentName, task, result, ms}]

function load() {
  try {
    if (fs.existsSync(LEDGER_FILE)) {
      const raw = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf-8'))
      entries = Array.isArray(raw) ? raw : []
    }
  } catch { entries = [] }
}
function persist() {
  try { fs.mkdirSync(path.dirname(LEDGER_FILE), { recursive: true }); fs.writeFileSync(LEDGER_FILE, JSON.stringify(entries, null, 2), 'utf-8') } catch (e) { console.warn('[src/multi-agent/ledger.js] op failed:', e?.message || e) }
}

// 记录一次 agent 活动
export function recordActivity({ agentId = '', agentName = '', task = '', result = '', ms = 0 }) {
  if (!agentId) return
  entries.push({
    ts: new Date().toISOString(),
    agentId,
    agentName: String(agentName || ''),
    task: String(task || '').slice(0, 200),
    result: String(result || '').slice(0, 300),
    ms: Number(ms) || 0,
  })
  // 每 agent 限 30 条；总限 200 条
  const count = {}
  entries = entries.filter(e => {
    count[e.agentId] = (count[e.agentId] || 0) + 1
    return count[e.agentId] <= MAX_PER_AGENT
  }).slice(-MAX_TOTAL)
  persist()
}

// 取台账（可按 agentId 过滤，最新在前）
export function getLedger(agentId = null, limit = 20) {
  const list = agentId ? entries.filter(e => e.agentId === agentId) : entries
  return list.slice(-Math.max(1, Number(limit) || 20)).reverse()
}

export function clearLedger() { entries = []; persist() }

load()
