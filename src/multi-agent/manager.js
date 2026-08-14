// 多 Agent 办公室 —— 会话与任务管理
// 每个 Agent 维护独立对话历史（内存 Map，可选持久化到 JSON）。
// 与 Agent 对话 = 用该 Agent 的人格 system prompt + 历史 调 LLM 完成。
import fs from 'fs'
import path from 'path'
import { runSimpleCompletion } from '../llm.js'
import { getAgentById } from './agents.js'
import { paths } from '../paths.js'
import { emitEvent } from '../events.js'

const HISTORY_FILE = path.join(paths.dataDir, 'agent-conversations.json')
const MAX_HISTORY = 30   // 每个 Agent 保留最近 N 条消息

// agentId -> [{ role: 'user'|'assistant', content, ts }]
let conversations = new Map()

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'))
      if (raw && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw)) {
          if (Array.isArray(v)) conversations.set(k, v)
        }
      }
    }
  } catch {}
}

function persistHistory() {
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true })
    const obj = Object.fromEntries(conversations)
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(obj), 'utf-8')
  } catch {}
}

export function getConversation(agentId, limit = MAX_HISTORY) {
  const list = conversations.get(agentId) || []
  return list.slice(-limit)
}

export function resetConversation(agentId) {
  conversations.set(agentId, [])
  persistHistory()
  return true
}

function appendMessage(agentId, role, content) {
  const list = conversations.get(agentId) || []
  list.push({ role, content: String(content || '').trim(), ts: new Date().toISOString() })
  conversations.set(agentId, list.slice(-MAX_HISTORY))
  persistHistory()
}

function buildAgentSystemPrompt(agent) {
  return [
    `你是「${agent.name}」，担任${agent.role}。`,
    agent.persona,
    agent.style,
    `你的专长：${agent.capabilities.join('、')}。`,
    `保持这个角色设定，用第一人称回答。回答要专业、具体、可执行；不确定就说明。`,
  ].join('\n')
}

// 与某个 Agent 对话，返回它的回复
export async function chatWithAgent(agentId, content) {
  const agent = getAgentById(agentId)
  if (!agent) throw new Error(`未知 Agent: ${agentId}`)
  const text = String(content || '').trim()
  if (!text) throw new Error('消息不能为空')

  appendMessage(agentId, 'user', text)
  const history = getConversation(agentId, MAX_HISTORY)
  const messages = [
    { role: 'system', content: buildAgentSystemPrompt(agent) },
    ...history.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content })),
  ]

  const reply = await runSimpleCompletion({ messages, temperature: 0.5, maxTokens: 1200 })
  const cleanReply = String(reply || '').trim() || '（该 Agent 未给出回复）'
  appendMessage(agentId, 'assistant', cleanReply)
  return { agentId, agentName: agent.name, role: agent.role, avatar: agent.avatar, reply: cleanReply }
}

// 向某个 Agent 布置任务（框架化为"任务请求"）
export async function assignTaskToAgent(agentId, task) {
  const agent = getAgentById(agentId)
  if (!agent) throw new Error(`未知 Agent: ${agentId}`)
  const taskText = String(task || '').trim()
  if (!taskText) throw new Error('任务不能为空')

  appendMessage(agentId, 'user', `【任务】${taskText}`)
  const messages = [
    { role: 'system', content: buildAgentSystemPrompt(agent) },
    ...getConversation(agentId, MAX_HISTORY).map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content })),
  ]
  // 任务请求要求产出物/方案，而不是闲聊
  const reply = await runSimpleCompletion({
    messages: [
      ...messages,
      { role: 'system', content: '这是一次任务布置。请直接给出可执行的任务产出（方案/清单/代码/步骤），不要只回"好的我收到了"。用结构化的方式交付。' },
    ],
    temperature: 0.4,
    maxTokens: 1600,
  })
  const cleanReply = String(reply || '').trim() || '（该 Agent 未给出任务产出）'
  appendMessage(agentId, 'assistant', cleanReply)
  emitEvent('agent_task', { agentId, agentName: agent.name, task: taskText })
  return { agentId, agentName: agent.name, role: agent.role, avatar: agent.avatar, reply: cleanReply, task: taskText }
}

loadHistory()
