// multi-agent-panel.js —— 多 Agent 会议室（数字员工）
// 所有 Agent 在座（有形象/语音/引擎配置）；老板发言全员可听，点名某位才响应。
// 点员工头像可配置：形象、语音、引擎（internal/custom/cli）、大模型。
import { API } from './api-client.js'

const $ = (id) => document.getElementById(id)
let agents = []
let configAgentId = null
let speaking = false

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

async function api(path, opts = {}) {
  const res = await fetch(API + path, opts)
  return res.json()
}

// ── 加载 / 渲染 ──
async function loadAgents() {
  try {
    const data = await api('/agents')
    agents = data.agents || []
    renderSeats()
  } catch { $('ma-seats').innerHTML = '<div class="ma-seats-hint">员工加载失败</div>' }
}

function renderSeats() {
  const seats = $('ma-seats')
  seats.innerHTML = `<div class="ma-seats-label">在座的数字员工</div>` +
    agents.map(a => `
      <div class="ma-seat" data-id="${esc(a.id)}" title="${esc(a.name)} · ${esc(a.role)} · 点击配置">
        <span class="ma-seat-avatar" style="--ac:${esc(a.color)};background-image:${a.avatar_image ? `url('${esc(a.avatar_image)}')` : 'none'}">${a.avatar_image ? '' : esc(a.avatar)}</span>
        <span class="ma-seat-name">${esc(a.name)}</span>
        <span class="ma-seat-role">${esc(a.role)}</span>
        <span class="ma-seat-engine" title="引擎:${esc(a.engine)}">${esc(a.engine)}</span>
      </div>`).join("")
  seats.querySelectorAll("[data-id]").forEach(el => el.addEventListener("click", () => openConfig(el.dataset.id)))
}

async function loadRoom() {
  const box = $('ma-messages')
  box.innerHTML = '<div class="ma-loading">会议室加载中…</div>'
  try {
    const data = await api('/room')
    const msgs = data.messages || []
    const round = data.round || 0
    const roundEl = $('ma-round')
    if (roundEl) roundEl.textContent = `轮次 ${round}/${20}`
    box.innerHTML = ''
    if (!msgs.length) box.innerHTML = '<div class="ma-empty">会议室空着。你是董事长，说点什么吧——点名某位员工他就会回答。\n\n💡 开会示例：「主持人，开会：搭建一套企业微信机器人自动采集群消息的多Agent调度系统」\n点名示例：「Claude Code，先出个架构设计」</div>'
    else { msgs.forEach(m => renderRoomMsg(m)); box.scrollTop = box.scrollHeight }
  } catch { box.innerHTML = '<div class="ma-empty">会议室加载失败</div>' }
}

function renderRoomMsg(m) {
  const box = $('ma-messages')
  if (m.role === 'boss') {
    const div = document.createElement('div')
    div.className = 'ma-msg ma-msg-boss'
    div.innerHTML = `<span class="ma-boss-label">老板</span><div class="ma-bubble">${esc(m.content)}</div>`
    box.appendChild(div)
  } else {
    const agent = agents.find(a => a.id === m.agentId)
    const avatar = (m.avatar || agent?.avatar || '🤖')
    const image = (agent?.avatar_image || '')
    const color = agent?.color || '#888'
    const div = document.createElement('div')
    div.className = 'ma-msg ma-msg-agent'
    div.innerHTML = `
      <span class="ma-bubble-avatar" style="--ac:${esc(color)};background-image:${image ? `url('${esc(image)}')` : 'none'}">${image ? '' : esc(avatar)}</span>
      <div class="ma-agent-msg-block">
        <span class="ma-agent-msg-name">${esc(m.agentName || '员工')}</span>
        <div class="ma-bubble">${esc(m.content)}</div>
      </div>`
    box.appendChild(div)
  }
}

// ── 老板发言 ──
async function bossSpeak() {
  if (speaking) return
  const input = $('ma-input')
  const text = input.value.trim()
  if (!text) return
  speaking = true
  input.value = ''
  renderRoomMsg({ role: 'boss', content: text })
  const loading = document.createElement('div')
  loading.className = 'ma-msg ma-msg-agent'
  loading.innerHTML = `<span class="ma-bubble-avatar">⏳</span><div class="ma-agent-msg-block"><span class="ma-agent-msg-name">在座的员工</span><div class="ma-bubble">（思考中…）</div></div>`
  $('ma-messages').appendChild(loading)
  $('ma-messages').scrollTop = $('ma-messages').scrollHeight
  try {
    const data = await api('/room/message', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: text }) })
    loading.remove()
    const roundEl = $('ma-round')
    if (roundEl && data.round) roundEl.textContent = `轮次 ${data.round}/${20}`
    if (data.forced_end) {
      const div = document.createElement('div')
      div.className = 'ma-msg ma-msg-hint'
      div.textContent = data.hint || '会议已达轮次上限'
      $('ma-messages').appendChild(div)
    } else if (data.no_target) {
      const div = document.createElement('div')
      div.className = 'ma-msg ma-msg-hint'
      div.textContent = data.hint || ''
      $('ma-messages').appendChild(div)
    } else {
      (data.responses || []).forEach(r => renderRoomMsg({ role: 'agent', agentId: r.agentId, agentName: r.agentName, avatar: r.avatar, content: r.reply }))
    }
  } catch (err) {
    loading.textContent = '发言失败：' + err.message
  }
  $('ma-messages').scrollTop = $('ma-messages').scrollHeight
  speaking = false
}

