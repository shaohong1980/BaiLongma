// a2a-server.js —— A2A（Agent2Agent）v1.0 入站服务端
//
// 让外部 Agent（Hermes / LangChain / CrewAI / Google ADK ...）通过标准 A2A 协议
// 发现 BaiLongma 并派发任务。规范：https://a2a-protocol.org
//
//   - Agent Card 发现：GET /.well-known/agent-card.json（v1.0 规范）/
//                      /.well-known/agent.json（旧草案）/ /agent.json
//   - JSON-RPC 2.0 over HTTP：POST /
//       · message/send / SendMessage —— 创建任务，把消息推给 Jarvis，等 agent 回信
//       · tasks/get    / GetTask     —— 查询任务状态
//       · tasks/list   / ListTasks   —— 按 contextId 列出任务
//       · tasks/cancel / CancelTask  —— 取消任务
//
// 回信机制：入站消息以 from_id = `A2A:<contextId>` 推入主循环（user 优先级）；
// agent 用 send_message(target_id = `A2A:<contextId>`) 回信时，deliverMessage
// 会广播 `message` 事件（经 events.js 的服务端订阅），本模块捕获后完成对应 Task。
import http from 'http'
import crypto from 'crypto'
import { pushMessage } from './inbound-message.js'
import { subscribeEvent } from './events.js'
import { getAgentName } from './api/agent.js'

// ── 常量 ──────────────────────────────────────────────────────────────
const STATE_SUBMITTED    = 'TASK_STATE_SUBMITTED'
const STATE_WORKING      = 'TASK_STATE_WORKING'
const STATE_COMPLETED    = 'TASK_STATE_COMPLETED'
const STATE_FAILED       = 'TASK_STATE_FAILED'
const STATE_CANCELED     = 'TASK_STATE_CANCELED'
const ERR_PARSE          = -32700
const ERR_INVALID_PARAMS = -32602
const ERR_METHOD_NOT_FOUND = -32601
const ERR_TASK_NOT_FOUND = -32001        // A2A spec: TaskNotFoundError
const ERR_TASK_NOT_CANCELABLE = -32002   // A2A spec: TaskNotCancelableError
const DEFAULT_REPLY_TIMEOUT_MS = 120_000

// ── 任务存储 ──────────────────────────────────────────────────────────
const tasks = new Map()          // taskId -> task
const pendingByParty = new Map() // `A2A:<contextId>` -> Set<{ resolve, timer }>

function newTaskId()    { return 'task-' + crypto.randomBytes(8).toString('hex') }
function newContextId() { return 'ctx-' + crypto.randomBytes(8).toString('hex') }

function textPart(text) { return { text: String(text ?? ''), mediaType: 'text/plain' } }

// 从 v1.0 Message（或旧草案 message）提取纯文本
function extractTextFromMessage(message) {
  const parts = (message && Array.isArray(message.parts)) ? message.parts : []
  const chunks = []
  for (const p of parts) {
    if (!p || typeof p !== 'object') continue
    if (typeof p.text === 'string') chunks.push(p.text)
    else if (p.kind === 'text' && typeof p.text === 'string') chunks.push(p.text)
  }
  return chunks.join('\n').trim()
}

