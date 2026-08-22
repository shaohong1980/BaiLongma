// multi-agent-panel.js —— 多Agent办公室 v4（办公桌版）
// 可视化办公大厅：CEO 决策者坐镇会议桌首席，各职能员工在工位（显示器+椅子）。
// 工作流：上级发指令 → CEO 拆解 → 分派相关员工 → 员工执行并到会议桌汇报 → CEO 汇总。
// 也支持 @点名某员工直接交给他（后端 /room/message）。
import { API, subscribeEvents } from './api-client.js'

const $ = (id) => document.getElementById(id)
let agents = []
let selectedId = 'gm'
let doneCount = 0
let busy = false
let voiceOn = localStorage.getItem('bailongma-junjichu-voice') === '1'
const agentState = {}   // id -> { status, task, done, pos, seat, walking }
const els = {}          // id -> { wrap, char, dot, monitor, bubble, bHead, bText }
let traces = []         // 执行轨迹（当前所选成员的时间线）
// 汇报座位：左边工位的角色到 CEO 左边汇报，右边工位的角色到 CEO 右边汇报
const LEFT_SEATS = [{ x: 34, y: 42 }, { x: 34, y: 56 }, { x: 34, y: 68 }]
const RIGHT_SEATS = [{ x: 66, y: 42 }, { x: 66, y: 56 }, { x: 66, y: 68 }]
const seatBusy = [...LEFT_SEATS, ...RIGHT_SEATS].map(() => null)
// 判断角色归属侧：以工位 x 坐标是否小于 CEO(50) 为准
function sideOfAgent(id) {
  const a = agents.find(x => x.id === id)
  const pos = a ? deskPos(a, agents.indexOf(a)) : { x: 50 }
  return (Number(pos.x) || 50) < 50 ? 'left' : 'right'
}
const STATUS_CN = { working: '工作中', thinking: '思考中', idle: '空闲', reporting: '汇报中', sleep: '休息中', waiting: '待审批' }
const STATUS_COLOR = { working: '#22b07d', thinking: '#e8a13a', idle: '#9aa1b1', reporting: '#3b6ef6', sleep: '#7c86a0', waiting: '#f59e0b' }

// 汇报路线阶段（老板 → CEO拆解 → 分派 → 顾问讨论 → 执行 → 汇报 → 收报），用于顶部路线灯
const ROUTE_ORDER = ['boss', 'ceo', 'dispatch', 'advise', 'exec', 'report', 'done']
function setRouteStage(stage) {
  const route = $('office-route'); if (!route) return
  const idx = ROUTE_ORDER.indexOf(stage)
  route.querySelectorAll('.or-node').forEach(n => {
    const i = ROUTE_ORDER.indexOf(n.dataset.stage)
    n.classList.toggle('done', idx >= 0 && i < idx)
    n.classList.toggle('current', i === idx)
  })
}
// 后端 office_progress 的 stage → 路线阶段（advise = 外部顾问参与讨论）
const OFFICE_STAGE_ROUTE = {
  ceo: 'ceo', ceo_done: 'dispatch', dispatch: 'dispatch',
  advise: 'advise',
  executing: 'exec', done: 'report', verify: 'report', verify_done: 'report',
  summary: 'done', complete: 'done',
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
// 去掉 CEO 拆解回复末尾的程序化 JSON（{"workers":[...]} 分派指令行），避免原样展示给用户
function stripCeoWorkersJson(s) {
  return String(s || '').replace(/\n?\s*\{\s*"workers"\s*:\s*\[[^\]]*\]\s*\}\s*$/, '')
}
async function api(path, opts = {}) {
  const res = await fetch(API + path, opts)
  return res.json()
}

