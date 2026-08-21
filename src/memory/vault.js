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
import {
  getDB, getKnownEntities, getMemoryByMemId, getMemoriesByEntity,
  insertMemory, upsertMemoryByMemId, hideMemoryByMemId,
} from '../db.js'
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
  'agent:jarvis': '爻台',
  'jarvis': '爻台',
  'system': '系统',
  'agent': '爻台',
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
  const icon = TYPE_ICONS[m.event_type] || TYPE_ICONS.default
  const title = m.title || (m.content || '').slice(0, 30)
  const content = String(m.content || m.detail || '').trim()
  const links = parseLinks(m.links)
  const linkStr = links.length
    ? '\n  - 关联: ' + links.map(l => '[[' + l + ']]').join(', ')
    : ''
  const sal = m.salience ? '（重要度 ' + m.salience + '）' : ''
  // ReMe 双写：每条记忆末尾带一个隐藏 HTML 注释标记 mem:MEM_ID（Obsidian 渲染不可见）。
  // importVaultEdits() 靠它把「用户在 Markdown 里的编辑」精确映射回 SQLite 的 mem_id。
  const marker = m.mem_id ? `\n  <!--mem:${m.mem_id}-->` : ''
  return '- ' + icon + ' **[' + formatDate(m.timestamp) + '] ' + title + '**' + sal + '\n  ' + content.replace(/\n/g, '\n  ') + linkStr + marker
}

// 构建记忆树：实体 → 记忆；无实体的按类型归「未分类」
export function buildMemoryTree() {
  const db = getDB()
  const rows = db.prepare('SELECT * FROM memories WHERE visibility = 1 ORDER BY salience DESC, created_at DESC').all()
  let labelMap = {}
  try { for (const e of getKnownEntities()) labelMap[normalizeEntity(e.id)] = e.label || e.id } catch (e) { console.warn('[src/memory/vault.js] op failed:', e?.message || e) }
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
      try { fs.unlinkSync(path.join(VAULT_DIR, name)) } catch (e) { console.warn('[src/memory/vault.js] op failed:', e?.message || e) }
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
    'entity_id: ' + (e.id || '').replace(/:/g, '\\:'),
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
  try { fs.mkdirSync(VAULT_DIR, { recursive: true }) } catch (e) { console.warn('[src/memory/vault.js] op failed:', e?.message || e) }
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

// ═══════════════════════════════════════════════════════════════
// ReMe 双写（第二方向）：Markdown 编辑 → SQLite 回写
// ═══════════════════════════════════════════════════════════════
// 导出方向（记忆 → Markdown）已有：exportVault / maybeSyncVault。
// 这里补上回写方向（Markdown → 记忆）：用户（或 AI）在 vault 的 .md 里
// 增删改记忆条目，importVaultEdits() 把差异同步回 memories 表：
//   - 条目内容/标题被改 → 更新该行 content/title/salience
//   - 条目被删（整个 bullet 移除）→ hideMemoryByMemId 软隐藏
//   - 新增条目（无 <!--mem:--> 标记的 bullet）→ insertMemory 写入新记忆
// 条目靠 formatItem 里嵌入的隐藏 `<!--mem:DB_ID-->` 注释映射回行。

// 简易 frontmatter 解析（只取需要字段）
function parseVaultFrontmatter(text) {
  const out = {}
  const m = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return out
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (kv) out[kv[1]] = kv[2].replace(/^"|"$/g, '').trim()
  }
  // entity_id 里转义的冒号还原（writeEntityFile 里 `id\:000001`）
  if (out.entity_id) out.entity_id = out.entity_id.replace(/\\:/g, ':')
  return out
}

// 解析实体 .md 文件 → 记忆条目数组
// 每条：{ memId, title, content, salience }
function parseVaultItems(text) {
  const items = []
  let current = null
  const flush = () => {
    if (current) {
      current.content = (current.contentLines || []).join('\n').trim()
      delete current.contentLines
      items.push(current)
    }
    current = null
  }
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '')
    if (/^-\s/.test(line)) {
      flush()
      const body = line.replace(/^-\s+/, '').trim()
      const titleMatch = body.match(/\*\*\[([^\]]+)\]\s*([^*]+?)\*\*/)
      const salMatch = body.match(/重要度\s+(\d+)/)
      current = {
        memId: null,
        title: titleMatch ? titleMatch[2].trim() : body,
        salience: salMatch ? Number(salMatch[1]) || 0 : 0,
        contentLines: [],
      }
    } else if (current && (/^\s{2,}/.test(line))) {
      const trimmed = line.trim()
      if (trimmed) {
        const marker = trimmed.match(/^<!--mem:([A-Za-z0-9_:-]+)-->/)
        if (marker) { current.memId = marker[1]; continue }
        if (trimmed.startsWith('- 关联:')) continue
        current.contentLines.push(trimmed)
      }
    } else if (current && line.trim() === '') {
      // 空行：保留（内容里的空行）
      current.contentLines.push('')
    } else {
      flush()
    }
  }
  flush()
  return items
}

