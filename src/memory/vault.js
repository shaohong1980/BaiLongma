// vault.js —— 记忆树 + Obsidian 镜像
//
// 把 memories 表（已有 parent_id/salience/entities 结构）构建成「记忆树」，
// 导出为 Obsidian vault（用户目录 data/vault/）：每个实体一个 .md（双链 [[..]] +
// frontmatter），外加总览索引页。用户能用 Obsidian 打开、阅读、手改 AI 的记忆。
//
// 与现有记忆系统衔接：只读 memories/entities 表，不改任何写入路径；导出是纯
// 副作用（写 md 文件），由 consolidation-loop 定期或用户手动触发。

import fs from 'fs'
import path from 'path'
import { exec } from 'child_process'
import { getDB, getKnownEntities } from '../db.js'
import { paths } from '../paths.js'

const VAULT_DIR = path.join(paths.dataDir, 'vault')

// 记忆类型 → 中文标签（Obsidian frontmatter / 分组用）
const TYPE_LABELS = {
  fact: '事实', person: '人物', object: '事物', knowledge: '知识',
  conversation: '对话', task_complete: '任务完成', focus_conclusion: '焦点结论',
  self_constraint: '自我约束', event: '事件', preference: '偏好',
  behavioral_constraint: '行为约束', opinion_expressed: '观点',
  impressive_statement: '印象', task_knowledge: '任务知识',
  default: '其他',
}

// 记忆类型 → 图标（列表行首）
const TYPE_ICONS = {
  fact: '📌', person: '👤', object: '🧩', knowledge: '📚',
  conversation: '💬', task_complete: '✅', focus_conclusion: '🎯',
  self_constraint: '🛡️', event: '⚡', preference: '❤️',
  behavioral_constraint: '🚧', opinion_expressed: '💡',
  impressive_statement: '✨', task_knowledge: '🛠️',
  default: '·',
}

function parseEntities(str) {
  try { const a = JSON.parse(str); return Array.isArray(a) ? a : [] } catch { return [] }
}

// 实体 id 归一化（ID:000001 ↔ person:xxx 之类）
function normalizeEntity(id) {
  return String(id || '').trim().toLowerCase()
}

// 常见实体 id 的友好显示名（优先 entities 表 label；缺省用这里的别名）
const ENTITY_ALIASES = {
  'id:000001': '用户',
  'agent:jarvis': '小白龙',
  'jarvis': '小白龙',
  'system': '系统',
  'agent': '小白龙',
}

// 把原始实体 id 变成可读名（entities 表 label > 内置别名 > 原始 id）
function prettyName(raw, labelMap) {
  const key = normalizeEntity(raw)
  return labelMap[key] || ENTITY_ALIASES[key] || raw
}

// links 字段实际是对象数组：[{ target_id, relation }]，取 target_id 生成 Obsidian 双链
function parseLinks(str) {
  try {
    const a = JSON.parse(str)
    if (!Array.isArray(a)) return []
    return a
      .map(x => (typeof x === 'string' ? x : (x && (x.target_id || x.id || x.mem_id))))
      .filter(Boolean)
  } catch { return [] }
}