// ── 执行轨迹：显示所选成员的真实动作时间线（引擎/工具/命令/A2A/回复）──
const TRACE_KIND_META = {
  engine: { icon: '⚙️', label: '引擎', cls: 'tk-engine' },
  tool_call: { icon: '🔧', label: '调用工具', cls: 'tk-tool' },
  tool_result: { icon: '✅', label: '工具结果', cls: 'tk-ok' },
  command: { icon: '⌨️', label: '命令', cls: 'tk-cmd' },
  a2a: { icon: '🌐', label: 'A2A 调用', cls: 'tk-a2a' },
  reply: { icon: '💬', label: '回复', cls: 'tk-reply' },
  error: { icon: '⚠️', label: '错误', cls: 'tk-err' },
}
// 借鉴 openhuman 的 mergeToolActivity：把相邻的 tool_call + tool_result 合并成一个"工具单元"
function mergeTraceRows(list) {
  const rows = []
  for (let i = 0; i < list.length; i++) {
    const cur = list[i]
    const next = list[i + 1]
    if (cur.kind === 'tool_call' && next && next.kind === 'tool_result' && (!cur.tool || !next.tool || next.tool === cur.tool)) {
      rows.push({ ...cur, kind: 'tool', merged: next })
      i++
      continue
    }
    rows.push(cur)
  }
  return rows
}
function traceItemHtml(e) {
  const meta = TRACE_KIND_META[e.kind] || { icon: '•', label: e.kind || '', cls: '' }
  const time = String(e.ts || '').replace('T', ' ').slice(11, 19)
  const ms = e.ms ? '<span class="ot-ms">' + Math.round(e.ms) + 'ms</span>' : ''
  // 工具单元：一行显示"命令 → 结果 + 成败"
  if (e.kind === 'tool') {
    const ok = e.merged ? e.merged.ok !== false : true
    const result = e.merged && e.merged.detail
      ? '<span class="ot-result ' + (ok ? 'ok' : 'fail') + '">→ ' + esc(e.merged.detail) + (ok ? '' : ' ⚠️') + '</span>'
      : (e.merged ? '<span class="ot-result ' + (ok ? 'ok' : 'fail') + '">' + (ok ? '✓' : '✗') + '</span>' : '')
    return '<div class="ot-item ' + (ok ? 'tk-ok' : 'tk-err') + '">' +
      '<span class="ot-time">' + esc(time) + '</span>' +
      '<span class="ot-icon">🔧</span>' +
      '<span class="ot-body">' + (e.tool ? '<span class="ot-tool">' + esc(e.tool) + '</span>' : '') + '<span class="ot-detail">' + esc(e.detail || '') + '</span>' + result + '</span>' +
      ms +
    '</div>'
  }
  const tool = e.tool ? '<span class="ot-tool">' + esc(e.tool) + '</span>' : ''
  return '<div class="ot-item ' + meta.cls + '">' +
    '<span class="ot-time">' + esc(time) + '</span>' +
    '<span class="ot-icon">' + meta.icon + '</span>' +
    '<span class="ot-body">' + tool + '<span class="ot-detail">' + esc(e.detail || '') + '</span></span>' +
    ms +
  '</div>'
}
function renderTraces() {
  const box = $('office-traces'); if (!box) return
  if (!traces.length) {
    box.innerHTML = '<div class="office-traces-empty">暂无执行轨迹。<br>让成员干活后，这里会实时显示它调用了哪些工具 / 跑了哪些命令 / 给出了什么回复。</div>'
    return
  }
  box.innerHTML = mergeTraceRows(traces.slice(0, 80)).map(traceItemHtml).join('')
}
async function loadTraces() {
  try {
    const data = await api('/agents/trace?agent=' + encodeURIComponent(selectedId) + '&limit=60')
    traces = data.traces || []
  } catch { traces = [] }
  renderTraces()
}
function handleOfficeTrace(d = {}) {
  if (!d.agentId || d.agentId !== selectedId) return
  traces.unshift(d)
  traces = traces.slice(0, 60)
  renderTraces()
}

// ── 待审批提醒（借鉴 openhuman AttentionQueue：需要你处理的待审批）──
let approvalMode = localStorage.getItem('bailongma-office-approval') === '1'
let pendingApprovals = []

function renderApprovalToggle() {
  const btn = $('office-approval-toggle')
  if (btn) btn.classList.toggle('on', approvalMode)
}

function renderApprovalBar() {
  const bar = $('office-approval-bar'); if (!bar) return
  if (!pendingApprovals.length) { bar.hidden = true; bar.innerHTML = ''; return }
  bar.hidden = false
  const a = pendingApprovals[0]
  bar.innerHTML = '⏳ <b>待审批</b>：' + esc(a.text || '（任务）') + ' · 停在「' + esc(a.node || 'CEO汇总') + '」' +
    '<span class="oab-actions">' +
    '<button type="button" class="oab-ok" data-thread="' + esc(a.threadId) + '">✅ 通过</button>' +
    '<button type="button" class="oab-no" data-thread="' + esc(a.threadId) + '">✗ 驳回</button>' +
    '</span>'
  bar.querySelector('.oab-ok')?.addEventListener('click', () => handleApproval(a.threadId, true))
  bar.querySelector('.oab-no')?.addEventListener('click', () => handleApproval(a.threadId, false))
}