// 新增条目的类型推断：按图标映射，缺省 fact
function inferTypeFromIcon(item) {
  const firstLine = item.title + (item.content || '')
  if (/🎯|结论|总结/.test(firstLine)) return 'focus_conclusion'
  if (/💡|观点/.test(firstLine)) return 'opinion_expressed'
  if (/⚡|事件|发生/.test(firstLine)) return 'event'
  if (/❤️|喜欢|偏好/.test(firstLine)) return 'preference'
  if (/📚|知识/.test(firstLine)) return 'knowledge'
  if (/✅|完成/.test(firstLine)) return 'task_complete'
  return 'fact'
}

/**
 * 回写 vault Markdown 编辑到记忆库。
 * @returns {{ ok, updated, inserted, hidden, unchanged, errors }}
 */
export function importVaultEdits() {
  if (!fs.existsSync(VAULT_DIR)) return { ok: false, error: 'vault 目录不存在，请先同步/导出一次（manage_vault sync）' }

  const files = fs.readdirSync(VAULT_DIR).filter(n =>
    n.endsWith('.md') && n !== '00-记忆总览.md' && n !== '99-未分类.md')
  if (!files.length) return { ok: false, error: '没有可回写的实体文件' }

  const applied = { ok: true, updated: [], inserted: [], hidden: [], unchanged: 0, errors: [] }
  const globalSeen = new Set() // 所有文件里出现的 mem_id（跨文件去重，防误隐藏）

  // ── 第一遍：更新 / 插入 ──
  for (const file of files) {
    let text
    try { text = fs.readFileSync(path.join(VAULT_DIR, file), 'utf8') } catch (err) {
      applied.errors.push(`${file}: ${err.message}`)
      continue
    }
    const fm = parseVaultFrontmatter(text)
    const items = parseVaultItems(text)
    for (const item of items) {
      if (item.memId) {
        globalSeen.add(item.memId)
        const row = getMemoryByMemId(item.memId)
        if (!row) { applied.errors.push(`${file}: mem_id ${item.memId} 已不存在，忽略`); continue }
        const newContent = item.content || row.content || ''
        const newTitle = item.title && item.title !== row.title ? item.title : undefined
        const newSalience = item.salience && item.salience !== row.salience ? item.salience : undefined
        if (newContent !== row.content || newTitle || newSalience) {
          try {
            upsertMemoryByMemId({
              mem_id: item.memId,
              content: newContent,
              ...(newTitle ? { title: newTitle } : {}),
              ...(newSalience ? { salience: newSalience } : {}),
            })
            applied.updated.push({ file, mem_id: item.memId, title: newTitle || row.title })
          } catch (err) { applied.errors.push(`${file}: update ${err.message}`) }
        } else {
          applied.unchanged += 1
        }
      } else {
        // 用户新增条目 → 插入新记忆
        const memId = 'vault_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
        const content = item.content || item.title
        try {
          insertMemory({
            mem_id: memId,
            event_type: inferTypeFromIcon(item),
            title: item.title,
            content,
            detail: content,
            entities: [fm.entity_id || fm.name].filter(Boolean),
            salience: item.salience || 3,
            visibility: 1,
          })
          globalSeen.add(memId) // 防第二遍误隐藏
          applied.inserted.push({ file, title: item.title, mem_id: memId })
        } catch (err) { applied.errors.push(`${file}: insert ${err.message}`) }
      }
    }
  }

  // ── 第二遍：软隐藏（只隐藏所有文件里都不存在的记忆，避免跨实体误删）──
  for (const file of files) {
    let text
    try { text = fs.readFileSync(path.join(VAULT_DIR, file), 'utf8') } catch { continue }
    const fm = parseVaultFrontmatter(text)
    if (!fm.entity_id) continue
    let rows
    try { rows = getMemoriesByEntity(fm.entity_id, 500) } catch { continue }
    for (const row of rows) {
      if (!globalSeen.has(row.mem_id)) {
        try {
          hideMemoryByMemId(row.mem_id, { hiddenAt: new Date().toISOString() })
          applied.hidden.push({ file, mem_id: row.mem_id, title: row.title })
        } catch (e) { console.warn('[src/memory/vault.js] op failed:', e?.message || e) }
      }
    }
  }

  // 回写后刷新导出，让 .md 与库保持一致（新插入条目补上标记）
  if (applied.inserted.length || applied.updated.length || applied.hidden.length) {
    try { exportVault() } catch (e) { console.warn('[src/memory/vault.js] op failed:', e?.message || e) }
  }

  return applied
}

// 记忆写入后请求近实时 vault 同步（ReMe 双写第一方向：写入即落 Markdown）。
// 用防抖把一回合内的多次 upsert 合并成一次导出，避免高频写盘。
let vaultSyncTimer = null
export function requestVaultSync({ delayMs = 8000 } = {}) {
  if (vaultSyncTimer) clearTimeout(vaultSyncTimer)
  vaultSyncTimer = setTimeout(() => {
    vaultSyncTimer = null
    try { exportVault() } catch (err) { console.warn('[vault] sync failed:', err?.message || err) }
  }, delayMs)
}

