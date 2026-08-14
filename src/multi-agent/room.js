// 多 Agent 军机处室 —— 共享会话 + 点名响应
// 皇上在军机处室发言 → 所有 Agent 在场；点名某位（名字/角色）→ 该 Agent 响应。
// 未点名时按话题/能力推断最相关的一位响应；都不确定则无人响应（皇上可再点名）。
import fs from 'fs'
import path from 'path'
import { AGENTS } from './agents.js'
import { getAgentConfig } from './config.js'
import { runAgentEngine } from './engines.js'
import { paths } from '../paths.js'
import { emitEvent } from '../events.js'

const ROOM_FILE = path.join(paths.dataDir, 'room-conversation.json')
const MAX_HISTORY = 60
const MAX_ROUNDS = 20   // 军机处最大轮次（主持人硬性上限，防死循环）

// 军机处室消息：{ role: 'boss'|'agent', agentId?, agentName?, avatar?, content, ts }
let history = []
let round = 0

function load() {
  try {
    if (fs.existsSync(ROOM_FILE)) {
      const raw = JSON.parse(fs.readFileSync(ROOM_FILE, 'utf-8'))
      history = Array.isArray(raw) ? raw : (raw.messages || [])
      round = Number(raw?.round || 0)
    }
  } catch { history = [] }
}
function persist() {
  try { fs.mkdirSync(path.dirname(ROOM_FILE), { recursive: true }); fs.writeFileSync(ROOM_FILE, JSON.stringify({ messages: history, round }), 'utf-8') } catch {}
}
function push(msg) {
  history.push(msg)
  history = history.slice(-MAX_HISTORY)
  persist()
}

export function getRoomHistory(limit = MAX_HISTORY) {
  return history.slice(-limit)
}
export function getMeetingRound() { return round }
export function resetRoom() {
  history = []
  round = 0
  persist()
}

// 点名检测：返回被点到的 Agent id 数组（名字/角色/@）
export function detectAddressedAgents(text) {
  const t = String(text || '').trim()
  const hits = []
  for (const a of AGENTS) {
    const pattern = new RegExp(
      `(?:@|给|叫|让|请|问|找)\s*${a.name}|${a.name}\s*[，,：:。!！？?]|\b${a.name}\b|(?:@|找|问|让|请|给)\s*${a.role}`
    )
    if (pattern.test(t)) hits.push(a.id)
  }
  return [...new Set(hits)]
}

// 按话题推断最相关 Agent：统计所有角色关键词命中，取得分最高者（避免顺序抢答）
function inferRelevantAgent(text) {
  const t = String(text || '')
  const roleMap = [
    { re: /需求|产品|用户|市场|优先级|功能/, id: 'pm', w: 1 },
    { re: /架构|选型|系统|扩展|权衡|设计/, id: 'architect', w: 1 },
    { re: /界面|前端|页面|交互|样式|ui/, id: 'frontend', w: 1 },
    { re: /接口|后端|数据库|服务|api|性能/, id: 'backend', w: 1 },
    { re: /测试|用例|质量|回归|验收|上线前/, id: 'qa', w: 2 },
    { re: /数据|统计|指标|图表|可视化/, id: 'data', w: 2 },
    { re: /文案|内容|营销|公众号|标题/, id: 'content', w: 1 },
  ]
  let best = null, bestScore = 0
  for (const { re, id, w } of roleMap) {
    const hits = (t.match(re) || []).length
    if (hits * w > bestScore) { bestScore = hits * w; best = id }
  }
  if (bestScore > 0) return best
  // 能力词命中
  for (const a of AGENTS) {
    let score = 0
    for (const cap of (a.capabilities || [])) if (t.includes(cap)) score += 1
    if (score > bestScore) { bestScore = score; best = a.id }
  }
  return bestScore > 0 ? best : null
}

// 皇上发言 → 点名/推断 → 让对应 Agent 响应
export async function bossSpeak(content) {
  const text = String(content || '').trim()
  if (!text) throw new Error('发言不能为空')

  // 军机处轮次限制（主持人硬性上限 20 轮）
  if (round >= MAX_ROUNDS) {
    return { ok: true, forced_end: true, hint: `军机处已达 ${MAX_ROUNDS} 轮上限，本轮强制结束。可清空军机处室（/room/reset）重新开会。`, responses: [] }
  }
  round += 1
  push({ role: 'boss', content: text, ts: new Date().toISOString() })

  let targets = detectAddressedAgents(text)
  if (!targets.length) {
    const inferred = inferRelevantAgent(text)
    if (inferred) targets = [inferred]
  }
  if (!targets.length) {
    return { ok: true, no_target: true, hint: '我在场但没听到你点我。你可以点名，比如"主持人，开会：…""白龙马，你怎么看？"或"让Claude Code开发"。', responses: [] }
  }

  // 开会编排：点名主持人或消息含"开会/军机处" → 主持人先拆解，总经理白龙马跟着牵头统筹
  const isMeeting = /开会|军机处|启动|开始|部署|搭建|立项/.test(text)
  if (isMeeting && !targets.includes('host')) targets.unshift('host')
  if (isMeeting && targets.includes('host') && !targets.includes('gm')) targets.push('gm')

  const responses = []
  for (const agentId of targets.slice(0, 3)) {
    const agent = getAgentConfig(agentId)
    const roomCtx = getRoomHistory(MAX_HISTORY)
    try {
      const reply = await runAgentEngine(agentId, roomCtx, text, false)
      push({ role: 'agent', agentId, agentName: agent.name, avatar: agent.avatar, content: reply, ts: new Date().toISOString() })
      if (agent.voice?.enabled) emitEvent('agent_tts', { agentId, text: reply.slice(0, 300) })
      responses.push({ agentId, agentName: agent.name, avatar: agent.avatar, role: agent.role, reply })
    } catch (err) {
      responses.push({ agentId, agentName: agent.name, avatar: agent.avatar, reply: '（响应失败：' + err.message + '）', error: true })
    }
  }
  return { ok: true, no_target: false, round, responses }
}

// 给某 Agent 布置任务
export async function assignTask(agentId, task) {
  const agent = getAgentConfig(agentId)
  if (!agent) throw new Error(`未知 Agent: ${agentId}`)
  const taskText = String(task || '').trim()
  if (!taskText) throw new Error('任务不能为空')
  push({ role: 'boss', content: `【布置任务给 ${agent.name}】${taskText}`, ts: new Date().toISOString() })
  const reply = await runAgentEngine(agentId, getRoomHistory(MAX_HISTORY), taskText, true)
  push({ role: 'agent', agentId, agentName: agent.name, avatar: agent.avatar, content: reply, ts: new Date().toISOString() })
  if (agent.voice?.enabled) emitEvent('agent_tts', { agentId, text: reply.slice(0, 300) })
  return { agentId, agentName: agent.name, avatar: agent.avatar, role: agent.role, reply }
}

load()