async function loadPendingApprovals() {
  try {
    const data = await api('/room/office/pending')
    pendingApprovals = data.approvals || []
  } catch { pendingApprovals = [] }
  renderApprovalBar()
}

function handleOfficeApproval(d = {}) {
  if (!d.threadId) return
  pendingApprovals = pendingApprovals.filter(x => x.threadId !== d.threadId)
  pendingApprovals.unshift(d)
  renderApprovalBar()
  if (d.agentId) setStatus(d.agentId, 'waiting', '等待审批')
}

async function handleApproval(threadId, approved) {
  const r = await api('/room/office/resume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ thread_id: threadId, approved, note: '' }),
  })
  if (!r.ok) { officeMsg('system', '系统', '审批处理失败：' + (r.error || '未知')); return }
  if (r.rejected) {
    officeMsg('system', '系统', '✗ 已驳回该流程')
    setStatus('gm', 'idle', '—'); setRouteStage('')
  } else if (r.ceoSummary) {
    setRouteStage('done')
    officeMsg('agent', 'CEO决策者', '📌 汇总：' + stripCeoWorkersJson(r.ceoSummary).slice(0, 500), '', stripCeoWorkersJson(r.ceoSummary))
    bubble('gm', '👔 CEO', '审批通过，汇总完毕 ✅')
    setStatus('gm', 'idle', '—')
    doneCount++
    loadLedger(); loadTraces(); refreshStats()
  } else {
    officeMsg('system', '系统', '已审批，流程继续')
    setStatus('gm', 'idle', '—')
  }
  pendingApprovals = pendingApprovals.filter(x => x.threadId !== threadId)
  renderApprovalBar()
}

async function loadAgents() {
  try {
    const data = await api('/agents')
    agents = data.agents || []
    renderOffice()
    if (!selectedId || !agents.some(a => a.id === selectedId)) selectedId = 'gm'
    renderOfficeCard()
    loadTraces()
  } catch { }
}

