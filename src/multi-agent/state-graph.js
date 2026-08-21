// state-graph.js —— 学 LangGraph 的极简状态图引擎（纯 Node，零依赖）
// 能力：节点/边/条件边/并行(fan-out·fan-in)/reducer 合并/checkpoint 断点续跑/
//       interrupt 人工审批/回放审计。
// 执行模型：superstep（波）推进；就绪判定 = pendingSources 累积 + 本波预期来源。
import fs from 'fs'
import path from 'path'

const BUILTIN = {
  add: (a, b) => {
    const arrA = Array.isArray(a) ? a : (a === undefined || a === null ? [] : [a])
    const arrB = Array.isArray(b) ? b : (b === undefined || b === null ? [] : [b])
    return [...arrA, ...arrB]
  },
  merge: (a, b) => ({ ...(a || {}), ...(b || {}) }),
  overwrite: (_a, b) => b,
}

export class StateGraph {
  constructor({ checkpointDir = null } = {}) {
    this.nodes = new Map()
    this.edges = new Map()
    this.condEdges = new Map()
    this.reducers = new Map()
    this.incoming = new Map()
    this.entry = null
    this.checkpointDir = checkpointDir
    this._frozen = false
  }

  addNode(name, fn, { approval = false } = {}) {
    if (this._frozen) throw new Error('图已 compile，不能再加节点')
    this.nodes.set(name, { fn, approval })
    if (!this.incoming.has(name)) this.incoming.set(name, new Set())
    return this
  }

  addEdge(from, to) {
    if (!this.nodes.has(from)) this.nodes.set(from, { fn: async (s) => s })
    if (!this.nodes.has(to)) this.nodes.set(to, { fn: async (s) => s })
    if (!this.edges.has(from)) this.edges.set(from, [])
    this.edges.get(from).push(to)
    if (!this.incoming.has(to)) this.incoming.set(to, new Set())
    this.incoming.get(to).add(from)
    return this
  }

  addConditionalEdge(from, route, map) {
    if (!this.nodes.has(from)) this.nodes.set(from, { fn: async (s) => s })
    for (const to of Object.values(map)) {
      if (!this.nodes.has(to)) this.nodes.set(to, { fn: async (s) => s })
      if (!this.incoming.has(to)) this.incoming.set(to, new Set())
      this.incoming.get(to).add(from)
    }
    this.condEdges.set(from, { route, map })
    return this
  }

  addReducer(key, reducer) {
    this.reducers.set(key, typeof reducer === 'function' ? reducer : (BUILTIN[reducer] || BUILTIN.overwrite))
    return this
  }

  addApproval(name) {
    const n = this.nodes.get(name)
    if (!n) throw new Error('未知节点: ' + name)
    n.approval = true
    return this
  }

  setEntry(name) {
    this.entry = name
    return this
  }

  compile() {
    this._frozen = true
    if (!this.entry) throw new Error('未设置入口（setEntry）')
    const g = this
    return {
      invoke: (initial, opts) => g._invoke(initial, opts),
      resume: (threadId, opts) => g._resume(threadId, opts),
      getState: (threadId) => g._getState(threadId),
      nodes: [...g.nodes.keys()],
    }
  }

