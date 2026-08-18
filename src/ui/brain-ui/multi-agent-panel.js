// multi-agent-panel.js —— 多Agent办公室 v4（办公桌版）
// 可视化办公大厅：CEO 决策者坐镇会议桌首席，各职能员工在工位（显示器+椅子）。
// 工作流：上级发指令 → CEO 拆解 → 分派相关员工 → 员工执行并到会议桌汇报 → CEO 汇总。
// 也支持 @点名某员工直接交给他（后端 /room/message）。
import { API } from './api-client.js'

const $ = (id) => document.getElementById(id)
let agents = []
let selectedId = 'gm'
let doneCount = 0
let busy = false
let voiceOn = localStorage.getItem('bailongma-junjichu-voice') === '1'
const agentState = {}   // id -> { status, task, done, pos, seat, walking }
const els = {}          // id -> { wrap, char, dot, monitor, bubble, bHead, bText }
const SEATS = [{ x: 36, y: 42 }, { x: 64, y: 42 }, { x: 36, y: 56 }, { x: 64, y: 56 }, { x: 50, y: 66 }]
const seatBusy = SEATS.map(() => null)
const STATUS_CN = { working: '工作中', thinking: '思考中', idle: '空闲', reporting: '汇报中', sleep: '休息中' }
const STATUS_COLOR = { working: '#22b07d', thinking: '#e8a13a', idle: '#9aa1b1', reporting: '#3b6ef6', sleep: '#7c86a0' }

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
async function api(path, opts = {}) {
  const res = await fetch(API + path, opts)
  return res.json()
}

async function loadAgents() {
  try {
    const data = await api('/agents')
    agents = data.agents || []
    renderOffice()
    if (!selectedId || !agents.some(a => a.id === selectedId)) selectedId = 'gm'
    renderOfficeCard()
  } catch { }
}

function deskPos(a, i) {
  if (a.ceo) return { x: 50, y: 27 }
  const LAYOUT = [
    { x: 13, y: 26 }, { x: 13, y: 50 }, { x: 13, y: 74 },
    { x: 87, y: 26 }, { x: 87, y: 50 }, { x: 87, y: 74 },
    { x: 50, y: 82 },
  ]
  return LAYOUT[(i - 1) % LAYOUT.length]
}

function renderOffice() {
  const floor = $('office-floor')
  if (!floor) return
  floor.querySelectorAll('.office-desk, .office-agent').forEach(n => n.remove())

  agents.forEach((a, i) => {
    const pos = deskPos(a, i)
    const color = a.color || '#3b6ef6'
    if (!a.ceo) {
      const d = document.createElement('div')
      d.className = 'office-desk'
      d.style.left = (pos.x - 7) + '%'
      d.style.top = (pos.y - 11) + '%'
      d.innerHTML = '<div class="office-monitor"><span class="office-mui"><i></i><i></i><i></i></span></div><div class="office-chair"></div>'
      floor.appendChild(d)
      els[a.id] = { monitor: d.querySelector('.office-monitor') }
    } else {
      els[a.id] = { monitor: null }
    }

    const w = document.createElement('div')
    w.className = 'office-agent' + (a.ceo ? ' office-ceo' : '')
    w.id = 'agent-' + a.id
    w.style.left = pos.x + '%'
    w.style.top = pos.y + '%'
    w.innerHTML = `
      <div class="office-bubble"><div class="ob-head"></div><div class="ob-text"></div></div>
      <div class="office-ring"></div>
      <div class="office-char">
        <span class="oc-ear l"></span><span class="oc-ear r"></span><span class="oc-body"></span>
        <span class="oc-eye l"></span><span class="oc-eye r"></span>
        <span class="oc-scarf" style="--scarf:${color}"></span>
      </div>
      <div class="office-nametag">${esc(a.name)}<small>${esc(a.role || '')}</small><span class="office-status st-idle"></span></div>
    `
    w.addEventListener('click', () => selectAgent(a.id))
    floor.appendChild(w)

    Object.assign(els[a.id], {
      wrap: w, char: w.querySelector('.office-char'), dot: w.querySelector('.office-status'),
      bubble: w.querySelector('.office-bubble'), bHead: w.querySelector('.ob-head'), bText: w.querySelector('.ob-text'),
    })
    agentState[a.id] = { status: 'idle', task: '—', done: 0, pos: { ...pos }, seat: -1, walking: false }
  })
  refreshStats()
}

