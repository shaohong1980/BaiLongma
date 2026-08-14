// 角色/专家模式（P1-1）：adopt_role 工具 + 角色包
// 角色定义在仓库 roles/*.json，激活的角色持久化到 config.current_role，
// 下一轮系统提示注入其 persona + guidelines。
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { getConfig, setConfig } from '../../db.js'
import { emitEvent } from '../../events.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROLES_DIR = path.resolve(__dirname, '..', '..', '..', 'roles')

const ROLE_CACHE = new Map()
let rolesLoadedAt = 0

function loadRoleFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const data = JSON.parse(raw)
    if (!data || !data.name || !data.label) return null
    return {
      name: String(data.name).trim(),
      label: String(data.label).trim(),
      description: String(data.description || '').trim(),
      persona: String(data.persona || '').trim(),
      guidelines: Array.isArray(data.guidelines) ? data.guidelines.map(String) : [],
    }
  } catch { return null }
}

export function listRoles() {
  // 缓存 30 秒，避免每次读盘
  const now = Date.now()
  if (ROLE_CACHE.size && now - rolesLoadedAt < 30000) {
    return [...ROLE_CACHE.values()]
  }
  ROLE_CACHE.clear()
  try {
    for (const entry of fs.readdirSync(ROLES_DIR, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const role = loadRoleFile(path.join(ROLES_DIR, entry.name))
      if (role) ROLE_CACHE.set(role.name, role)
    }
  } catch {}
  rolesLoadedAt = now
  return [...ROLE_CACHE.values()]
}

export function getRole(name) {
  const n = String(name || '').trim().toLowerCase()
  return listRoles().find(r => r.name.toLowerCase() === n) || null
}

export function getActiveRole() {
  const name = getConfig('current_role') || ''
  return name ? getRole(name) : null
}

export function buildRoleContextBlock() {
  const role = getActiveRole()
  if (!role) return ''
  const lines = [
    `## 当前角色：${role.label}`,
    role.persona ? role.persona : '',
    ...(role.guidelines || []).map(g => `- ${g}`),
  ].filter(Boolean)
  return lines.join('\n')
}

export function execAdoptRole(args = {}) {
  const action = String(args.action || 'set').trim().toLowerCase()
  const roleName = String(args.role || args.name || '').trim()

  if (action === 'list') {
    const roles = listRoles()
    if (!roles.length) return '当前没有可用角色。'
    return `可用角色（${roles.length} 个）：\n` + roles.map(r => `- ${r.name}（${r.label}）：${r.description}`).join('\n')
  }

  if (action === 'reset' || action === 'clear') {
    setConfig('current_role', '')
    emitEvent('role_changed', { role: null })
    return '已退出专家模式，恢复默认助手。'
  }

  // set
  const role = getRole(roleName)
  if (!role) {
    const names = listRoles().map(r => r.name).join('、')
    return `未找到角色「${roleName}」。可用角色：${names || '（暂无）'}。`
  }
  setConfig('current_role', role.name)
  emitEvent('role_changed', { role: role.name, label: role.label })
  return `已切换到专家模式：${role.label}。\n${role.persona}\n后续回答将按该角色视角进行。`
}
