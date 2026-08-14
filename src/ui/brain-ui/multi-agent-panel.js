// multi-agent-panel.js —— 多 Agent 军机处（数字臣工）
// 所有 Agent 在座（有形象/语音/引擎配置）；皇上发言全员可听，点名某位才响应。
// 点臣工头像可配置：形象、语音、引擎（internal/custom/cli）、大模型。
import { API } from './api-client.js'

const $ = (id) => document.getElementById(id)
let agents = []
let configAgentId = null
let speaking = false
let voiceOn = localStorage.getItem('bailongma-junjichu-voice') === '1'

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
  } catch { $('ma-seats').innerHTML = '<div class="ma-seats-hint">臣工加载失败</div>' }
}

function renderSeats() {
  const seats = $('ma-seats')
  seats.innerHTML = `<span class="ma-seats-label">👥 在座成员（点击头像配置）</span>` +
    agents.map(a => `
      <div class="ma-seat" data-id="${esc(a.id)}" title="${esc(a.name)} · ${esc(a.role)} · ${esc(a.engine)}引擎 · 点击配置">
        <span class="ma-seat-avatar" style="--ac:${esc(a.color)};background-image:${a.avatar_image ? `url('${esc(a.avatar_image)}')` : 'none'}">${a.avatar_image ? '' : esc(a.avatar)}</span>
        <span class="ma-seat-online"></span>
        <span class="ma-seat-name">${esc(a.name)}</span>
        <span class="ma-seat-role">${esc(a.role)}</span>
      </div>`).join("")
  seats.querySelectorAll("[data-id]").forEach(el => el.addEventListener("click", () => openConfig(el.dataset.id)))
}

async function loadRoom() {
  const box = $('ma-messages')
  box.innerHTML = '<div class="ma-loading">军机处加载中…</div>'
  try {
    const data = await api('/room')
    const msgs = data.messages || []
    const round = data.round || 0
    const roundEl = $('ma-round')
    if (roundEl) roundEl.textContent = `轮次 ${round}/${20}`
    box.innerHTML = ''
    if (!msgs.length) box.innerHTML = '<div class="ma-empty">军机处空着。你是皇上，说点什么吧——点名某位臣工他就会回答。\n\n💡 开会示例：「主持人，开会：搭建一套企业微信机器人自动采集群消息的多Agent调度系统」\n点名示例：「Claude Code，先出个架构设计」</div>'
    else { msgs.forEach(m => renderRoomMsg(m)); box.scrollTop = box.scrollHeight }
  } catch { box.innerHTML = '<div class="ma-empty">军机处加载失败</div>' }
}

// 语音：若开关打开，播放该 Agent 回复（经 CustomEvent 交给 app.js 的 TTS）
function speak(text) {
  if (!voiceOn || !text) return
  window.dispatchEvent(new CustomEvent('bailongma:speak', { detail: { text: String(text).slice(0, 300) } }))
}
function syncVoiceBtn() {
  const btn = $('ma-voice-toggle')
  if (btn) btn.textContent = voiceOn ? '🔊' : '🔇'
}

function fmtTime(ts) {
  if (!ts) return ''
  try {
    const d = new Date(ts)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  } catch { return '' }
}

function renderRoomMsg(m) {
  const box = $('ma-messages')
  if (m.role === 'boss') {
    const div = document.createElement('div')
    div.className = 'ma-msg ma-msg-boss'
    div.innerHTML = `
      <div class="ma-boss-block">
        <span class="ma-boss-label">👑 皇上</span><span class="ma-time">${fmtTime(m.ts)}</span>
        <div class="ma-bubble">${esc(m.content)}</div>
      </div>`
    box.appendChild(div)
  } else {
    const agent = agents.find(a => a.id === m.agentId)
    const avatar = (m.avatar || agent?.avatar || '🤖')
    const image = (agent?.avatar_image || '')
    const color = agent?.color || '#888'
    const roleLabel = agent?.role || m.role || ''
    const div = document.createElement('div')
    div.className = 'ma-msg ma-msg-agent'
    div.innerHTML = `
      <span class="ma-bubble-avatar" style="--ac:${esc(color)};background-image:${image ? `url('${esc(image)}')` : 'none'}">${image ? '' : esc(avatar)}</span>
      <div class="ma-agent-msg-block">
        <span class="ma-agent-msg-name">${esc(m.agentName || '臣工')}</span>
        <span class="ma-agent-msg-role" style="--ac:${esc(color)}">${esc(roleLabel)}</span>
        <span class="ma-time">${fmtTime(m.ts)}</span>
        <div class="ma-bubble">${esc(m.content)}</div>
      </div>`
    box.appendChild(div)
  }
}

