// global-summary-tree.js —— 全局记忆「鸟瞰」分层摘要树
//
// 痛点：现有记忆系统是"按需召回"（按消息相关性从 FTS5 拉 top-N），模型每轮只看到
// 与当前消息相关的碎片记忆，看不到"自己到底知道多少、有哪些主题"。OpenHuman 的思路是
// 把全部知识蒸馏成一棵分层摘要树，廉价地常驻上下文，让 agent 一眼看全量知识。
//
// 实现：纯规则、零 LLM、离线、绝不 throw。从 memories 表（visibility=1）读取全部可见记忆，
// 按「实体 → 类型」两级分组，每组保留最高 salience 的若干条，渲染成受控长度的鸟瞰文本。
// 结果缓存到 data/global-summary-tree.json，并带廉价失效（记忆条数 + 最新 created_at），
// 每轮只是一次缓存命中（零 DB IO 常态），记忆变化或超时才重建。
//
// 与现有系统正交：只读 memories 表，不改任何写入路径；getGlobalSummaryTreeText() 在主循环
// 每轮调用，挂在 <global-memory-overview> 段注入；maybeRebuildGlobalSummaryTree() 由整合循环
// 顺带触发以保持新鲜。

import fs from 'fs'
import path from 'path'

const TREE_FILE = 'global-summary-tree.json'
const MAX_CHARS = 2000          // 鸟瞰文本上限（廉价上下文）
const PER_GROUP_MAX = 3         // 每组每类型保留的最高 salience 记忆条数
const PER_TYPE_MAX = 3          // 每组最多展示的类型数
const REBUILD_INTERVAL_MS = 10 * 60 * 1000  // 至少 10 分钟重建一次（避免每轮重建）
const SCAN_CAP = 600            // 单轮最多扫描的记忆条数（按 salience+recency 取头部）

const TYPE_LABELS = {
  fact: '事实', person: '人物', object: '事物', knowledge: '知识',
  conversation: '对话', task_complete: '任务完成', focus_conclusion: '焦点结论',
  self_constraint: '自我约束', event: '事件', preference: '偏好',
  behavioral_constraint: '行为约束', opinion_expressed: '观点',
  impressive_statement: '印象', task_knowledge: '任务知识',
  default: '其他',
}

function typeLabel(t) { return TYPE_LABELS[t] || TYPE_LABELS.default }

function parseEntities(str) {
  try { const a = JSON.parse(str); return Array.isArray(a) ? a : [] } catch { return [] }
}

// ── 纯函数：从已取出的记忆行构建分层树（便于单测，不依赖 DB） ──
// rows: [{ event_type, content, title, entities, salience }]
// labelMap: { lowercaseEntityId: 展示名 }
export function buildTreeFromRows(rows = [], labelMap = {}) {
  const groups = new Map()  // key -> { name, salience, count, types: Map<typeLabel, [{content,title,salience}]> }
  let total = 0
  for (const m of rows) {
    total++
    const entities = parseEntities(m.entities)
    const rawKey = entities.length ? String(entities[0]).trim() : null
    const groupKey = rawKey ? (labelMap[rawKey.toLowerCase()] || rawKey) : null
    const name = groupKey || '通用记忆'
    const key = groupKey || '__general__'
    if (!groups.has(key)) groups.set(key, { name, salience: 0, count: 0, types: new Map() })
    const g = groups.get(key)
    g.count++
    const sal = Number(m.salience) || 0
    if (sal > g.salience) g.salience = sal
    const tl = typeLabel(m.event_type)
    if (!g.types.has(tl)) g.types.set(tl, [])
    g.types.get(tl).push({ content: String(m.content || ''), title: String(m.title || ''), salience: sal })
  }

  // 组按 salience 降序 → count 降序
  const sortedGroups = [...groups.values()].sort((a, b) => (b.salience - a.salience) || (b.count - a.count))
  // 组内：类型按条数降序、截断；类型内记忆按 salience 降序、截断
  for (const g of sortedGroups) {
    const types = [...g.types.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, PER_TYPE_MAX)
    g.typesRendered = types.map(([tl, mems]) => ({
      type: tl,
      mems: mems.sort((a, b) => (b.salience - a.salience)).slice(0, PER_GROUP_MAX),
    }))
  }
  return { total, groups: sortedGroups }
}

// ── 纯函数：把树渲染成受控长度的鸟瞰文本 ──
export function renderSummaryTree(tree, { maxChars = MAX_CHARS } = {}) {
  if (!tree || tree.total === 0) return ''
  const lines = []
  let entityCount = 0
  for (const g of tree.groups) if (g.name !== '通用记忆') entityCount++
  const header = `全局记忆鸟瞰（共 ${tree.total} 条记忆${entityCount ? `，${entityCount} 个实体/主题` : ''}）`
  lines.push(header)
  let len = header.length
  let truncated = false
  for (const g of tree.groups) {
    if (truncated) break
    const head = `## ${g.name}（${g.count} 条）`
    if (len + head.length + 1 > maxChars) { truncated = true; break }
    lines.push(head)
    len += head.length + 1
    for (const t of g.typesRendered) {
      for (const mem of t.mems) {
        const body = (mem.title ? `《${mem.title}》` : '') + mem.content
        const line = `- ${body}`
        if (len + line.length + 1 > maxChars) { truncated = true; break }
        lines.push(line)
        len += line.length + 1
      }
      if (truncated) break
    }
  }
  if (truncated) lines.push('（更多记忆见按需召回 / Obsidian vault）')
  return lines.join('\n')
}