function setStatus(id, status, task) {
  const s = agentState[id]; if (!s) return
  s.status = status
  if (task !== undefined) s.task = task
  const e = els[id]
  if (e && e.dot) e.dot.className = 'office-status st-' + status
  // 电脑显示屏：工作/汇报=青蓝亮起(扫描线)，思考=琥珀亮起，其余熄灭
  if (e && e.monitor) {
    const lit = status === 'working' || status === 'thinking' || status === 'reporting'
    e.monitor.classList.toggle('on', lit)
    e.monitor.classList.toggle('thinking', status === 'thinking')
  }
  if (e && e.char) {
    // 小人物动作：工作中=打字 / 思考=眼珠转动 / 睡觉=闭眼歪头 / 汇报=打字高亮 / 走路=弹跳
    const cls = ['office-char']
    if (s.walking) cls.push('walking')
    if (status === 'working' || status === 'reporting') cls.push('working')
    else if (status === 'thinking') cls.push('thinking')
    else if (status === 'sleep') cls.push('sleep')
    e.char.className = cls.join(' ')
  }
  refreshStats()
  if (id === selectedId) renderOfficeCard()
}

function bubble(id, head, text, ms = 3200) {
  const e = els[id]; if (!e || !e.bubble) return
  e.bHead.textContent = head
  e.bText.textContent = String(text || '').slice(0, 120)
  e.bubble.classList.add('show')
  clearTimeout(e.bubble._t)
  e.bubble._t = setTimeout(() => e.bubble.classList.remove('show'), ms)
}

function walkTo(id, target, done) {
  const s = agentState[id]; if (!s) return
  s.walking = true; s.pos = { ...target }
  const w = els[id] && els[id].wrap; if (!w) { s.walking = false; done && done(); return }
  w.classList.add('at-table')
  if (els[id] && els[id].char) els[id].char.classList.add('walking')
  w.style.left = target.x + '%'
  w.style.top = target.y + '%'
  setTimeout(() => {
    s.walking = false
    w.classList.remove('at-table')
    if (els[id] && els[id].char) els[id].char.classList.remove('walking')
    setStatus(id, s.status)
    done && done()
  }, 1000)
}
function goToTable(id, cb) {
  const idx = seatBusy.findIndex(v => v === null)
  if (idx < 0) { cb && cb(); return }
  seatBusy[idx] = id; agentState[id].seat = idx
  walkTo(id, SEATS[idx], cb)
}
function backToDesk(id, cb) {
  const a = agents.find(x => x.id === id)
  if (!a) { cb && cb(); return }
  if (agentState[id].seat >= 0) { seatBusy[agentState[id].seat] = null; agentState[id].seat = -1 }
  walkTo(id, deskPos(a, agents.indexOf(a)), cb)
}

function packet(fromId, toId, color = '#3b6ef6') {
  const stage = $('office-stage'); const floor = $('office-floor')
  if (!stage || !floor) return
  const fr = floor.getBoundingClientRect()
  const A = agentState[fromId] && agentState[fromId].pos, B = agentState[toId] && agentState[toId].pos
  if (!A || !B) return
  const x1 = fr.left + A.x / 100 * fr.width, y1 = fr.top + A.y / 100 * fr.height
  const x2 = fr.left + B.x / 100 * fr.width, y2 = fr.top + B.y / 100 * fr.height
  const p = document.createElement('div'); p.className = 'office-packet'; p.style.background = color
  stage.appendChild(p)
  const t0 = performance.now(), dur = 850
  ;(function step(t) {
    const k = Math.min(1, (t - t0) / dur), e = k * (2 - k)
    p.style.left = (x1 + (x2 - x1) * e - 5) + 'px'
    p.style.top = (y1 + (y2 - y1) * e - 5 - Math.sin(k * Math.PI) * 24) + 'px'
    if (k < 1) requestAnimationFrame(step); else p.remove()
  })(performance.now())
}