// ── Agent 配置 ──
function openConfig(id) {
  configAgentId = id
  const a = agents.find(x => x.id === id)
  if (!a) return
  $('ma-config-overlay').hidden = false
  $('ma-config-title').textContent = `配置 ${a.name}（${a.role}）`
  $('cfg-avatar').value = a.avatar || ''
  $('cfg-avatar-image').value = a.avatar_image || ''
  $('cfg-name').value = a.name || ''
  $('cfg-role').value = a.role || ''
  $('cfg-engine').value = a.engine || 'internal'
  $('cfg-base-url').value = a.base_url || ''
  $('cfg-api-key').value = ''
  $('cfg-model').value = a.model || ''
  $('cfg-cli-command').value = a.cli_command || ''
  $('cfg-temperature').value = a.temperature ?? 0.5
  $('cfg-voice-enabled').checked = !!a.voice?.enabled
  $('cfg-voice-id').value = a.voice?.voiceId || ''
  $('cfg-private-memory').value = a.private_memory || ''
  syncEngineFields()
}

function syncEngineFields() {
  const eng = $('cfg-engine').value
  $('cfg-custom-fields').hidden = eng !== 'custom'
  $('cfg-cli-fields').hidden = eng !== 'cli'
}

async function saveConfig() {
  if (!configAgentId) return
  const body = {
    avatar: $('cfg-avatar').value.trim(),
    avatar_image: $('cfg-avatar-image').value.trim(),
    name: $('cfg-name').value.trim(),
    role: $('cfg-role').value.trim(),
    engine: $('cfg-engine').value,
    base_url: $('cfg-base-url').value.trim(),
    model: $('cfg-model').value.trim(),
    cli_command: $('cfg-cli-command').value.trim(),
    temperature: Number($('cfg-temperature').value) || 0.5,
    voice: { enabled: $('cfg-voice-enabled').checked, voiceId: $('cfg-voice-id').value.trim() },
    private_memory: $('cfg-private-memory').value.trim(),
  }
  const key = $('cfg-api-key').value.trim()
  if (key) body.api_key = key
  try {
    await api(`/agents/${configAgentId}/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    $('ma-config-overlay').hidden = true
    await loadAgents()
  } catch (err) { alert('保存失败：' + err.message) }
}

async function assignTaskFromConfig() {
  if (!configAgentId) return
  const task = prompt('给这位员工布置什么任务？')
  if (!task) return
  $('ma-config-overlay').hidden = true
  renderRoomMsg({ role: 'boss', content: `【布置任务给 ${agents.find(a => a.id === configAgentId)?.name}】${task}` })
  try {
    const data = await api(`/agents/${configAgentId}/task`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task }) })
    renderRoomMsg({ role: 'agent', agentId: data.agentId, agentName: data.agentName, avatar: data.avatar, content: data.reply })
  } catch (err) { alert('布置失败：' + err.message) }
}

export function initMultiAgentPanel() {
  $('multiagent-exit')?.addEventListener('click', () => { $('multiagent-panel').hidden = true })
  $('ma-send')?.addEventListener('click', bossSpeak)
  $('ma-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); bossSpeak() } })
  $('ma-config-close')?.addEventListener('click', () => { $('ma-config-overlay').hidden = true })
  $('ma-config-cancel')?.addEventListener('click', () => { $('ma-config-overlay').hidden = true })
  $('ma-config-save')?.addEventListener('click', saveConfig)
  $('ma-config-task')?.addEventListener('click', assignTaskFromConfig)
  $('cfg-engine')?.addEventListener('change', syncEngineFields)
  loadAgents()
  loadRoom()
}

export function openMultiAgentPanel() {
  const panel = $('multiagent-panel')
  if (!panel) return
  panel.hidden = false
  if (!agents.length) loadAgents()
  loadRoom()
}
