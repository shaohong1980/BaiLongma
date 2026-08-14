// multi-agent-panel.js —— 多 Agent 办公室（参考 MetaGPT/CrewAI）
// 展示一排有形象的 Agent，可点击对话、布置任务，每个 Agent 独立人格与对话历史。
import { API } from './api-client.js'

const $ = (id) => document.getElementById(id)

let agents = []
let selectedId = null
let sending = false

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

async function loadAgents() {
  const roster = $('multiagent-roster')
  try {
    const res = await fetch(`${API}/agents`)
    const data = await res.json()
    agents = data.agents || []
    renderRoster()
  } catch {
    if (roster) roster.innerHTML = '<div class="multiagent-roster-hint">Agent 列表加载失败</div>'
  }
}

function renderRoster() {
  const roster = $('multiagent-roster')
  if (!roster) return
  roster.innerHTML = agents.map(a => `
    <button class="ma-agent-card ${a.id === selectedId ? 'active' : ''}" data-id="${esc(a.id)}">
      <span class="ma-avatar" style="--ac:${esc(a.color)}">${esc(a.avatar)}</span>
      <span class="ma-agent-info">
        <span class="ma-agent-name">${esc(a.name)}</span>
        <span class="ma-agent-role">${esc(a.role)}</span>
      </span>
    </button>`).join("")
  roster.querySelectorAll("[data-id]").forEach(btn => {
    btn.addEventListener("click", () => selectAgent(btn.dataset.id))
  })
}

function selectAgent(id) {
  selectedId = id
  renderRoster()
  const agent = agents.find(a => a.id === id)
  const head = $('ma-chat-head')
  const placeholder = $('ma-chat-placeholder')
  if (head) head.hidden = false
  if (placeholder) placeholder.hidden = true
  if (agent) {
    $('ma-avatar').textContent = agent.avatar
    $('ma-avatar').style.setProperty('--ac', agent.color)
    $('ma-name').textContent = `${agent.name} · ${agent.role}`
    $('ma-role').textContent = agent.description || ''
    $('ma-cap').textContent = (agent.capabilities || []).join(' · ')
  }
  loadMessages(id)
}

async function loadMessages(id) {
  const box = $('ma-messages')
  box.innerHTML = '<div class="ma-loading">加载对话…</div>'
  try {
    const res = await fetch(`${API}/agents/${encodeURIComponent(id)}/messages`)
    const data = await res.json()
    const msgs = data.messages || []
    box.innerHTML = ''
    if (!msgs.length) {
      box.innerHTML = '<div class="ma-empty">还没有对话。发条消息，或点「布置任务」派活。</div>'
      return
    }
    for (const m of msgs) appendMessageBubble(m.role, m.content, false)
    box.scrollTop = box.scrollHeight
  } catch {
    box.innerHTML = '<div class="ma-empty">对话加载失败</div>'
  }
}

function appendMessageBubble(role, content, scroll = true) {
  const box = $('ma-messages')
  const agent = agents.find(a => a.id === selectedId)
  const isUser = role === 'user'
  const div = document.createElement('div')
  div.className = `ma-msg ${isUser ? 'ma-msg-user' : 'ma-msg-agent'}`
  if (!isUser && agent) {
    const av = document.createElement('span')
    av.className = 'ma-bubble-avatar'
    av.textContent = agent.avatar
    div.appendChild(av)
  }
  const bubble = document.createElement('div')
  bubble.className = 'ma-bubble'
  bubble.textContent = content
  div.appendChild(bubble)
  box.appendChild(div)
  if (scroll) box.scrollTop = box.scrollHeight
  return bubble
}

async function sendMessage(isTask) {
  if (!selectedId || sending) return
  const input = $('ma-input')
  const text = input.value.trim()
  if (!text) return
  sending = true
  const agent = agents.find(a => a.id === selectedId)
  input.value = ''
  appendMessageBubble('user', text)
  const loading = appendMessageBubble('assistant', '（思考中…）')
  try {
    const url = isTask
      ? `${API}/agents/${encodeURIComponent(selectedId)}/task`
      : `${API}/agents/${encodeURIComponent(selectedId)}/message`
    const payload = isTask ? { task: text } : { content: text }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const data = await res.json()
    loading.textContent = data.ok ? (data.reply || '(空)') : ('错误：' + (data.error || '未知'))
  } catch (err) {
    loading.textContent = '发送失败：' + err.message
  }
  $('ma-messages').scrollTop = $('ma-messages').scrollHeight
  sending = false
}

export function initMultiAgentPanel() {
  $('multiagent-exit')?.addEventListener('click', () => { $('multiagent-panel').hidden = true })
  $('ma-send')?.addEventListener('click', () => sendMessage(false))
  $('ma-task')?.addEventListener('click', () => sendMessage(true))
  $('ma-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(false) }
  })
  $('ma-reset')?.addEventListener('click', async () => {
    if (!selectedId) return
    await fetch(`${API}/agents/${encodeURIComponent(selectedId)}/reset`, { method: 'POST' })
    loadMessages(selectedId)
  })
  loadAgents()
}

// 供外部（如 app.js 里的按钮/斜杠命令）打开办公室
export function openMultiAgentPanel() {
  const panel = $('multiagent-panel')
  if (panel) {
    panel.hidden = false
    if (!agents.length) loadAgents()
  }
}