// ── 皇上发言 ──
async function bossSpeak() {
  if (speaking) return
  const input = $('ma-input')
  const text = input.value.trim()
  if (!text) return
  speaking = true
  input.value = ''
  renderRoomMsg({ role: 'boss', content: text, ts: new Date().toISOString() })
  // 下旨/立项 → 走三省六部流水线
  if (/^(下旨|立项|发布任务|开个项目|启动项目)[:：\s]/.test(text)) {
    const loading = document.createElement('div')
    loading.className = 'ma-msg ma-msg-hint'
    loading.textContent = '⚙️ 已接旨，三省六部流水线启动（分拣→规划→审议→派发→执行→回奏）…'
    $('ma-messages').appendChild(loading)
    try {
      const data = await api('/task', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: text.replace(/^(下旨|立项|发布任务|开个项目|启动项目)[:：\s]+/, '') }) })
      loading.textContent = ''
      const t = data.task
      loading.className = 'ma-msg ma-msg-hint'
      loading.textContent = `✅ ${t.id} 状态：${STATUS_LABEL[t.status] || t.status}${t.status === 'rejected' ? '（' + (t.review?.note || '被封驳') + '）' : ''}。点「📜 军机处」看完整奏折。`
      if (t.status === 'done') renderRoomMsg({ role: 'agent', agentId: 'gm', agentName: '回奏', content: (t.report || '').slice(0, 400) })
    } catch (err) { loading.textContent = '下旨失败：' + err.message }
    $('ma-messages').scrollTop = $('ma-messages').scrollHeight
    if (!$('ma-kanban').hidden) loadKanban()
    speaking = false
    return
  }
  const loading = document.createElement('div')
  loading.className = 'ma-msg ma-msg-agent'
  loading.innerHTML = `<span class="ma-bubble-avatar">⏳</span><div class="ma-agent-msg-block"><span class="ma-agent-msg-name">在朝的臣工</span><div class="ma-bubble">（思考中…）</div></div>`
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
      (data.responses || []).forEach(r => { renderRoomMsg({ role: 'agent', agentId: r.agentId, agentName: r.agentName, avatar: r.avatar, content: r.reply }); speak(r.reply) })
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
  const task = prompt('给这位臣工布置什么任务？')
  if (!task) return
  $('ma-config-overlay').hidden = true
  renderRoomMsg({ role: 'boss', content: `【布置任务给 ${agents.find(a => a.id === configAgentId)?.name}】${task}` })
  try {
    const data = await api(`/agents/${configAgentId}/task`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task }) })
    renderRoomMsg({ role: 'agent', agentId: data.agentId, agentName: data.agentName, avatar: data.avatar, content: data.reply })
    speak(data.reply)
  } catch (err) { alert('布置失败：' + err.message) }
}

// ── 军机处看板 ──
const STATUS_LABEL = { pending: '待分拣', planning: '规划中', review: '审议中', executing: '执行中', done: '已完成', rejected: '已封驳', cancelled: '已取消', paused: '已暂停', error: '异常' }

async function loadKanban() {
  const body = $('ma-kanban-body')
  if (!body) return
  try {
    const data = await api('/task')
    const tasks = data.tasks || []
    body.innerHTML = ''
    if (!tasks.length) { body.innerHTML = '<div class="ma-kanban-empty">暂无任务。说「下旨：做一个XX系统」启动三省六部流水线。</div>'; return }
    tasks.forEach(t => body.appendChild(renderTaskCard(t)))
  } catch { body.innerHTML = '<div class="ma-kanban-empty">看板加载失败</div>' }
}