function officeMsg(type, name, text, extra = '') {
  const box = $('office-messages'); if (!box) return
  const time = new Date().toTimeString().slice(0, 8)
  const div = document.createElement('div')
  div.className = 'msg ' + (type === 'user' ? 'user' : type === 'done' ? 'done-msg' : type === 'system' ? 'system-msg' : 'agent-reply')
  const cls = type === 'user' ? 'me' : type === 'system' ? 'system' : 'agent'
  const displayName = type === 'user' ? '我' : name
  div.innerHTML = '<span class="msg-time">' + time + '</span><span class="msg-name ' + cls + '">' + (type === 'done' ? '✅ ' + displayName : displayName) + '</span> ' + esc(text)
  if (extra) { const em = document.createElement('span'); em.className = 'msg-extra'; em.textContent = extra; div.appendChild(em) }
  box.prepend(div)
  while (box.children.length > 120) box.lastChild.remove()
}

function refreshStats() {
  let w = 0, t = 0, i = 0
  Object.values(agentState).forEach(s => {
    if (s.status === 'working' || s.status === 'reporting') w++
    else if (s.status === 'thinking') t++
    else i++
  })
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v }
  set('c-w', w); set('c-t', t); set('c-i', i); set('c-d', doneCount)
}

function updateClock() {
  const el = $('office-clock'); if (el) el.textContent = new Date().toTimeString().slice(0, 8)
}

function selectAgent(id) {
  selectedId = id
  document.querySelectorAll('.office-agent').forEach(n => n.classList.remove('selected'))
  const w = $('agent-' + id); if (w) w.classList.add('selected')
  renderOfficeCard()
}

function renderOfficeCard() {
  const card = $('office-agent-card'); if (!card) return
  const a = agents.find(x => x.id === selectedId)
  const s = agentState[selectedId]
  if (!a || !s) { card.innerHTML = '<div class="office-card-empty">暂无成员</div>'; return }
  const posText = a.ceo ? '会议桌 · 首席' : (s.seat >= 0 ? '会议桌 · 汇报位' : '自己的工位')
  card.innerHTML = `
    <div class="oc-top">
      <div class="oc-avatar" style="--scarf:${esc(a.color || '#3b6ef6')}">${esc(a.avatar || '🤖')}</div>
      <div>
        <h3>${esc(a.name)}${a.ceo ? ' <span class="me-tag">CEO</span>' : ''}</h3>
        <div class="oc-role">${esc(a.role || '')}</div>
        <span class="oc-badge" style="background:${STATUS_COLOR[s.status] || '#9aa1b1'}">${STATUS_CN[s.status] || s.status}</span>
      </div>
    </div>
    <div class="oc-desc">${esc(a.persona || '')}</div>
    <div class="oc-kv"><span>当前任务</span><b>${esc(s.task || '—')}</b></div>
    <div class="oc-kv"><span>位置</span><b>${posText}</b></div>
    <div class="oc-kv"><span>累计完成</span><b>${s.done} 件</b></div>
  `
}

function speak(text, voiceId) {
  if (!voiceOn || !text) return
  window.dispatchEvent(new CustomEvent('bailongma:speak', { detail: { text: String(text).slice(0, 300), voiceId: voiceId || '' } }))
}

