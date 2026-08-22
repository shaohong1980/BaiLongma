// 多Agent办公室 PTY 管理器
// 让 CLI 引擎以真实伪终端运行，而不是一次性 spawn 后等待文本返回。
// 输出通过 SSE 推给 Brain UI，历史缓存保留最近一段可回看内容。
import pty from 'node-pty'
import { emitEvent } from '../events.js'

const MAX_HISTORY = 200_000
const DEFAULT_COLS = 100
const DEFAULT_ROWS = 30

const sessions = new Map()

function normalizeAgentId(value = '') {
  return String(value || '').trim().toLowerCase().slice(0, 80) || 'default'
}

function nowIso() {
  return new Date().toISOString()
}

function trimHistory(text = '') {
  return text.length > MAX_HISTORY ? text.slice(-MAX_HISTORY) : text
}

function shellCommand() {
  if (process.platform === 'win32') {
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c'] }
  }
  return { file: process.env.SHELL || '/bin/sh', args: ['-lc'] }
}

function snapshot(agentId, session = sessions.get(agentId)) {
  return {
    agent_id: agentId,
    running: !!session && !session.exited,
    exited: !!session && session.exited,
    exit_code: session ? session.exitCode : null,
    started_at: session ? session.startedAt : null,
    updated_at: session ? session.updatedAt : null,
    history: session ? session.history : '',
    cols: session ? session.cols : DEFAULT_COLS,
    rows: session ? session.rows : DEFAULT_ROWS,
  }
}

function ensureNoLiveSession(agentId) {
  const old = sessions.get(agentId)
  if (old && !old.exited) {
    try { old.pty.kill() } catch { /* already gone */ }
  }
}

function emitState(agentId, session) {
  const data = snapshot(agentId, session)
  try { emitEvent('agent_pty_state', data) } catch { /* event bus unavailable */ }
  return data
}

function emitData(agentId, data) {
  try {
    emitEvent('agent_pty_data', {
      agent_id: agentId,
      data: String(data || ''),
      ts: nowIso(),
    })
  } catch { /* event bus unavailable */ }
}

/**
 * 启动一个 PTY 会话并返回其 promise。
 * 命令退出或进程被杀时 resolve，返回 { output, exitCode, signal }。
 */
export function runPtyCommand(agentId, command, options = {}) {
  const id = normalizeAgentId(agentId)
  const cmd = String(command || '').trim()
  if (!cmd) return Promise.reject(new Error('PTY 命令为空'))

  ensureNoLiveSession(id)
  const { file, args } = shellCommand()
  const cols = Number(options.cols) > 0 ? Number(options.cols) : DEFAULT_COLS
  const rows = Number(options.rows) > 0 ? Number(options.rows) : DEFAULT_ROWS
  const cwd = String(options.cwd || '').trim() || process.cwd()

  let proc
  try {
    proc = pty.spawn(file, [...args, cmd], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: { ...process.env, ...(options.env || {}) },
    })
  } catch (err) {
    return Promise.reject(err)
  }

  const session = {
    pty: proc,
    agentId: id,
    history: '',
    exited: false,
    exitCode: null,
    startedAt: nowIso(),
    updatedAt: nowIso(),
    cols,
    rows,
  }
  sessions.set(id, session)
  emitState(id, session)

  let resolveExit
  let rejectExit
  const exitPromise = new Promise((resolve, reject) => {
    resolveExit = resolve
    rejectExit = reject
  })

  proc.onData((data) => {
    session.history = trimHistory(session.history + String(data || ''))
    session.updatedAt = nowIso()
    emitData(id, data)
  })

  proc.onExit(({ exitCode, signal }) => {
    session.exited = true
    session.exitCode = exitCode
    session.updatedAt = nowIso()
    emitState(id, session)
    resolveExit({ output: session.history, exitCode, signal })
  })

  proc.onDataError?.((err) => {
    rejectExit(err)
  })

  const stdin = String(options.stdin || '')
  if (stdin) {
    proc.write(stdin.endsWith('\n') ? stdin : `${stdin}\r`)
  }

  return exitPromise
}

/**
 * 启动一个交互式常驻 shell 会话（不执行单条命令，用户可在终端里敲命令）。
 * 供「实时终端」页签手动开启；CLI 引擎运行时则由 runPtyCommand 管理单次会话。
 * 返回 { ok, session } 或 { ok:false, error }。
 */
export function startPtyShell(agentId, options = {}) {
  const id = normalizeAgentId(agentId)
  ensureNoLiveSession(id)
  const isWin = process.platform === 'win32'
  const file = isWin ? (process.env.ComSpec || 'cmd.exe') : (process.env.SHELL || '/bin/sh')
  const args = isWin ? [] : ['-i']
  const cols = Number(options.cols) > 0 ? Number(options.cols) : DEFAULT_COLS
  const rows = Number(options.rows) > 0 ? Number(options.rows) : DEFAULT_ROWS
  const cwd = String(options.cwd || '').trim() || process.cwd()

  let proc
  try {
    proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: { ...process.env, ...(options.env || {}) },
    })
  } catch (err) {
    return { ok: false, error: err?.message || String(err) }
  }

  const session = {
    pty: proc,
    agentId: id,
    history: '',
    exited: false,
    exitCode: null,
    startedAt: nowIso(),
    updatedAt: nowIso(),
    cols,
    rows,
  }
  sessions.set(id, session)
  emitState(id, session)

  proc.onData((data) => {
    session.history = trimHistory(session.history + String(data || ''))
    session.updatedAt = nowIso()
    emitData(id, data)
  })
  proc.onExit(({ exitCode }) => {
    session.exited = true
    session.exitCode = exitCode
    session.updatedAt = nowIso()
    emitState(id, session)
  })
  proc.onDataError?.(() => { /* 交互终端不做 promise，错误仅记录 */ })

  return { ok: true, session: snapshot(id) }
}

export function getPtySnapshot(agentId) {
  return snapshot(normalizeAgentId(agentId))
}

export function writePtyInput(agentId, data = '') {
  const id = normalizeAgentId(agentId)
  const session = sessions.get(id)
  if (!session || session.exited) return { ok: false, error: '该 Agent 没有运行中的 PTY' }
  try {
    session.pty.write(String(data))
    session.updatedAt = nowIso()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err?.message || String(err) }
  }
}

export function resizePty(agentId, cols, rows) {
  const id = normalizeAgentId(agentId)
  const session = sessions.get(id)
  if (!session || session.exited) return { ok: false, error: '该 Agent 没有运行中的 PTY' }
  const nextCols = Number(cols) > 0 ? Number(cols) : DEFAULT_COLS
  const nextRows = Number(rows) > 0 ? Number(rows) : DEFAULT_ROWS
  try {
    session.pty.resize(nextCols, nextRows)
    session.cols = nextCols
    session.rows = nextRows
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err?.message || String(err) }
  }
}

export function killPty(agentId) {
  const id = normalizeAgentId(agentId)
  const session = sessions.get(id)
  if (!session || session.exited) return { ok: false, error: '没有运行中的 PTY' }
  try {
    session.pty.kill()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err?.message || String(err) }
  }
}

export function clearPtyHistory(agentId) {
  const id = normalizeAgentId(agentId)
  const session = sessions.get(id)
  if (!session) return { ok: false, error: '没有 PTY 历史' }
  session.history = ''
  session.updatedAt = nowIso()
  emitState(id, session)
  return { ok: true }
}

export function cleanPtyText(text = '') {
  return String(text || '')
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
}