function deskPos(a, i) {
  if (a.ceo) return { x: 50, y: 27 }          // 会议桌首席
  if (a.table) {                                // 独立外部 Agent：坐会议桌
    // 3 个外部 A2A 座位（Hermes / ClaudeCode / OpenHuman），按 tIdx 取模错开，
    // 避免第 3 个成员与第 1 个重叠在同一座位。
    const TABLE_SEATS = [{ x: 37, y: 48 }, { x: 63, y: 48 }, { x: 50, y: 58 }]
    const tIdx = agents.filter(x => x.table).findIndex(x => x.id === a.id)
    return TABLE_SEATS[Math.max(0, tIdx) % TABLE_SEATS.length]
  }
  if (a.desk) return { x: a.desk.x, y: a.desk.y }  // 显式工位（报表统计在左边）
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
    if (!a.ceo && !a.table) {
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
    w.className = 'office-agent' + (a.ceo ? ' office-ceo' : '') + (a.external ? ' office-external' : '')
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
  probeExternalHealth()   // P1-6：外部 A2A agent 状态灯
  loadLedger()            // B：工作台账
  renderQuickChips()      // 快捷点名：一键 @ 某成员
}

// P1-6：探测外部 A2A agent 在线状态（会议桌状态灯：绿=在线 / 红=离线）
async function probeExternalHealth() {
  try {
    const data = await api('/agents/health')
    const health = data.health || {}
    for (const [id, h] of Object.entries(health)) {
      const e = els[id]
      if (e && e.dot) {
        e.dot.className = 'office-status ' + (h.online ? 'st-online' : 'st-offline')
        e.dot.title = h.online ? `在线 (${h.name})` : `离线 (${h.error || 'unknown'})`
      }
    }
  } catch { /* 忽略探测失败，保持默认状态 */ }
}

// B：工作台账 —— 每位 Agent 的近期完成（"谁干了啥/昨天干了啥"）
let ledger = []
async function loadLedger() {
  try { const data = await api('/agents/ledger?limit=30'); ledger = data.ledger || [] } catch { ledger = [] }
  renderLedger()
  renderOfficeCard()
}
function getAgentColor(id) {
  const a = agents.find(x => x.id === id)
  return a ? (a.color || '#3b6ef6') : '#9aa1b1'
}
function renderLedger() {
  const box = $('office-ledger'); if (!box) return
  if (!ledger.length) { box.innerHTML = '<div class="office-ledger-empty">暂无记录</div>'; return }
  box.innerHTML = ledger.slice(0, 15).map(e => {
    const t = String(e.ts || '').replace('T', ' ').slice(5, 16)
    return '<div class="ledger-item" title="' + esc(e.result || '') + '">' +
      '<span class="ledger-time">' + esc(t) + '</span>' +
      '<span class="ledger-agent" style="--ac:' + esc(getAgentColor(e.agentId)) + '">' + esc(e.agentName || e.agentId) + '</span>' +
      '<span class="ledger-task">' + esc(e.task || '') + '</span>' +
      (e.ms ? '<span class="ledger-ms">' + Math.round(e.ms / 1000) + 's</span>' : '') +
      '</div>'
  }).join('')
}

// 实时工作流进度：后端 officeCommand 每阶段推 office_progress 事件，
// 前端 SSE 收到后立即更新角色状态，让"眼睛动"跟真实执行同步（不再等整个流程返回）。
let officeSSE = null
function connectOfficeSSE() {
  try { if (officeSSE) officeSSE.close() } catch (e) { console.warn('[src/ui/brain-ui/multi-agent-panel.js] op failed:', e?.message || e) }
  try {
    officeSSE = subscribeEvents('/events', {
      onmessage: (data) => {
        try {
          const msg = JSON.parse(data)
          if (msg.type === 'office_progress') handleOfficeProgress(msg.data || {})
          else if (msg.type === 'office_trace') handleOfficeTrace(msg.data || {})
          else if (msg.type === 'office_approval') handleOfficeApproval(msg.data || {})
        } catch (e) { console.warn('[src/ui/brain-ui/multi-agent-panel.js] op failed:', e?.message || e) }
      },
      onerror: () => { try { officeSSE && officeSSE.close() } catch (e) { console.warn('[src/ui/brain-ui/multi-agent-panel.js] op failed:', e?.message || e) }; officeSSE = null; setTimeout(connectOfficeSSE, 5000) },
    })
  } catch (e) { console.warn('[src/ui/brain-ui/multi-agent-panel.js] op failed:', e?.message || e) }
}
function handleOfficeProgress(d = {}) {
  const id = d.agentId
  if (!id || !agentState[id]) return
  setStatus(id, d.status || 'idle', d.text || '')
  if (d.bubble) bubble(id, d.head || '⚙️', d.bubble, 4000)
  // 同步顶部汇报路线灯（按后端执行阶段点亮）
  if (d.stage && OFFICE_STAGE_ROUTE[d.stage]) setRouteStage(OFFICE_STAGE_ROUTE[d.stage])
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
  const a = agents.find(x => x.id === id)
  // 会议桌成员（外部 A2A：Hermes/ClaudeCode/OpenHuman）本就在桌边：原地汇报，不走动
  if (a && a.table) { cb && cb(); return }
  const left = sideOfAgent(id) === 'left'
  const pool = left ? LEFT_SEATS : RIGHT_SEATS
  const base = left ? 0 : LEFT_SEATS.length
  const local = seatBusy.slice(base, base + pool.length).findIndex(v => v === null)
  if (local < 0) { cb && cb(); return }
  const idx = base + local
  seatBusy[idx] = id; agentState[id].seat = idx
  walkTo(id, pool[local], cb)
}
function backToDesk(id, cb) {
  const a = agents.find(x => x.id === id)
  if (!a) { cb && cb(); return }
  // 会议桌成员无需归位（一直在桌边）
  if (a.table) { cb && cb(); return }
  if (agentState[id].seat >= 0) { seatBusy[agentState[id].seat] = null; agentState[id].seat = -1 }
  walkTo(id, deskPos(a, agents.indexOf(a)), cb)
}

function packet(fromId, toId, color = '#3b6ef6', label = '') {
  const stage = $('office-stage'); const floor = $('office-floor')
  if (!stage || !floor) return
  const fr = floor.getBoundingClientRect()
  const A = agentState[fromId] && agentState[fromId].pos, B = agentState[toId] && agentState[toId].pos
  if (!A || !B) return
  const x1 = fr.left + A.x / 100 * fr.width, y1 = fr.top + A.y / 100 * fr.height
  const x2 = fr.left + B.x / 100 * fr.width, y2 = fr.top + B.y / 100 * fr.height
  const p = document.createElement('div'); p.className = 'office-packet'; p.style.background = color
  if (label) { const lab = document.createElement('span'); lab.className = 'office-packet-label'; lab.textContent = label; p.appendChild(lab) }
  stage.appendChild(p)
  const t0 = performance.now(), dur = 850
  ;(function step(t) {
    const k = Math.min(1, (t - t0) / dur), e = k * (2 - k)
    p.style.left = (x1 + (x2 - x1) * e - 5) + 'px'
    p.style.top = (y1 + (y2 - y1) * e - 5 - Math.sin(k * Math.PI) * 24) + 'px'
    if (k < 1) requestAnimationFrame(step); else p.remove()
  })(performance.now())
}

// officeMsg —— 消息进对话日志。text 是展示文本；full 是完整内容（可选）。
// 当 full 比展示文本更长时，附一个「展开全文」按钮，长文档/报告不再只看到被截断的前半段。
function officeMsg(type, name, text, extra = '', full = '') {
  const box = $('office-messages'); if (!box) return
  const time = new Date().toTimeString().slice(0, 8)
  const div = document.createElement('div')
  div.className = 'msg ' + (type === 'user' ? 'user' : type === 'done' ? 'done-msg' : type === 'system' ? 'system-msg' : 'agent-reply')
  const cls = type === 'user' ? 'me' : type === 'system' ? 'system' : 'agent'
  const displayName = type === 'user' ? '我' : name
  const display = String(text)
  const fullText = String(full || display)
  div.innerHTML = '<span class="msg-time">' + time + '</span><span class="msg-name ' + cls + '">' + (type === 'done' ? '✅ ' + displayName : displayName) + '</span> '
  const body = document.createElement('span')
  body.className = 'msg-body'
  body.textContent = display
  div.appendChild(body)
  if (extra) { const em = document.createElement('span'); em.className = 'msg-extra'; em.textContent = extra; div.appendChild(em) }
  // 长内容（成员/CEO 交付的完整文档）：预览 + 一键展开
  if (fullText.length > display.length) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'msg-expand'
    btn.textContent = '展开全文（' + fullText.length + ' 字）'
    btn.addEventListener('click', () => { body.textContent = fullText; btn.remove(); div.classList.add('expanded') })
    div.appendChild(btn)
  }
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

// 快捷点名条：点一下就把 @成员名 填入输入框，直接交给他
function renderQuickChips() {
  const row = $('office-quick'); if (!row) return
  row.innerHTML = '<span class="office-quick-label">快捷点名</span>' + agents.map(a =>
    '<button type="button" class="office-chip" data-id="' + esc(a.id) + '" title="交给 ' + esc(a.name) + '（@点名直达）" style="--ac:' + esc(a.color || '#3b6ef6') + '"><i>' + esc(a.avatar || '🤖') + '</i>' + esc(a.name) + '</button>'
  ).join('')
  row.querySelectorAll('.office-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const a = agents.find(x => x.id === chip.dataset.id)
      if (!a) return
      const input = $('ma-input')
      if (input) { input.value = '@' + a.name + ' '; input.focus() }
    })
  })
}