function buildAgentCard(baseUrl) {
  return {
    name: getAgentName() || 'BaiLongma',
    description: 'BaiLongma (Jarvis) — a general-purpose local agent reachable over A2A.',
    url: baseUrl + '/',
    version: '1.0.0',
    provider: { organization: 'BaiLongma', url: baseUrl + '/' },
    supportedInterfaces: [
      { url: baseUrl + '/', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
    ],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
      extendedAgentCard: false,
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [
      { id: 'general', name: 'general', description: 'General-purpose conversational agent', tags: ['general'] },
    ],
  }
}

// ── 回信等待 ──────────────────────────────────────────────────────────
function waitForReply(partyId, timeoutMs) {
  return new Promise((resolve) => {
    const waiter = { resolve, timer: null }
    if (!pendingByParty.has(partyId)) pendingByParty.set(partyId, new Set())
    pendingByParty.get(partyId).add(waiter)
    waiter.timer = setTimeout(() => {
      pendingByParty.get(partyId)?.delete(waiter)
      resolve(null) // 超时
    }, timeoutMs)
  })
}

let replyListener = null
function ensureReplyListener() {
  if (replyListener) return
  replyListener = subscribeEvent('message', (data) => {
    const to = data?.to
    if (!to) return
    const waiters = pendingByParty.get(to)
    if (!waiters || waiters.size === 0) return
    const content = data?.content || ''
    for (const w of [...waiters]) {
      clearTimeout(w.timer)
      pendingByParty.get(to)?.delete(w)
      w.resolve({ text: content })
    }
    if (pendingByParty.get(to)?.size === 0) pendingByParty.delete(to)
  })
}

// ── JSON-RPC 方法 ─────────────────────────────────────────────────────
function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

async function handleSend(id, params) {
  const message = (params && typeof params === 'object') ? (params.message || {}) : {}
  const text = extractTextFromMessage(message)
  if (!text) return rpcError(id, ERR_INVALID_PARAMS, 'message text required')

  const contextId = message.contextId || params.contextId || newContextId()
  const partyId = `A2A:${contextId}`
  const taskId = newTaskId()
  const task = {
    id: taskId,
    contextId,
    status: {
      state: STATE_WORKING,
      message: { role: 'agent', parts: [textPart('Task accepted.')] },
    },
    artifacts: [],
    createdAt: new Date().toISOString(),
  }
  tasks.set(taskId, task)

  // 推入主循环：user 优先级；agent 回信到 `A2A:<contextId>` 即被回信监听捕获
  pushMessage(partyId, text, 'A2A', {
    persist: true,
    a2a_task_id: taskId,
    peer: params.peer || '',
  })

  const reply = await waitForReply(partyId, DEFAULT_REPLY_TIMEOUT_MS)
  if (!reply) {
    task.status.state = STATE_FAILED
    task.status.message = { role: 'agent', parts: [textPart('Agent did not reply within the A2A timeout.')] }
  } else {
    task.status.state = STATE_COMPLETED
    task.status.message = { role: 'agent', parts: [textPart(reply.text)] }
    task.artifacts = [{ id: `out-${taskId.slice(-8)}`, name: 'reply', parts: [textPart(reply.text)] }]
  }
  // v1.0 SendMessageResponse：{ task }
  return { jsonrpc: '2.0', id, result: { task } }
}

function handleGet(id, params) {
  const taskId = String(params?.taskId || params?.id || '')
  const task = tasks.get(taskId)
  if (!task) return rpcError(id, ERR_TASK_NOT_FOUND, `task not found: ${taskId}`)
  return { jsonrpc: '2.0', id, result: task }
}

function handleList(id, params) {
  const ctx = String(params?.contextId || '')
  const list = [...tasks.values()].filter(t => !ctx || t.contextId === ctx)
  return { jsonrpc: '2.0', id, result: { tasks: list } }
}

function handleCancel(id, params) {
  const taskId = String(params?.taskId || params?.id || '')
  const task = tasks.get(taskId)
  if (!task) return rpcError(id, ERR_TASK_NOT_FOUND, `task not found: ${taskId}`)
  if (task.status.state !== STATE_SUBMITTED && task.status.state !== STATE_WORKING) {
    return rpcError(id, ERR_TASK_NOT_CANCELABLE, `task ${taskId} already ${task.status.state}`)
  }
  task.status.state = STATE_CANCELED
  task.status.message = { role: 'agent', parts: [textPart('Task canceled.')] }
  return { jsonrpc: '2.0', id, result: task }
}

async function handleRPC(body) {
  if (!body || typeof body !== 'object' || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    return rpcError(body?.id ?? null, ERR_PARSE, 'Invalid Request')
  }
  const { id, method, params } = body
  switch (method) {
    case 'message/send': case 'SendMessage':
      return await handleSend(id, params)
    case 'tasks/get': case 'GetTask':
      return handleGet(id, params)
    case 'tasks/list': case 'ListTasks':
      return handleList(id, params)
    case 'tasks/cancel': case 'CancelTask':
      return handleCancel(id, params)
    // 流式 / 推送：本服务端暂不支持，返回 method-not-found（Agent Card 里 streaming=false）
    default:
      return rpcError(id, ERR_METHOD_NOT_FOUND, `method not found: ${method}`)
  }
}

// ── HTTP 服务 ─────────────────────────────────────────────────────────
function defaultHost() {
  const envHost = String(process.env?.BAILONGMA_HOST || '').trim()
  if (envHost) return envHost
  const lan = /^(1|true|yes|on)$/i.test(String(process.env?.BAILONGMA_ALLOW_LAN || '').trim())
  return lan ? '0.0.0.0' : '127.0.0.1'
}

export function startA2AServer({ port = null, host = null } = {}) {
  const resolvedPort = port || Number(process.env.BAILONGMA_A2A_PORT) || 9910
  const resolvedHost = host || defaultHost()

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${resolvedHost}:${resolvedPort}`)

    // Agent Card 发现（多个路径兼容）
    if (req.method === 'GET' && (
      url.pathname === '/.well-known/agent-card.json'
      || url.pathname === '/.well-known/agent.json'
      || url.pathname === '/agent.json'
    )) {
      const baseUrl = `http://${resolvedHost}:${resolvedPort}`
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(buildAgentCard(baseUrl)))
      return
    }

    // JSON-RPC 2.0
    if (req.method === 'POST' && (url.pathname === '/' || url.pathname === '/rpc')) {
      let raw = ''
      req.on('data', d => { raw += d })
      req.on('end', async () => {
        let body
        try { body = JSON.parse(raw || '{}') } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(rpcError(null, ERR_PARSE, 'parse error')))
          return
        }
        try {
          const resp = await handleRPC(body)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(resp))
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(rpcError(body?.id ?? null, -32000, String(e?.message || e))))
        }
      })
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })

  return new Promise((resolve) => {
    server.listen(resolvedPort, resolvedHost, () => {
      const actualPort = server.address().port
      const baseUrl = `http://${resolvedHost}:${actualPort}`
      ensureReplyListener()
      console.log(`[A2A] Agent Card + JSON-RPC serving at ${baseUrl}`)
      console.log(`[A2A]   GET  /.well-known/agent-card.json | POST / (JSON-RPC)`)
      resolve({
        server,
        baseUrl,
        close: () => new Promise(r => { try { server.close(() => r()) } catch { r() } }),
      })
    })
  })
}