function renderTaskCard(t) {
  const card = document.createElement('div')
  card.className = 'ma-task-card'
  const status = t.status || 'pending'
  card.innerHTML = `
    <div class="ma-task-top">
      <span class="ma-task-id">${esc(t.id)}</span>
      <span class="ma-task-status st-${esc(status)}">${esc(STATUS_LABEL[status] || status)}</span>
    </div>
    <div class="ma-task-title">${esc(t.content)}</div>
    <div class="ma-task-meta">${t.domain ? '分拣:' + esc(t.domain) + ' · ' : ''}执行:${esc(t.executor || '待派发')}</div>
    <div class="ma-task-log" hidden></div>
    <div class="ma-task-actions">
      <button class="ma-ta-toggle" type="button">📜 奏折</button>
      ${t.status === 'paused' ? '<button class="ma-ta-ctl" data-ctl="resume" type="button">恢复</button>' : ''}
      ${t.status === 'executing' ? '<button class="ma-ta-ctl" data-ctl="pause" type="button">暂停</button>' : ''}
      ${['pending','planning','review','executing','paused'].includes(t.status) ? '<button class="ma-ta-ctl" data-ctl="cancel" type="button">取消</button>' : ''}
      ${t.status === 'review' ? '<button class="ma-ta-rev" data-pass="true" type="button">通过</button><button class="ma-ta-rev" data-pass="false" type="button">封驳</button>' : ''}
    </div>`
  // 奏折展开
  card.querySelector('.ma-ta-toggle').addEventListener('click', () => {
    const logEl = card.querySelector('.ma-task-log')
    if (logEl.hidden) {
      logEl.innerHTML = (t.log || []).map(e => `<div class="ma-log-line"><b>${esc(e.stage)}·${esc(e.agent)}</b><span>${esc(String(e.content||'').slice(0, 180))}</span></div>`).join('') || '<div class="ma-log-empty">（无记录）</div>'
      logEl.hidden = false
    } else logEl.hidden = true
  })
  // 干预
  card.querySelectorAll('.ma-ta-ctl').forEach(btn => btn.addEventListener('click', async () => {
    await api(`/task/${t.id}/control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: btn.dataset.ctl }) })
    loadKanban()
  }))
  // 审议
  card.querySelectorAll('.ma-ta-rev').forEach(btn => btn.addEventListener('click', async () => {
    const pass = btn.dataset.pass === 'true'
    const note = pass ? '' : prompt('封驳理由：') || ''
    await api(`/task/${t.id}/review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pass, note }) })
    loadKanban()
  }))
  return card
}

function toggleKanban(show) {
  const kb = $('ma-kanban')
  if (!kb) return
  kb.hidden = !show
  if (show) loadKanban()
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
  $('ma-end-meet')?.addEventListener('click', endMeeting)
  $('ma-kanban-toggle')?.addEventListener('click', () => toggleKanban($('ma-kanban').hidden))
  $('ma-kanban-close')?.addEventListener('click', () => toggleKanban(false))
  $('ma-kanban-refresh')?.addEventListener('click', loadKanban)
  $('ma-voice-toggle')?.addEventListener('click', () => {
    voiceOn = !voiceOn
    localStorage.setItem('bailongma-junjichu-voice', voiceOn ? '1' : '0')
    syncVoiceBtn()
  })
  syncVoiceBtn()
  loadAgents()
  loadRoom()
}

// 结束会议：写入终止标记 + 重置军机处
async function endMeeting() {
  const box = $('ma-messages')
  const close = document.createElement('div')
  close.className = 'ma-msg ma-msg-hint'
  close.textContent = '【集团全部任务已闭环，本次虚拟办公室会议正式结束】'
  box.appendChild(close)
  try { await api('/room/reset', { method: 'POST' }) } catch {}
  const roundEl = $('ma-round')
  if (roundEl) roundEl.textContent = '轮次 0/20'
  // 提示重新开会
  const tip = document.createElement('div')
  tip.className = 'ma-msg ma-msg-hint'
  tip.textContent = '军机处已归档重置。有新的任务就说「主持人，开会：…」'
  box.appendChild(tip)
  box.scrollTop = box.scrollHeight
}

export function openMultiAgentPanel() {
  const panel = $('multiagent-panel')
  if (!panel) return
  panel.hidden = false
  if (!agents.length) loadAgents()
  loadRoom()
}
export function closeMultiAgentPanel() {
  const panel = $('multiagent-panel')
  if (panel) panel.hidden = true
}
export function refreshJunjichuKanban() {
  if ($('ma-kanban') && !$('ma-kanban').hidden) loadKanban()
}