// 右侧面板页签：💬对话 / 📋台账 / 🧭轨迹
function initOfficeTabs() {
  const tabs = $('office-tabs'); if (!tabs) return
  tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.office-tab'); if (!btn) return
    document.querySelectorAll('.office-tab').forEach(t => t.classList.toggle('active', t === btn))
    const name = btn.dataset.tab
    document.querySelectorAll('.office-tab-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === name))
    if (name === 'trace') loadTraces()   // 切到轨迹页签时拉最新
  })
}

function selectAgent(id) {
  selectedId = id
  document.querySelectorAll('.office-agent').forEach(n => n.classList.remove('selected'))
  const w = $('agent-' + id); if (w) w.classList.add('selected')
  renderOfficeCard()
  loadTraces()
}

function renderOfficeCard() {
  const card = $('office-agent-card'); if (!card) return
  const a = agents.find(x => x.id === selectedId)
  const s = agentState[selectedId]
  if (!a || !s) { card.innerHTML = '<div class="office-card-empty">暂无成员</div>'; return }
  const posText = a.ceo ? '会议桌 · 首席' : a.table ? (a.advisor ? '会议桌 · 外部全能顾问' : '会议桌 · 独立外部 A2A') : (s.seat >= 0 ? '会议桌 · 汇报位' : '自己的工位')
  card.innerHTML = `
    <div class="oc-top">
      <div class="oc-avatar" style="--scarf:${esc(a.color || '#3b6ef6')}">${esc(a.avatar || '🤖')}</div>
      <div>
        <h3>${esc(a.name)}${a.ceo ? ' <span class="me-tag">CEO</span>' : ''}${a.external ? ' <span class="ext-tag">外部A2A</span>' : ''}</h3>
        <div class="oc-role">${esc(a.role || '')}</div>
        <span class="oc-badge" style="background:${STATUS_COLOR[s.status] || '#9aa1b1'}">${STATUS_CN[s.status] || s.status}</span>
      </div>
    </div>
    <div class="oc-desc">${esc(a.persona || '')}</div>
    <div class="oc-kv"><span>当前任务</span><b>${esc(s.task || '—')}</b></div>
    <div class="oc-kv"><span>位置</span><b>${posText}</b></div>
    <div class="oc-kv"><span>累计完成</span><b>${s.done} 件</b></div>
    <div class="oc-recent">
      <span class="oc-recent-title">最近完成</span>
      ${(ledger.filter(e => e.agentId === selectedId).slice(0, 3).map(e =>
        '<div class="oc-recent-item" title="' + esc(e.result || '') + '"><span>' + esc(String(e.ts || '').replace('T', ' ').slice(5, 16)) + '</span>' + esc(String(e.task || '').slice(0, 30)) + '</div>'
      ).join('') || '<div class="oc-recent-item dim">暂无</div>')}
    </div>
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
        officeMsg('agent', r.agentName, String(r.reply).slice(0, 400), '', r.reply)
        speak(r.reply, a && a.voice ? a.voice.voiceId : '')
        setTimeout(() => { setStatus(r.agentId, 'idle', '—'); }, 1200)
      })
    } catch (err) { officeMsg('system', '系统', '指令处理失败：' + err.message) }
    busy = false
    return
  }

  // CEO 工作流（老板 → CEO拆解 → 分派 → 员工执行 → 员工汇报CEO → CEO汇总收报）
  busy = true
  setStatus('gm', 'thinking', '拆解：' + text)
  setRouteStage('ceo')
  bubble('gm', '👔 CEO决策者', '收到指令：「' + text + '」，我来拆解…', 3000)
  officeMsg('system', '系统', '「' + text + '」已收到，CEO 正在拆解…')
  try {
    // 审批模式（借鉴 openhuman 注意力队列）：走图模式 + 人工审批，CEO 汇总前停下等你通过/驳回
    const officeBody = { content: text }
    if (approvalMode) { officeBody.graph = true; officeBody.approval = true }
    const data = await api('/room/office', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(officeBody) })
    if (data.ceoReply) {
      officeMsg('agent', 'CEO决策者', '📌 拆解分工：' + stripCeoWorkersJson(data.ceoReply).slice(0, 400), '', stripCeoWorkersJson(data.ceoReply))
      bubble('gm', '👔 拆解完成', '已分工，正在派单…', 2500)
    }
    setStatus('gm', 'reporting', '分派中')
    // 图模式审批时 worker 结果在 state.workerReplies（汇总前已暂停）
    const workers = data.workerReplies || (data.state && data.state.workerReplies) || []
    if (workers.length) {
      setRouteStage('dispatch')
      const names = workers.map(r => r.agentName || r.agentId).join('、')
      officeMsg('system', '系统', '📡 CEO 分派给：' + names)
    }
    workers.forEach((r, i) => {
      setTimeout(() => {
        setStatus(r.agentId, 'working', text)
        setRouteStage('exec')
        packet('gm', r.agentId, '#e05a5a', '派单')
        bubble(r.agentId, '⚙️ 执行中', '正在处理…')
        setTimeout(() => {
          setStatus(r.agentId, 'reporting', text)
          setRouteStage('report')
          goToTable(r.agentId, () => {
            const isTable = (agents.find(x => x.id === r.agentId) || {}).table
            const tag = isTable ? '📢 汇报' : '📢 当面汇报'
            bubble(r.agentId, tag, String(r.reply).slice(0, 80), 5000)
            packet(r.agentId, 'gm', '#22b07d', tag)
            officeMsg('agent', r.agentName, tag + '：' + String(r.reply).slice(0, 400), '', r.reply)
            const a = agents.find(x => x.id === r.agentId)
            speak(r.reply, a && a.voice ? a.voice.voiceId : '')
            setTimeout(() => { backToDesk(r.agentId); setStatus(r.agentId, 'idle', '—') }, 1600)
          })
        }, 900)
      }, 700 * (i + 1))
    })
    // 外部全能顾问（Hermes/OpenHuman）参与讨论、给方案意见
    const advisors = data.advisoryReplies || (data.state && data.state.advisoryReplies) || []
    if (advisors.length) {
      setRouteStage('advise')
      officeMsg('system', '系统', '🧭 外部顾问参与讨论：' + advisors.map(a => a.agentName || a.agentId).join('、'))
      advisors.forEach((r, i) => {
        setTimeout(() => {
          setStatus(r.agentId, 'reporting', text)
          bubble(r.agentId, '🧭 方案意见', String(r.reply).slice(0, 80), 5000)
          packet(r.agentId, 'gm', '#10b981', '意见')
          officeMsg('agent', r.agentName, '🧭 方案意见：' + String(r.reply).slice(0, 400), '', r.reply)
          const a = agents.find(x => x.id === r.agentId)
          speak(r.reply, a && a.voice ? a.voice.voiceId : '')
          setTimeout(() => setStatus(r.agentId, 'idle', '—'), 1200)
        }, 320 * (i + 1))
      })
    }
    // 审批模式：流程停在「CEO 汇总」前，等老板通过/驳回（顶部出现待审批提醒条）
    if (data.interrupted) {
      setRouteStage('report')
      setStatus('gm', 'waiting', '等待审批')
      officeMsg('system', '系统', '⏳ 审批模式：CEO 汇总前需要你人工通过/驳回（见顶部「待审批」提醒条）')
      await loadPendingApprovals()
      busy = false
      return
    }
    if (data.ceoSummary && String(data.ceoSummary).trim()) {
      setTimeout(() => {
        setRouteStage('done')
        if (!workers.length) {
          // 无分派员工：拆解即结论，避免把同一段文字重复展示两遍
          officeMsg('system', '系统', '✅ CEO 直接给出结论（无需分派员工）')
        } else {
          officeMsg('agent', 'CEO决策者', '📌 汇总：' + stripCeoWorkersJson(data.ceoSummary).slice(0, 500), '', stripCeoWorkersJson(data.ceoSummary))
        }
        bubble('gm', '👔 CEO', '汇总完毕 ✅')
      }, workers.length * 700 + 1600)
    }
    if (data.ceoSummary && !/响应失败|失败/.test(String(data.ceoSummary))) doneCount++
    loadLedger()   // B：任务完成后刷新台账
    loadTraces()   // B'：任务完成后刷新执行轨迹
    refreshStats()
    setTimeout(() => { setStatus('gm', 'idle', '—'); setRouteStage(''); busy = false }, workers.length * 700 + 2600)
  } catch (err) {
    officeMsg('system', '系统', '指令处理失败：' + err.message)
    setStatus('gm', 'idle', '—'); setRouteStage(''); busy = false
  }
}

export function initMultiAgentPanel() {
  initOfficeTabs()   // 右侧面板页签（对话/台账/轨迹）
  $('multiagent-exit')?.addEventListener('click', closeMultiAgentPanel)
  $('ma-send')?.addEventListener('click', sendCommand)
  $('office-approval-toggle')?.addEventListener('click', () => {
    approvalMode = !approvalMode
    localStorage.setItem('bailongma-office-approval', approvalMode ? '1' : '0')
    renderApprovalToggle()
    officeMsg('system', '系统', approvalMode ? '🛑 审批模式已开启：CEO 汇总前需你人工通过/驳回' : '审批模式已关闭（自动汇总）')
  })
  renderApprovalToggle()
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
  loadTraces()
  loadPendingApprovals()
  renderApprovalToggle()
  connectOfficeSSE()   // 实时工作流进度 + 执行轨迹 + 待审批推送
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