function resolveMentionedAgents(text) {
  const lower = String(text || '').toLowerCase()
  const ids = []
  for (const a of agents) {
    const name = String(a.name || '').toLowerCase().trim()
    const role = String(a.role || '').toLowerCase().trim()
    const id = String(a.id || '').toLowerCase().trim()
    if ((name && lower.includes('@' + name)) || (role && lower.includes('@' + role)) || (id && lower.includes('@' + id))) ids.push(a.id)
  }
  return [...new Set(ids)]
}
let mentionPopup = null
let mentionTimer = null
function ensureMentionPopup() {
  if (mentionPopup && document.body.contains(mentionPopup)) return mentionPopup
  mentionPopup = document.createElement('div')
  mentionPopup.className = 'ma-mention-popup'
  mentionPopup.hidden = true
  const foot = document.querySelector('.office-foot'); (foot || document.body).appendChild(mentionPopup)
  return mentionPopup
}
function closeMentionPopup() { if (mentionPopup) mentionPopup.hidden = true; if (mentionTimer) { clearTimeout(mentionTimer); mentionTimer = null } }
function showMentionPopup(query) {
  const popup = ensureMentionPopup()
  const q = String(query || '').toLowerCase().trim()
  const list = agents.filter(a => !q || (a.name + ' ' + (a.role || '') + ' ' + (a.id || '')).toLowerCase().includes(q)).slice(0, 8)
  if (!list.length) { popup.hidden = true; return }
  popup.innerHTML = list.map(a => '<div class="ma-mention-item" data-id="' + esc(a.id) + '"><span class="ma-mention-avatar" style="--ac:' + esc(a.color) + '">' + esc(a.avatar || '🤖') + '</span><span class="ma-mention-name">' + esc(a.name) + '</span><span class="ma-mention-role">' + esc(a.role || '') + '</span></div>').join('')
  popup.hidden = false
  popup.style.left = '18px'; popup.style.right = '96px'; popup.style.bottom = 'calc(100% + 6px)'
  popup.querySelectorAll('.ma-mention-item').forEach(item => {
    item.addEventListener('mousedown', (e) => { e.preventDefault(); const a = agents.find(x => x.id === item.dataset.id); if (a) applyMentionToInput(a); closeMentionPopup() })
  })
  clearTimeout(mentionTimer); mentionTimer = setTimeout(closeMentionPopup, 6000)
}
function applyMentionToInput(agent) {
  const input = $('ma-input'); if (!input) return
  const text = input.value, pos = input.selectionStart ?? text.length
  const before = text.slice(0, pos), atIdx = before.lastIndexOf('@')
  const start = atIdx >= 0 ? atIdx : pos
  const mention = '@' + agent.name + ' '
  input.value = text.slice(0, start) + mention + text.slice(pos)
  const newPos = start + mention.length
  input.focus(); input.setSelectionRange(newPos, newPos)
}
function handleMentionInput() {
  const input = $('ma-input'); if (!input) return
  const before = input.value.slice(0, input.selectionStart ?? input.value.length)
  const atIdx = before.lastIndexOf('@')
  if (atIdx < 0) { closeMentionPopup(); return }
  const tail = before.slice(atIdx + 1)
  if (/\s/.test(tail)) { closeMentionPopup(); return }
  showMentionPopup(tail)
}