// 清洗 Markdown 文件名不合法字符
function safeFileName(name) {
  return String(name).replace(/[\\/:*?"<>|#\[\]]/g, '-').trim().slice(0, 60) || '未命名'
}

function formatDate(ts) {
  if (!ts) return '未知时间'
  return String(ts).slice(0, 10) // yyyy-MM-dd
}

// 单条记忆 → vault 里的条目文本
function formatItem(m) {
  const label = TYPE_LABELS[m.event_type] || TYPE_LABELS.default
  const icon = TYPE_ICONS[m.event_type] || TYPE_ICONS.default
  const title = m.title || (m.content || '').slice(0, 30)
  const content = String(m.content || m.detail || '').trim()
  const links = parseLinks(m.links)
  const linkStr = links.length
    ? '\n  - 关联: ' + links.map(l => '[[' + l + ']]').join(', ')
    : ''
  const sal = m.salience ? '（重要度 ' + m.salience + '）' : ''
  return '- ' + icon + ' **[' + formatDate(m.timestamp) + '] ' + title + '**' + sal + '\n  ' + content.replace(/\n/g, '\n  ') + linkStr
}

// 构建记忆树：实体 → 记忆；无实体的按类型归「未分类」
export function buildMemoryTree() {
  const db = getDB()
  const rows = db.prepare('SELECT * FROM memories WHERE visibility = 1 ORDER BY salience DESC, created_at DESC').all()
  let labelMap = {}
  try { for (const e of getKnownEntities()) labelMap[normalizeEntity(e.id)] = e.label || e.id } catch {}
  const entities = {}
  const uncategorized = {}
  for (const m of rows) {
    const entityIds = parseEntities(m.entities)
    const item = formatItem(m)
    if (entityIds.length) {
      for (const rawId of entityIds) {
        const key = normalizeEntity(rawId)
        if (!entities[key]) entities[key] = { id: rawId, name: prettyName(rawId, labelMap), salience: 0, count: 0, memories: [] }
        const node = entities[key]
        node.memories.push(item)
        node.count++
        if ((m.salience || 0) > node.salience) node.salience = m.salience || 0
      }
    } else {
      const type = m.event_type || 'default'
      if (!uncategorized[type]) uncategorized[type] = []
      uncategorized[type].push(item)
    }
  }
  const entityList = Object.values(entities).sort((a, b) => (b.salience - a.salience) || (b.count - a.count))
  return { total: rows.length, updatedAt: new Date().toISOString(), entities: entityList, uncategorized }
}

// 清理 vault 目录里旧的 .md（保留非 md 文件）
function cleanOldMd() {
  if (!fs.existsSync(VAULT_DIR)) return
  for (const name of fs.readdirSync(VAULT_DIR)) {
    if (name.endsWith('.md')) {
      try { fs.unlinkSync(path.join(VAULT_DIR, name)) } catch {}
    }
  }
}

function writeIndex(tree) {
  const lines = [
    '---',
    'type: vault-index',
    'updated: ' + tree.updatedAt.slice(0, 10),
    'total: ' + tree.total,
    '---',
    '',
    '# 🧠 Bailongma 记忆总览',
    '',
    '> 由记忆自动导出 · 共 ' + tree.total + ' 条记忆 · ' + tree.entities.length + ' 个实体',
    '',
    '## 实体索引',
    '',
  ]
  for (const e of tree.entities) {
    const stars = '⭐'.repeat(Math.min(5, Math.max(1, e.salience || 1)))
    lines.push('- ' + stars + ' [[' + e.name + ']] — ' + e.count + ' 条')
  }
  if (Object.keys(tree.uncategorized).length) {
    lines.push('', '## 未分类', '')
    for (const type of Object.keys(tree.uncategorized)) {
      lines.push('- [[未分类]] · ' + (TYPE_LABELS[type] || type) + ' — ' + tree.uncategorized[type].length + ' 条')
    }
  }
  fs.writeFileSync(path.join(VAULT_DIR, '00-记忆总览.md'), lines.join('\n'), 'utf8')
}

function writeEntityFile(e) {
  const lines = [
    '---',
    'type: entity',
    'name: ' + e.name,
    'salience: ' + (e.salience || 1),
    'count: ' + e.count,
    '---',
    '',
    '# ' + e.name,
    '',
    '> 记忆节点 · 重要度 ' + (e.salience || 1) + ' · ' + e.count + ' 条记忆',
    '',
    '## 记忆',
    '',
    ...e.memories,
    '',
  ]
  const file = path.join(VAULT_DIR, safeFileName(e.name) + '.md')
  fs.writeFileSync(file, lines.join('\n'), 'utf8')
  return path.basename(file)
}

function writeUncategorized(tree) {
  const entries = Object.entries(tree.uncategorized)
  if (!entries.length) return
  const lines = [
    '---', 'type: uncategorized', 'count: ' + tree.total, '---', '',
    '# 未分类记忆', '', '',
  ]
  for (const [type, items] of entries) {
    lines.push('## ' + (TYPE_LABELS[type] || type), '', ...items, '')
  }
  fs.writeFileSync(path.join(VAULT_DIR, '99-未分类.md'), lines.join('\n'), 'utf8')
}

// 导出 Obsidian vault（清旧 md → 写索引/实体/未分类）
export function exportVault() {
  try { fs.mkdirSync(VAULT_DIR, { recursive: true }) } catch {}
  cleanOldMd()
  const tree = buildMemoryTree()
  writeIndex(tree)
  const files = []
  for (const e of tree.entities) files.push(writeEntityFile(e))
  writeUncategorized(tree)
  return { ok: true, path: VAULT_DIR, files: files.length, total: tree.total, updatedAt: tree.updatedAt }
}

// 节流同步：距上次导出超过 minIntervalMs 才重新导出（consolidation-loop 每轮调用）
let lastExportAt = 0
export function maybeSyncVault({ minIntervalMs = 15 * 60 * 1000 } = {}) {
  const now = Date.now()
  if (now - lastExportAt < minIntervalMs) return { ok: true, skipped: true }
  lastExportAt = now
  return exportVault()
}

// vault 当前状态（供 UI 展示）
export function getVaultStatus() {
  let files = 0, updatedAt = null
  if (fs.existsSync(VAULT_DIR)) {
    files = fs.readdirSync(VAULT_DIR).filter(n => n.endsWith('.md')).length
    const stat = fs.statSync(VAULT_DIR)
    updatedAt = stat.mtime.toISOString()
  }
  return { ok: true, path: VAULT_DIR, exists: fs.existsSync(VAULT_DIR), files, updatedAt }
}

// 用系统默认方式打开 vault 文件夹
export function openVault() {
  if (!fs.existsSync(VAULT_DIR)) exportVault()
  const dir = VAULT_DIR
  const cmd = process.platform === 'win32'
    ? 'explorer "' + dir + '"'
    : process.platform === 'darwin'
      ? 'open "' + dir + '"'
      : 'xdg-open "' + dir + '"'
  return new Promise((resolve) => {
    exec(cmd, (err) => resolve({ ok: !err, path: dir, error: err ? err.message : null }))
  })
}

