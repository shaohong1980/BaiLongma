// 多 Agent 会议室 API
import { getAllAgentConfigs, getAgentConfig, updateAgentConfig } from '../../multi-agent/config.js'
import { bossSpeak, officeCommand, assignTask, getRoomHistory, resetRoom, getMeetingRound, resumeOfficeGraph, getPendingApprovals } from '../../multi-agent/room.js'
import { getLedger } from '../../multi-agent/ledger.js'
import { getTraces } from '../../multi-agent/trace.js'
import { listTasks, getTask, runEdictTask, runEdictGraph, resumeEdictGraph, resetTasks, controlTask, reviewTask } from '../../multi-agent/task-flow.js'
import { getPtySnapshot, writePtyInput, resizePty, killPty, startPtyShell } from '../../multi-agent/pty-manager.js'
import { jsonResponse, readJsonBody } from '../utils.js'
import { emitEvent } from '../../events.js'

export async function handleAgentRoutes(req, res, url) {
  // GET /agents/health —— 外部 A2A agent 在线状态探测（会议桌状态灯）
  if (req.method === 'GET' && url.pathname === '/agents/health') {
    try {
      const agents = getAllAgentConfigs().filter(a => a.engine === 'a2a')
      const health = {}
      await Promise.all(agents.map(async (a) => {
        const base = String(a.a2a_url || '').trim().replace(/\/+$/, '')
        try {
          const ctrl = new AbortController()
          const timer = setTimeout(() => ctrl.abort(), 5000)
          const res = await fetch(base + '/.well-known/agent-card.json', { signal: ctrl.signal })
          clearTimeout(timer)
          const card = res.ok ? await res.json().catch(() => null) : null
          health[a.id] = { online: res.ok, name: (card && card.name) || a.name }
        } catch (e) {
          health[a.id] = { online: false, name: a.name, error: e?.name === 'AbortError' ? 'timeout' : 'unreachable' }
        }
      }))
      jsonResponse(res, 200, { ok: true, health })
    } catch (err) { jsonResponse(res, 500, { ok: false, error: err.message }) }
    return true
  }

  // GET /agents/ledger —— 每 Agent 工作台账（B）
  if (req.method === 'GET' && url.pathname === '/agents/ledger') {
    const agentId = url.searchParams.get('agent') || null
    jsonResponse(res, 200, { ok: true, ledger: getLedger(agentId, 50) })
    return true
  }

  // GET /agents/trace —— 执行轨迹（谁干了啥：引擎/工具/命令/A2A/回复）
  if (req.method === 'GET' && url.pathname === '/agents/trace') {
    const agentId = url.searchParams.get('agent') || url.searchParams.get('agentId') || null
    const limit = Number(url.searchParams.get('limit')) || 40
    jsonResponse(res, 200, { ok: true, traces: getTraces(agentId, limit) })
    return true
  }

  // GET /agents —— 列出所有 Agent（含形象/语音/引擎配置）
  if (req.method === 'GET' && url.pathname === '/agents') {
    const agents = getAllAgentConfigs().map(a => {
      const { api_key, ...pub } = a
      return { ...pub, has_api_key: !!api_key }
    })
    jsonResponse(res, 200, { ok: true, agents })
    return true
  }

  // POST /agents/:id/pty/start —— 启动所选成员的交互式终端（常驻 shell）
  const ptyStartMatch = url.pathname.match(/^\/agents\/([^/]+)\/pty\/start$/)
  if (req.method === 'POST' && ptyStartMatch) {
    try {
      const body = await readJsonBody(req)
      const r = startPtyShell(ptyStartMatch[1], { cwd: body?.cwd, cols: body?.cols, rows: body?.rows })
      jsonResponse(res, r.ok ? 200 : 400, r)
    } catch (err) { jsonResponse(res, 400, { ok: false, error: err.message }) }
    return true
  }

  // GET /agents/:id/pty/history —— 实时 PTY 历史与状态
  const ptyHistoryMatch = url.pathname.match(/^\/agents\/([^/]+)\/pty\/history$/)
  if (req.method === 'GET' && ptyHistoryMatch) {
    jsonResponse(res, 200, { ok: true, session: getPtySnapshot(ptyHistoryMatch[1]) })
    return true
  }

  // POST /agents/:id/pty/input —— 向所选成员的 PTY 写入输入
  const ptyInputMatch = url.pathname.match(/^\/agents\/([^/]+)\/pty\/input$/)
  if (req.method === 'POST' && ptyInputMatch) {
    try {
      const body = await readJsonBody(req)
      const r = writePtyInput(ptyInputMatch[1], body?.data)
      jsonResponse(res, r.ok ? 200 : 400, r)
    } catch (err) { jsonResponse(res, 400, { ok: false, error: err.message }) }
    return true
  }

  // POST /agents/:id/pty/resize —— 调整 PTY 尺寸
  const ptyResizeMatch = url.pathname.match(/^\/agents\/([^/]+)\/pty\/resize$/)
  if (req.method === 'POST' && ptyResizeMatch) {
    try {
      const body = await readJsonBody(req)
      const r = resizePty(ptyResizeMatch[1], body?.cols, body?.rows)
      jsonResponse(res, r.ok ? 200 : 400, r)
    } catch (err) { jsonResponse(res, 400, { ok: false, error: err.message }) }
    return true
  }

  // POST /agents/:id/pty/kill —— 结束所选成员的 PTY 进程
  const ptyKillMatch = url.pathname.match(/^\/agents\/([^/]+)\/pty\/kill$/)
  if (req.method === 'POST' && ptyKillMatch) {
    const r = killPty(ptyKillMatch[1])
    jsonResponse(res, r.ok ? 200 : 400, r)
    return true
  }

  // GET /agents/:id —— 单 Agent 配置（含脱敏 key）
  const oneMatch = url.pathname.match(/^\/agents\/([^/]+)$/)
  if (req.method === 'GET' && oneMatch) {
    const agent = getAgentConfig(oneMatch[1])
    if (!agent) { jsonResponse(res, 404, { ok: false, error: 'unknown agent' }); return true }
    const { api_key, ...pub } = agent
    jsonResponse(res, 200, { ok: true, agent: { ...pub, has_api_key: !!api_key } })
    return true
  }

  // POST /agents/:id/config —— 更新 Agent 配置（形象/语音/引擎/模型等）
  const cfgMatch = url.pathname.match(/^\/agents\/([^/]+)\/config$/)
  if (req.method === 'POST' && cfgMatch) {
    try {
      const body = await readJsonBody(req)
      const r = updateAgentConfig(cfgMatch[1], body)
      if (!r.ok) { jsonResponse(res, 400, r); return true }
      const { api_key, ...pub } = r.agent
      jsonResponse(res, 200, { ok: true, agent: { ...pub, has_api_key: !!api_key } })
    } catch (err) { jsonResponse(res, 400, { ok: false, error: err.message }) }
    return true
  }

  // GET /room —— 会议室历史 + 会议轮次
  if (req.method === 'GET' && url.pathname === '/room') {
    jsonResponse(res, 200, { ok: true, round: getMeetingRound(), messages: getRoomHistory(200) })
    return true
  }

  // POST /room/office —— 多Agent办公室工作流（CEO 拆解 → 分派 → 执行 → 汇总）
  // body: { content, graph?, approval?, thread_id? }；graph:true 走状态图引擎（checkpoint/审批/回放）
  if (req.method === 'POST' && url.pathname === '/room/office') {
    try {
      const body = await readJsonBody(req)
      const result = await officeCommand(body?.content || body?.task, {
        graph: body?.graph === true,
        approval: body?.approval === true,
        threadId: body?.thread_id || null,
        onStep: body?.progress ? (s) => { try { emitEvent('office_progress', { agentId: s.node, status: 'working', stage: s.node, text: '（图节点）' }) } catch {} } : null,
      })
      jsonResponse(res, 200, { ok: true, ...result })
    } catch (err) { jsonResponse(res, 400, { ok: false, error: err.message }) }
    return true
  }

  // GET /room/office/pending —— 待人工审批列表（借鉴 openhuman 注意力队列）
  if (req.method === 'GET' && url.pathname === '/room/office/pending') {
    jsonResponse(res, 200, { ok: true, approvals: getPendingApprovals() })
    return true
  }

  // POST /room/office/resume —— 图模式人工审批 / 断点续跑（approved=true 继续，false 驳回）
  if (req.method === 'POST' && url.pathname === '/room/office/resume') {
    try {
      const body = await readJsonBody(req)
      const r = await resumeOfficeGraph(String(body?.thread_id || ''), { approved: body?.approved !== false, note: body?.note })
      jsonResponse(res, 200, { ok: true, ...r })
    } catch (err) { jsonResponse(res, 400, { ok: false, error: err.message }) }
    return true
  }

  // POST /room/message —— 老板发言（@点名 → 只让被点名的成员回答；否则点名/推断）
  if (req.method === 'POST' && url.pathname === '/room/message') {
    try {
      const body = await readJsonBody(req)
      const result = await bossSpeak(body?.content, body?.targetAgentIds)
      jsonResponse(res, 200, { ok: true, ...result })
    } catch (err) { jsonResponse(res, 400, { ok: false, error: err.message }) }
    return true
  }

  // POST /agents/:id/task —— 布置任务给指定 Agent
  const taskMatch = url.pathname.match(/^\/agents\/([^/]+)\/task$/)
  if (req.method === 'POST' && taskMatch) {
    try {
      const body = await readJsonBody(req)
      const result = await assignTask(taskMatch[1], body?.task)
      jsonResponse(res, 200, { ok: true, ...result })
    } catch (err) { jsonResponse(res, 400, { ok: false, error: err.message }) }
    return true
  }

  // POST /room/reset —— 清空会议室
  if (req.method === 'POST' && url.pathname === '/room/reset') {
    resetRoom()
    jsonResponse(res, 200, { ok: true })
    return true
  }

  // ── 军机处任务看板（移植 edict 三省六部）──
  // GET /task —— 任务列表（看板数据）
  if (req.method === 'GET' && url.pathname === '/task') {
    jsonResponse(res, 200, { ok: true, tasks: listTasks() })
    return true
  }
  // GET /task/:id —— 单任务详情（含奏折审计）
  const taskOne = url.pathname.match(/^\/task\/([^/]+)$/)
  if (req.method === 'GET' && taskOne) {
    const t = getTask(taskOne[1])
    if (!t) { jsonResponse(res, 404, { ok: false, error: '任务不存在' }); return true }
    jsonResponse(res, 200, { ok: true, task: t })
    return true
  }
  // POST /task —— 下旨，运行三省六部流水线
  // body: { content, graph?, approval?, thread_id? }；graph:true 走状态图引擎（checkpoint/审批/回放）
  if (req.method === 'POST' && url.pathname === '/task') {
    try {
      const body = await readJsonBody(req)
      const content = body?.content || body?.task || body?.edict
      if (!content || !String(content).trim()) { jsonResponse(res, 400, { ok: false, error: '需要旨意内容' }); return true }
      const result = body?.graph === true
        ? await runEdictGraph(String(content).trim(), { approval: body?.approval === true, threadId: body?.thread_id || null })
        : await runEdictTask(String(content).trim())
      jsonResponse(res, 200, { ok: true, ...result })
    } catch (err) { jsonResponse(res, 400, { ok: false, error: err.message }) }
    return true
  }

  // POST /task/resume —— 图模式人工审批 / 断点续跑
  if (req.method === 'POST' && url.pathname === '/task/resume') {
    try {
      const body = await readJsonBody(req)
      const r = await resumeEdictGraph(String(body?.thread_id || ''), { approved: body?.approved !== false, note: body?.note })
      jsonResponse(res, 200, { ok: true, ...r })
    } catch (err) { jsonResponse(res, 400, { ok: false, error: err.message }) }
    return true
  }
  // POST /task/:id/control —— 任务干预（cancel/pause/resume）
  const taskCtrl = url.pathname.match(/^\/task\/([^/]+)\/control$/)
  if (req.method === 'POST' && taskCtrl) {
    try {
      const body = await readJsonBody(req)
      const r = controlTask(taskCtrl[1], body?.action)
      if (!r.ok) { jsonResponse(res, 400, r); return true }
      jsonResponse(res, 200, { ok: true, task: r.task })
    } catch (err) { jsonResponse(res, 400, { ok: false, error: err.message }) }
    return true
  }
  // POST /task/:id/review —— 手动审议/封驳
  const taskRev = url.pathname.match(/^\/task\/([^/]+)\/review$/)
  if (req.method === 'POST' && taskRev) {
    try {
      const body = await readJsonBody(req)
      const r = reviewTask(taskRev[1], { pass: body?.pass, note: body?.note })
      if (!r.ok) { jsonResponse(res, 400, r); return true }
      jsonResponse(res, 200, { ok: true, task: r.task })
    } catch (err) { jsonResponse(res, 400, { ok: false, error: err.message }) }
    return true
  }
  // POST /task/reset —— 清空任务看板
  if (req.method === 'POST' && url.pathname === '/task/reset') {
    resetTasks()
    jsonResponse(res, 200, { ok: true })
    return true
  }

  return false
}