async function sendCommand() {
  const input = $('ma-input'); if (!input) return
  const text = input.value.trim()
  if (!text || busy) return
  input.value = ''; closeMentionPopup()
  officeMsg('user', '我', text)

  const mentions = resolveMentionedAgents(text)
  if (mentions.length) {
    busy = true
    officeMsg('system', '系统', '指令已交给：' + mentions.map(id => (agents.find(a => a.id === id) || {}).name || id).join('、'))
    mentions.forEach(id => { setStatus(id, 'working', text); bubble(id, '⚙️ 接到任务', '收到！开始处理…') })
    try {
      const data = await api('/room/message', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: text, targetAgentIds: mentions }) })
      ;(data.responses || []).forEach(r => {
        const a = agents.find(x => x.id === r.agentId)
        setStatus(r.agentId, 'reporting', text)
        bubble(r.agentId, '📢 汇报', String(r.reply).slice(0, 80), 5000)
        officeMsg('agent', r.agentName, String(r.reply).slice(0, 400))
        speak(r.reply, a && a.voice ? a.voice.voiceId : '')
        setTimeout(() => { setStatus(r.agentId, 'idle', '—'); }, 1200)
      })
    } catch (err) { officeMsg('system', '系统', '指令处理失败：' + err.message) }
    busy = false
    return
  }

  // CEO 工作流（拆解 → 分派 → 执行 → 汇总）
  busy = true
  setStatus('gm', 'thinking', '拆解：' + text)
  bubble('gm', '👔 CEO决策者', '收到指令：「' + text + '」，我来拆解…', 3000)
  officeMsg('system', '系统', '「' + text + '」已收到，CEO 正在拆解…')
  try {
    const data = await api('/room/office', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: text }) })
    if (data.ceoReply) officeMsg('agent', 'CEO决策者', String(data.ceoReply).slice(0, 400))
    setStatus('gm', 'reporting', '分派中')
    const workers = data.workerReplies || []
    workers.forEach((r, i) => {
      setTimeout(() => {
        setStatus(r.agentId, 'working', text)
        packet('gm', r.agentId, '#e05a5a')
        bubble(r.agentId, '⚙️ 执行中', '正在处理…')
        setTimeout(() => {
          setStatus(r.agentId, 'reporting', text)
          goToTable(r.agentId, () => {
            bubble(r.agentId, '📢 当面汇报', String(r.reply).slice(0, 80), 5000)
            packet(r.agentId, 'gm', '#22b07d')
            officeMsg('agent', r.agentName, String(r.reply).slice(0, 400))
            const a = agents.find(x => x.id === r.agentId)
            speak(r.reply, a && a.voice ? a.voice.voiceId : '')
            setTimeout(() => { backToDesk(r.agentId); setStatus(r.agentId, 'idle', '—') }, 1600)
          })
        }, 900)
      }, 800 * (i + 1))
    })
    if (data.ceoSummary && String(data.ceoSummary).trim()) {
      setTimeout(() => {
        officeMsg('agent', 'CEO决策者', '【汇总】' + String(data.ceoSummary).slice(0, 500))
        bubble('gm', '👔 CEO', '汇总完毕 ✅')
      }, workers.length * 900 + 1600)
    }
    if (data.ceoSummary && !/响应失败|失败/.test(String(data.ceoSummary))) doneCount++
    refreshStats()
    setTimeout(() => { setStatus('gm', 'idle', '—'); busy = false }, workers.length * 900 + 2600)
  } catch (err) {
    officeMsg('system', '系统', '指令处理失败：' + err.message)
    setStatus('gm', 'idle', '—'); busy = false
  }
}

export function initMultiAgentPanel() {
  $('multiagent-exit')?.addEventListener('click', closeMultiAgentPanel)
  $('ma-send')?.addEventListener('click', sendCommand)
  const input = $('ma-input')
  input?.addEventListener('input', handleMentionInput)
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeMentionPopup(); return }
    if (e.key === 'Enter' && !e.shiftKey) {
      if (mentionPopup && !mentionPopup.hidden) {
        e.preventDefault()
        const first = mentionPopup.querySelector('.ma-mention-item')
        if (first) { const a = agents.find(x => x.id === first.dataset.id); if (a) applyMentionToInput(a) }
        closeMentionPopup(); return
      }
      e.preventDefault(); sendCommand()
    }
  })
  input?.addEventListener('blur', () => setTimeout(closeMentionPopup, 200))
  updateClock()
  setInterval(updateClock, 1000)
  loadAgents()
}

export function openMultiAgentPanel() {
  const panel = $('multiagent-panel'); if (!panel) return
  panel.hidden = false
  window.__junjichuActive = true
  if (!agents.length) loadAgents()
  if (!selectedId || !agents.some(a => a.id === selectedId)) selectedId = 'gm'
  renderOfficeCard()
  window.dispatchEvent(new CustomEvent('bailongma:multiagent-open'))
}
export function closeMultiAgentPanel() {
  const panel = $('multiagent-panel'); if (panel) panel.hidden = true
  window.__junjichuActive = false
  window.dispatchEvent(new CustomEvent('bailongma:multiagent-close'))
}
export function refreshJunjichuKanban() { /* 兼容空实现 */ }
export async function loadHomeKanban() { /* 兼容空实现 */ }

window.__junjichuVoice = (text) => {
  const input = $('ma-input'); if (input) { input.value = String(text || ''); sendCommand(); return true }
  return false
}
