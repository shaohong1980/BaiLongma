// client.js —— 极简 MCP（Model Context Protocol）stdio 客户端
//
// 实现参考 openhuman / hermes mcp_serve / openclaw tdoc-mcp-bridge 的客户端侧：
// 以子进程方式拉起用户配置的 MCP 服务器（stdio transport），通过 line-delimited JSON-RPC 2.0
// 通信：initialize → initialized 通知 → tools/list → tools/call。
//
// 特性：
//  - 按 server 名做连接池（惰性建连 + 超时自动销毁）。
//  - 每次 tools/call 前确保已初始化（initialize 幂等）。
//  - 请求带超时；进程意外退出 → 失败返回，下次自动重连。
//  - 所有函数绝不 throw 到调用方：返回 { ok:true, ... } / { ok:false, error }。
//
// 安全：只能连接 servers-config.js 里显式配置的服务器；不暴露任意命令执行。

import { spawn } from 'child_process'
import { getMcpServer } from './servers-config.js'

const INIT_TIMEOUT_MS = 15_000
const REQUEST_TIMEOUT_MS = 60_000
const MAX_PENDING = 64

// name -> { proc, stdin, pending: Map<id,{resolve,reject,timer}>, nextId, initialized, toolsCache }
const pool = new Map()

function makeRequestId(conn) {
  conn.nextId = (conn.nextId || 0) + 1
  return conn.nextId
}

// 从子进程 stdout 缓冲里提取完整的 JSON-RPC 消息（服务端可能一次写多行或半行）。
function attachStdoutParser(conn) {
  conn.buffer = conn.buffer || ''
  conn.proc.stdout.on('data', (chunk) => {
    conn.buffer += chunk.toString('utf-8')
    let idx
    while ((idx = conn.buffer.indexOf('\n')) >= 0) {
      const line = conn.buffer.slice(0, idx).trim()
      conn.buffer = conn.buffer.slice(idx + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg && typeof msg.id !== 'undefined') {
        const pending = conn.pending.get(msg.id)
        if (!pending) continue
        conn.pending.delete(msg.id)
        clearTimeout(pending.timer)
        if (msg.error) pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)))
        else pending.resolve(msg.result || {})
      }
    }
  })
}

function shutdown(conn) {
  clearTimeout(conn.shutdownTimer)
  try { conn.proc.kill() } catch { /* ignore */ }
  try { conn.stdin.end() } catch { /* ignore */ }
  for (const [, p] of conn.pending) {
    clearTimeout(p.timer)
    p.reject(new Error('MCP server process exited'))
  }
  conn.pending.clear()
  pool.delete(conn.name)
}

async function ensureConnection(name) {
  const existing = pool.get(name)
  if (existing && existing.proc && !existing.proc.killed && existing.stdin.writable) {
    return { conn: existing }
  }
  const entry = getMcpServer(name)
  if (!entry) return { error: `MCP 服务器「${name}」未在 data/mcp-servers.json 中配置` }
  if (!entry.enabled) return { error: `MCP 服务器「${name}」已被禁用` }

  // 旧的死连接先清掉
  if (existing) shutdown(existing)

  const conn = { name, pending: new Map(), nextId: 0, buffer: '', initialized: false, toolsCache: null }
  let proc
  try {
    proc = spawn(entry.command, entry.args || [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(entry.env || {}) },
      windowsHide: true,
    })
  } catch (err) {
    return { error: `无法启动 MCP 服务器「${name}」：${err.message}` }
  }
  conn.proc = proc
  conn.stdin = proc.stdin
  pool.set(name, conn)
  attachStdoutParser(conn)
  proc.stderr.on('data', (d) => { /* 保留但不外抛，诊断时可启用 */ })
  proc.on('error', (err) => { if (pool.get(name) === conn) { conn.lastError = err.message; shutdown(conn) } })
  proc.on('exit', () => { if (pool.get(name) === conn) shutdown(conn) })

  return { conn }
}

function sendRequest(conn, method, params, { timeout = REQUEST_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    if (conn.pending.size >= MAX_PENDING) {
      reject(new Error('MCP 请求队列已满'))
      return
    }
    const id = makeRequestId(conn)
    const timer = setTimeout(() => {
      conn.pending.delete(id)
      reject(new Error(`MCP 请求超时（${method}，${timeout}ms）`))
    }, timeout)
    conn.pending.set(id, { resolve, reject, timer })
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} })
    try {
      conn.stdin.write(body + '\n', 'utf-8')
    } catch (err) {
      clearTimeout(timer)
      conn.pending.delete(id)
      reject(err)
    }
  })
}

async function initialize(conn) {
  if (conn.initialized) return true
  const result = await sendRequest(conn, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'bailongma', version: '2.1.515' },
  }, { timeout: INIT_TIMEOUT_MS })
  // initialized 通知（fire-and-forget）
  try {
    conn.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n', 'utf-8')
  } catch { /* ignore */ }
  conn.initialized = true
  conn.serverInfo = result?.serverInfo || null
  return true
}

// 列出某服务器的可用工具（带缓存）
export async function listServerTools(name) {
  const connResult = await ensureConnection(name)
  if (connResult.error) return { ok: false, error: connResult.error }
  try {
    await initialize(connResult.conn)
    if (connResult.conn.toolsCache) return { ok: true, server: name, tools: connResult.conn.toolsCache }
    const result = await sendRequest(connResult.conn, 'tools/list', {})
    const tools = Array.isArray(result?.tools) ? result.tools.map(t => ({
      name: t.name,
      description: String(t.description || ''),
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
    })) : []
    connResult.conn.toolsCache = tools
    return { ok: true, server: name, tools, serverInfo: connResult.conn.serverInfo }
  } catch (err) {
    return { ok: false, server: name, error: err.message }
  }
}

// 调用某服务器上的工具
export async function callMcpTool(server, tool, args) {
  const connResult = await ensureConnection(server)
  if (connResult.error) return { ok: false, error: connResult.error }
  try {
    await initialize(connResult.conn)
    const result = await sendRequest(connResult.conn, 'tools/call', { name: tool, arguments: args || {} })
    const content = Array.isArray(result?.content) ? result.content : []
    const text = content
      .map(c => (c.type === 'text' ? String(c.text || '') : (c.type === 'image' ? '[image]' : '')))
      .filter(Boolean)
      .join('\n')
    return { ok: true, server, tool, result: text, isError: !!result?.isError }
  } catch (err) {
    return { ok: false, server, tool, error: err.message }
  }
}

// 列出全部已配置服务器的名称与工具（用于 mcp_list_servers）
export async function listAllServersWithTools() {
  const { listMcpServers } = await import('./servers-config.js')
  const servers = listMcpServers()
  const names = Object.keys(servers)
  const out = []
  for (const name of names) {
    const info = await listServerTools(name)
    out.push({ name, enabled: servers[name].enabled, command: servers[name].command, ok: info.ok, error: info.error || null, tools: info.tools || [] })
  }
  return { ok: true, servers: out }
}

export function disconnectAll() {
  for (const conn of [...pool.values()]) shutdown(conn)
  pool.clear()
}

