// a2a-client.js —— A2A（Agent2Agent）标准协议客户端
//
// 与外部 Agent 通信的统一通道。规范：https://a2a-protocol.org
// 交互模型：
//   - Agent Card 发现：GET {baseUrl}/.well-known/agent.json 或 {baseUrl}/agent.json
//   - JSON-RPC 2.0 over HTTP：POST {baseUrl}/
//       · tasks/send  —— 创建任务（携带 user message）
//       · tasks/get   —— 查询任务状态（submitted/working/input-required/completed/failed/canceled）
//       · tasks/cancel—— 取消任务
//   - 任务结果：Task.status.message / Task.artifacts[].parts 里的 TextPart / FilePart / DataPart
//
// 设计约定（对齐 mcp/client.js 的既有风格）：
//   - 所有导出函数绝不 throw，统一返回 { ok: true, ... } / { ok: false, error }。
//   - 请求全部带超时；AbortSignal 可传入（供主循环抢占/看门狗中断）。
//   - 同步委托场景用 runTask()：tasks/send → 轮询 tasks/get 至终态 → 提取文本。

// ── 常量 ──────────────────────────────────────────────────────────────
const AGENT_CARD_PATHS = ['/.well-known/agent.json', '/agent.json']
const JSONRPC_ENDPOINT = '/'
const DEFAULT_CARD_TIMEOUT_MS = 8000
const DEFAULT_TASK_TIMEOUT_MS = 120_000
const DEFAULT_POLL_INTERVAL_MS = 1000
const TERMINAL_STATES = new Set(['completed', 'failed', 'canceled'])
const PROBE_TIMEOUT_MS = 3000

function joinBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '')
}