// ── DB 读取（懒加载 db/paths，避免顶层依赖 electron 原生模块，便于单独测试） ──
let _dataDir = null
async function resolveDataDir() {
  if (_dataDir) return _dataDir
  try {
    const mod = await import('../paths.js')
    _dataDir = (mod.paths && mod.paths.dataDir) || path.join(process.cwd(), 'data')
  } catch {
    _dataDir = path.join(process.cwd(), 'data')
  }
  return _dataDir
}

function treeFilePath(dataDir) { return path.join(dataDir, TREE_FILE) }

async function loadRowsAndLabels() {
  const [{ getDB, getKnownEntities }] = await Promise.all([import('../db.js')])
  const db = getDB()
  const rows = db.prepare(
    `SELECT event_type, content, title, entities, salience, created_at
     FROM memories WHERE visibility = 1
     ORDER BY salience DESC, created_at DESC
     LIMIT ?`
  ).all(SCAN_CAP)
  const labelMap = {}
  try {
    for (const e of getKnownEntities()) labelMap[String(e.id).trim().toLowerCase()] = e.label || e.id
  } catch (e) { console.warn('[src/memory/global-summary-tree.js] op failed:', e?.message || e) }
  return { rows, labelMap }
}

function clampChars(text, maxChars) {
  if (!text) return ''
  if (maxChars && text.length > maxChars) return text.slice(0, maxChars)
  return text
}

let _cache = null  // { text, builtAt }

// 每轮调用：常态命中内存/磁盘缓存（零 DB IO），仅失效时重建
export async function getGlobalSummaryTreeText({ maxChars = MAX_CHARS } = {}) {
  try {
    const dataDir = await resolveDataDir()
    const file = treeFilePath(dataDir)
    const now = Date.now()

    // 1) 内存缓存
    if (_cache && now - _cache.builtAt < REBUILD_INTERVAL_MS && _cache.text) {
      return clampChars(_cache.text, maxChars)
    }
    // 2) 磁盘缓存：足够新则直接返回（零 DB IO）
    try {
      const st = fs.statSync(file)
      if (now - st.mtimeMs < REBUILD_INTERVAL_MS) {
        const text = fs.readFileSync(file, 'utf-8')
        _cache = { text, builtAt: st.mtimeMs }
        return clampChars(text, maxChars)
      }
    } catch (e) { console.warn('[src/memory/global-summary-tree.js] op failed:', e?.message || e) }

    // 3) 失效：重建
    const tree = await buildGlobalSummaryTree({ dataDir, file })
    return clampChars(tree.text, maxChars)
  } catch {
    return _cache?.text || ''
  }
}

// 数据库扫描 + 渲染 + 落盘
export async function buildGlobalSummaryTree({ dataDir = null, file = null } = {}) {
  const dir = dataDir || await resolveDataDir()
  const f = file || treeFilePath(dir)
  const { rows, labelMap } = await loadRowsAndLabels()
  const tree = buildTreeFromRows(rows, labelMap)
  const text = renderSummaryTree(tree, { maxChars: MAX_CHARS })
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(f, JSON.stringify({ builtAt: Date.now(), total: tree.total, text }), 'utf-8')
  } catch (err) {
    // 摘要树缓存写失败 → 每次构建都全量重算（性能损失），值得提示而非静默
    console.warn('[global-summary-tree] 摘要树缓存写入失败（将每次重建）:', err?.message || err)
  }
  return { ...tree, text }
}

// 节流重建：由整合循环顺带触发（记忆整理 ≠ 实体整合，但都该保持鸟瞰新鲜）
let _lastRebuild = 0
export async function maybeRebuildGlobalSummaryTree({ minIntervalMs = REBUILD_INTERVAL_MS, force = false } = {}) {
  const now = Date.now()
  if (!force && now - _lastRebuild < minIntervalMs) return { ok: true, skipped: true }
  _lastRebuild = now
  try {
    const dir = await resolveDataDir()
    const f = treeFilePath(dir)
    const { rows, labelMap } = await loadRowsAndLabels()
    const tree = buildTreeFromRows(rows, labelMap)
    const text = renderSummaryTree(tree, { maxChars: MAX_CHARS })
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(f, JSON.stringify({ builtAt: Date.now(), total: tree.total, text }), 'utf-8')
    _cache = { text, builtAt: Date.now() }
    return { ok: true, total: tree.total }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
}

// 状态查询（供 UI / 调试）
export async function getGlobalSummaryTreeStatus() {
  try {
    const dir = await resolveDataDir()
    const f = treeFilePath(dir)
    if (!fs.existsSync(f)) return { exists: false }
    const st = fs.statSync(f)
    const parsed = JSON.parse(fs.readFileSync(f, 'utf-8'))
    return { exists: true, total: parsed.total, builtAt: parsed.builtAt, mtime: st.mtimeMs, chars: (parsed.text || '').length }
  } catch (e) {
    return { exists: false, error: String(e?.message || e) }
  }
}
