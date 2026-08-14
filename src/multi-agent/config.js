// 多 Agent 会议室 —— 每位 Agent 的可配置项（形象/语音/引擎/模型）
// 覆盖项持久化到 data/agent-config.json；读取时合并默认定义。
import fs from 'fs'
import path from 'path'
import { getAgentById, AGENTS } from './agents.js'
import { paths } from '../paths.js'

const CONFIG_FILE = path.join(paths.dataDir, 'agent-config.json')
let overrides = {}

function load() {
  try {
    if (fs.existsSync(CONFIG_FILE)) overrides = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) || {}
  } catch { overrides = {} }
}
function persist() {
  try { fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true }); fs.writeFileSync(CONFIG_FILE, JSON.stringify(overrides, null, 2), 'utf-8') } catch {}
}

// 合并默认 + 覆盖，返回某 Agent 的完整配置
export function getAgentConfig(id) {
  const def = getAgentById(id)
  if (!def) return null
  const ov = overrides[id] || {}
  return {
    ...def,
    ...ov,
    voice: { ...(def.voice || {}), ...(ov.voice || {}) },
    capabilities: ov.capabilities || def.capabilities,
  }
}

export function getAllAgentConfigs() {
  return AGENTS.map(a => getAgentConfig(a.id))
}

// 更新某 Agent 配置（只更新提供的字段，保留其余；api_key 特殊处理可留空表示不清空）
export function updateAgentConfig(id, patch = {}) {
  const def = getAgentById(id)
  if (!def) return { ok: false, error: `未知 Agent: ${id}` }
  const current = overrides[id] || {}
  const next = { ...current }

  for (const key of ['name', 'role', 'avatar', 'avatar_image', 'color', 'engine', 'model', 'base_url', 'temperature', 'cli_command', 'persona', 'style', 'private_memory']) {
    if (patch[key] !== undefined) next[key] = patch[key]
  }
  if (patch.api_key !== undefined && String(patch.api_key).trim()) next.api_key = patch.api_key
  if (patch.capabilities !== undefined && Array.isArray(patch.capabilities)) next.capabilities = patch.capabilities
  if (patch.voice !== undefined && patch.voice && typeof patch.voice === 'object') {
    next.voice = { ...(current.voice || {}), ...(def.voice || {}), ...patch.voice }
  }
  overrides[id] = next
  persist()
  return { ok: true, agent: getAgentConfig(id) }
}

load()
