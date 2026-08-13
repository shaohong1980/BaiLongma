// skill-usage.js —— Skill 使用遥测（参考 hermes-agent tools/skill_usage.py）
//
// 每个 skill 的使用次数 / 最近使用时间 / 活跃度状态，落在侧车 JSON（data/skill-usage.json），
// 与 SKILL.md 正文物理隔离——操作元数据不该污染用户/模型手写的技能内容。
// 生命周期状态：active（默认）→ stale（长期未用）→ archived（更久未用），
// 让技能库像 hermes 一样"自维护"：长期不用的技能降权，在 list 里沉底而不是无限膨胀。
//
// 设计约束：
//  - 所有写操作 best-effort，绝不 throw（遥测坏了不能拖垮工具调用）。
//  - 原子写（先写临时文件再 rename），防止并发/崩溃留下半个 JSON。
//  - key 用 skill.id（registry 里生成的 slug）。

import fs from 'fs'
import path from 'path'
import { paths } from '../paths.js'

const USAGE_FILE = path.join(paths.dataDir, 'skill-usage.json')

// stale：超过该天数未使用；archived：超过该天数（stale 之上）未使用
export const STALE_AFTER_DAYS = 30
export const ARCHIVE_AFTER_DAYS = 90

function readUsage() {
  try {
    if (!fs.existsSync(USAGE_FILE)) return {}
    const parsed = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf-8'))
    return (parsed && typeof parsed === 'object') ? parsed : {}
  } catch {
    return {}
  }
}

function writeUsage(data) {
  try {
    fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true })
    const tmp = `${USAGE_FILE}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
    fs.renameSync(tmp, USAGE_FILE)
  } catch { /* best-effort */ }
}

function stateFor(entry) {
  if (!entry) return 'active'
  if (entry.pinned) return 'active'
  const lastMs = Date.parse(entry.last_used_at || '')
  if (!Number.isFinite(lastMs)) return 'active'
  const days = (Date.now() - lastMs) / 86400000
  if (days >= ARCHIVE_AFTER_DAYS) return 'archived'
  if (days >= STALE_AFTER_DAYS) return 'stale'
  return 'active'
}

// 记录一次使用（由 skill 注入 / view_skill 调用触发）
export function bumpSkillUsage(skillId) {
  if (!skillId) return null
  const usage = readUsage()
  const now = new Date().toISOString()
  const prev = usage[skillId] || {}
  const next = {
    ...prev,
    use_count: (prev.use_count || 0) + 1,
    first_used_at: prev.first_used_at || now,
    last_used_at: now,
  }
  usage[skillId] = next
  writeUsage(usage)
  return next
}

export function getSkillUsage(skillId) {
  const usage = readUsage()
  return usage[skillId] ? { ...usage[skillId], state: stateFor(usage[skillId]) } : null
}

// 合并所有 skill 的使用统计（未用过的给零值），并按 state 排序（active 在前、stale 次之、archived 沉底）
export function listSkillUsage(skillIds = []) {
  const usage = readUsage()
  const out = []
  const seen = new Set()
  for (const id of skillIds) {
    const entry = usage[id] || {}
    seen.add(id)
    out.push({ id, use_count: entry.use_count || 0, first_used_at: entry.first_used_at || null, last_used_at: entry.last_used_at || null, pinned: !!entry.pinned, state: stateFor(entry) })
  }
  for (const [id, entry] of Object.entries(usage)) {
    if (seen.has(id)) continue
    out.push({ id, use_count: entry.use_count || 0, first_used_at: entry.first_used_at || null, last_used_at: entry.last_used_at || null, pinned: !!entry.pinned, state: stateFor(entry) })
  }
  const rank = { active: 0, stale: 1, archived: 2 }
  return out.sort((a, b) => rank[a.state] - rank[b.state] || b.use_count - a.use_count || String(a.id).localeCompare(String(b.id)))
}

export function setSkillPinned(skillId, pinned) {
  if (!skillId) return null
  const usage = readUsage()
  const prev = usage[skillId] || {}
  usage[skillId] = { ...prev, pinned: !!pinned }
  writeUsage(usage)
  return usage[skillId]
}

// 存档已归档/删除的技能（清理侧车条目）
export function removeSkillUsage(skillId) {
  const usage = readUsage()
  if (!usage[skillId]) return false
  delete usage[skillId]
  writeUsage(usage)
  return true
}