function makeRequestId() {
  return `a2a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function isTerminal(state) {
  return TERMINAL_STATES.has(String(state || '').toLowerCase())
}

// ── 底层 JSON-RPC 请求 ────────────────────────────────────────────────
async function rpcRequest(baseUrl, method, params, { timeoutMs = 30_000, signal = null } = {}) {
  const url = joinBaseUrl(baseUrl) + JSONRPC_ENDPOINT
  const controller = new AbortController()
  let timer = null
  const onOuterAbort = () => { try { controller.abort(signal?.reason || 'aborted') } catch {} }
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason || 'aborted')
    else signal.addEventListener('abort', onOuterAbort, { once: true })
  }
  if (!controller.signal.aborted) {
    timer = setTimeout(() => controller.abort(`timeout ${timeoutMs}ms`), timeoutMs)
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: makeRequestId(), method, params: params || {} }),
      signal: controller.signal,
    })
    if (!res.ok) return { ok: false, error: `A2A HTTP ${res.status} from ${url}` }
    let data
    try { data = await res.json() } catch { return { ok: false, error: `A2A ${method} 响应不是合法 JSON` } }
    if (data?.error) {
      return { ok: false, error: (data.error.message || JSON.stringify(data.error)).slice(0, 300) }
    }
    return { ok: true, result: data?.result ?? null }
  } catch (err) {
    const reason = err?.name === 'AbortError'
      ? String(controller.signal?.reason || 'aborted')
      : (err?.message || String(err))
    return { ok: false, error: `A2A ${method} 失败：${reason}` }
  } finally {
    if (timer) clearTimeout(timer)
    try { signal?.removeEventListener('abort', onOuterAbort) } catch {}
  }
}

// ── Agent Card 发现 ───────────────────────────────────────────────────
// 尝试标准路径；baseUrl 也可直接指向 agent.json 文件本身（便于手工配置）。
export async function fetchAgentCard(baseUrl, { timeoutMs = DEFAULT_CARD_TIMEOUT_MS, signal = null } = {}) {
  const base = joinBaseUrl(baseUrl)
  if (!base) return { ok: false, error: 'A2A: 缺少 base URL' }

  // baseUrl 直接指向一个 agent.json / *.json 文件
  if (/\.json$/i.test(base)) {
    const r = await fetchJson(base, timeoutMs, signal)
    if (r.ok && r.data && typeof r.data === 'object') return { ok: true, card: r.data, cardUrl: base }
    return { ok: false, error: 'A2A: 未能在指定 URL 读到 Agent Card' }
  }

  for (const p of AGENT_CARD_PATHS) {
    const r = await fetchJson(base + p, timeoutMs, signal)
    if (r.ok && r.data && typeof r.data === 'object') {
      return { ok: true, card: r.data, cardUrl: base + p }
    }
  }
  return { ok: false, error: 'A2A: 未发现 Agent Card（/.well-known/agent.json 与 /agent.json 均无响应）' }
}

async function fetchJson(url, timeoutMs, signal) {
  const controller = new AbortController()
  let timer = null
  const onOuterAbort = () => { try { controller.abort(signal?.reason || 'aborted') } catch {} }
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason || 'aborted')
    else signal.addEventListener('abort', onOuterAbort, { once: true })
  }
  if (!controller.signal.aborted) timer = setTimeout(() => controller.abort('timeout'), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) return { ok: false }
    const data = await res.json()
    return { ok: true, data }
  } catch {
    return { ok: false }
  } finally {
    if (timer) clearTimeout(timer)
    try { signal?.removeEventListener('abort', onOuterAbort) } catch {}
  }
}

// ── Part / Task 文本提取 ──────────────────────────────────────────────
// 把 Task 里 status.message 与 artifacts 的全部 parts 压成可读文本。
export function extractTaskText(task = {}) {
  const parts = []
  const status = task.status || {}
  const statusParts = Array.isArray(status.message?.parts) ? status.message.parts : []
  const artifacts = Array.isArray(task.artifacts) ? task.artifacts : []
  const artifactParts = artifacts.flatMap(a => (Array.isArray(a.parts) ? a.parts : []))
  for (const part of [...statusParts, ...artifactParts]) {
    if (!part) continue
    if (part.kind === 'text' && typeof part.text === 'string' && part.text.trim()) {
      parts.push(part.text.trim())
    } else if (part.kind === 'file') {
      parts.push(`[文件: ${part.file?.name || 'unnamed'}]`)
    } else if (part.kind === 'data') {
      try { parts.push(`[数据: ${JSON.stringify(part.data || {})}]`) } catch { parts.push('[数据]') }
    }
  }
  return parts.join('\n').trim()
}

// 提取单一 message 的文本（message/send 场景）
export function extractMessageText(message = {}) {
  if (!Array.isArray(message.parts)) return ''
  const out = []
  for (const part of message.parts) {
    if (part?.kind === 'text' && typeof part.text === 'string') out.push(part.text)
  }
  return out.join('\n').trim()
}

// ── tasks 方法封装 ────────────────────────────────────────────────────
export async function sendTask(baseUrl, { taskId = null, text = '', metadata = null, timeoutMs = 30_000, signal = null } = {}) {
  const params = {
    id: taskId || makeRequestId(),
    message: { role: 'user', parts: [{ kind: 'text', text: String(text || '') }] },
  }
  if (metadata && typeof metadata === 'object' && Object.keys(metadata).length) params.metadata = metadata
  const r = await rpcRequest(baseUrl, 'tasks/send', params, { timeoutMs, signal })
  return r.ok ? { ok: true, task: r.result || {} } : r
}

export async function getTask(baseUrl, taskId, { timeoutMs = 30_000, signal = null } = {}) {
  const r = await rpcRequest(baseUrl, 'tasks/get', { id: taskId }, { timeoutMs, signal })
  return r.ok ? { ok: true, task: r.result || {} } : r
}

export async function cancelTask(baseUrl, taskId, { timeoutMs = 30_000, signal = null } = {}) {
  const r = await rpcRequest(baseUrl, 'tasks/cancel', { id: taskId }, { timeoutMs, signal })
  return r.ok ? { ok: true, task: r.result || {} } : r
}

// ── 一站式同步调用：tasks/send → 轮询 tasks/get → 提取文本 ───────────
// 返回 { ok, taskId, state, text, timed_out, task } 或 { ok:false, error }。
export async function runTask(baseUrl, {
  text = '',
  metadata = null,
  taskId = null,
  timeoutMs = DEFAULT_TASK_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  signal = null,
  onProgress = null,
} = {}) {
  const startedAt = Date.now()
  const sent = await sendTask(baseUrl, { taskId, text, metadata, timeoutMs: Math.min(30_000, timeoutMs), signal })
  if (!sent.ok) return sent

  const task = sent.task
  const id = task?.id
  if (!id) return { ok: false, error: 'A2A: tasks/send 响应缺少任务 id', task }

  let current = task
  let consecutiveErrors = 0

  while (!isTerminal(current.status?.state) && Date.now() - startedAt < timeoutMs) {
    const state = String(current.status?.state || '').toLowerCase()
    if (state === 'input-required') {
      // 外部 Agent 需要更多输入；同步委托场景无法交互式追问
      return { ok: false, taskId: id, state: 'input-required', error: '外部 Agent 要求补充输入，当前委托模式不支持交互式追问', task: current }
    }

    await new Promise(res => setTimeout(res, pollIntervalMs))
    const poll = await getTask(baseUrl, id, { timeoutMs: 30_000, signal })
    if (!poll.ok) {
      consecutiveErrors += 1
      if (consecutiveErrors >= 3) return { ...poll, taskId: id, task: current }
      continue
    }
    consecutiveErrors = 0
    current = poll.task
    onProgress?.(current)
  }

  const state = String(current.status?.state || '').toLowerCase()
  const reply = extractTaskText(current)
  const ok = isTerminal(state) && state !== 'failed' && state !== 'canceled'
  return {
    ok,
    taskId: id,
    state,
    text: reply,
    task: current,
    timed_out: !isTerminal(state) && Date.now() - startedAt >= timeoutMs,
  }
}

// 探测某 baseUrl 是否为 A2A 端点（detector 集成用，快速超时，不抛错）
export async function isA2AEndpoint(baseUrl, { timeoutMs = PROBE_TIMEOUT_MS, signal = null } = {}) {
  const r = await fetchAgentCard(baseUrl, { timeoutMs, signal })
  return r.ok
}

export const __internals = {
  AGENT_CARD_PATHS,
  JSONRPC_ENDPOINT,
  TERMINAL_STATES,
  isTerminal,
  extractMessageText,
}