  // ── 检查点 ──────────────────────────────────────────────────────────
  _cpPath(threadId) {
    if (!this.checkpointDir) return null
    return path.join(this.checkpointDir, String(threadId).replace(/[^\w-]/g, '_') + '.json')
  }
  _loadCp(threadId) {
    const p = this._cpPath(threadId)
    if (!p || !fs.existsSync(p)) return null
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')) } catch { return null }
  }
  _saveCp(threadId, snap) {
    const p = this._cpPath(threadId)
    if (!p) return
    try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(snap, null, 2), 'utf-8') } catch (e) { console.warn('[src/multi-agent/state-graph.js] op failed:', e?.message || e) }
  }

  _applyUpdate(state, update) {
    for (const [k, v] of Object.entries(update || {})) {
      const red = this.reducers.get(k)
      state[k] = red ? red(state[k], v) : v
    }
  }

  async _runNode(name, state, audit, onStep) {
    const n = this.nodes.get(name)
    const t0 = Date.now()
    const update = await n.fn(state, { name })
    const keysChanged = Object.keys(update || {})
    this._applyUpdate(state, update)
    audit.push({ node: name, ts: new Date().toISOString(), ms: Date.now() - t0, keysChanged })
    if (onStep) await onStep({ node: name, update, state: { ...state } })
  }

  // ── 主执行：波推进 ──────────────────────────────────────────────────
  async _wave(state, audit, pendingSources, fired, onStep, threadId, forceRun = null) {
    let guard = 0
    while (guard++ < 200) {
      const prevFired = new Set(fired)
      fired.clear()
      const ready = []
      for (const [name, srcs] of pendingSources) {
        if (!srcs || srcs.size === 0) continue
        const incoming = this.incoming.get(name) || new Set()
        const expected = [...incoming].filter(s => prevFired.has(s) || s === '__start' || s === '__resume')
        if (expected.length === 0 || [...expected].every(s => srcs.has(s))) ready.push(name)
      }
      if (ready.length === 0) break
      const results = await Promise.all(ready.map(async (name) => {
        const node = this.nodes.get(name)
        // 人工审批：非恢复放行时才暂停
        if (node.approval && !(forceRun && forceRun.has(name))) {
          const w = { node: name, state: { ...state }, audit: [...audit], threadId,
                      pendingSources: [...pendingSources].map(([k, v]) => [k, [...v]]), fired: [...fired] }
          this._saveCp(threadId, w)
          return { name, interrupted: true }
        }
        await this._runNode(name, state, audit, onStep)
        this._saveCp(threadId, { node: '__checkpoint', state: { ...state }, audit: [...audit], threadId })
        return { name, interrupted: false }
      }))
      const hit = results.find(r => r.interrupted)
      if (hit) return { interrupted: true, waitingNode: hit.name, state, audit }
      for (const r of results) {
        const name = r.name
        fired.add(name)
        pendingSources.delete(name)
        for (const to of (this.edges.get(name) || [])) {
          if (!pendingSources.has(to)) pendingSources.set(to, new Set())
          pendingSources.get(to).add(name)
        }
        const cond = this.condEdges.get(name)
        if (cond) {
          const key = cond.route(state)
          const target = cond.map[key]
          if (!target) throw new Error('条件路由未知分支: ' + key)
          if (!pendingSources.has(target)) pendingSources.set(target, new Set())
          pendingSources.get(target).add(name)
        }
      }
    }
    return { interrupted: false, state, audit }
  }

  async _invoke(initial, { threadId = 'default', onStep = null } = {}) {
    const state = { ...(initial || {}), __threadId: threadId }
    const audit = []
    const pendingSources = new Map([[this.entry, new Set(['__start'])]])
    const fired = new Set()
    const res = await this._wave(state, audit, pendingSources, fired, onStep, threadId)
    return { ...res, state: { ...state }, audit, threadId }
  }

  // 断点续跑 / 人工审批恢复
  async _resume(threadId, { approved = true, note = '', onStep = null } = {}) {
    const cp = this._loadCp(threadId)
    if (!cp) throw new Error('没有可续跑的检查点: ' + threadId)
    if (cp.node !== '__checkpoint') {
      // 处于审批等待：approved=true 继续执行，否则留在原地
      if (!approved) {
        cp.audit.push({ node: '__reject', ts: new Date().toISOString(), ms: 0, note: String(note || '') })
        this._saveCp(threadId, cp)
        return { interrupted: false, rejected: true, state: cp.state, audit: cp.audit, threadId }
      }
      cp.audit.push({ node: '__approve', ts: new Date().toISOString(), ms: 0, note: String(note || '') })
      const pendingSources = new Map(cp.pendingSources.map(([k, v]) => [k, new Set(v)]))
      pendingSources.set(cp.node, new Set(['__resume']))
      const fired = new Set(cp.fired || [])
      const res = await this._wave(cp.state, cp.audit, pendingSources, fired, onStep, threadId, new Set([cp.node]))
      this._saveCp(threadId, { node: '__checkpoint', state: { ...cp.state }, audit: cp.audit, threadId })
      return { ...res, resumed: true, state: { ...cp.state }, audit: cp.audit, threadId }
    }
    return { resumed: false, state: cp.state, audit: cp.audit, threadId }
  }

  _getState(threadId) {
    const cp = this._loadCp(threadId)
    return cp ? { state: cp.state, audit: cp.audit } : null
  }
}
