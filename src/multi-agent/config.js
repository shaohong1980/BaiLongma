// 多 Agent 会议室 —— 每位 Agent 的可配置项（形象/语音/引擎/模型）
// 覆盖项持久化到 data/agent-config.json；读取时合并默认定义。
import fs from 'fs'
import path from 'path'
import { getAgentById, AGENTS } from './agents.js'
import { paths } from '../paths.js'

const CONFIG_FILE = path.join(paths.dataDir, 'agent-config.json')
let overrides = {}

// P2-10：运行时动态注册的外部 agent（通过 A2A AgentCard 发现），不写入静态 AGENTS
let runtimeAgents = []
export function getRuntimeAgents() { return runtimeAgents }

function load() {
  try {
    if (fs.existsSync(CONFIG_FILE)) overrides = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) || {}
  } catch { overrides = {} }
}
function persist() {
  try { fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true }); fs.writeFileSync(CONFIG_FILE, JSON.stringify(overrides, null, 2), 'utf-8') } catch (e) { console.warn('[src/multi-agent/config.js] op failed:', e?.message || e) }
}

// 合并默认 + 覆盖，返回某 Agent 的完整配置（含运行时注册的外部 agent）
export function getAgentConfig(id) {
  const def = getAgentById(id) || runtimeAgents.find(a => a.id === id)
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
  return [...AGENTS.map(a => getAgentConfig(a.id)), ...runtimeAgents.map(a => getAgentConfig(a.id))]
}

// 注册一个运行时外部 agent（P2-10）
export function registerExternalAgent(entry = {}) {
  const id = String(entry.id || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '-') || null
  if (!id) return { ok: false, error: '缺少 id' }
  if (getAgentById(id)) return { ok: false, error: `Agent '${id}' 已存在（静态定义）` }
  if (runtimeAgents.some(a => a.id === id)) return { ok: false, error: `Agent '${id}' 已注册` }
  const base = String(entry.url || entry.a2a_url || '').trim().replace(/\/+$/, '')
  const cfg = {
    id,
    name: entry.name || id,
    role: entry.role || '独立外部 Agent',
    avatar: entry.avatar || '🤖',
    avatar_image: '',
    color: entry.color || '#8b5cf6',
    voice: { enabled: false, ttsProvider: '', voiceId: '', speed: 1.0 },
    engine: 'a2a',
    a2a_url: base,
    a2a_timeout: Number(entry.timeout) || 120,
    table: true,
    external: true,
    capabilities: Array.isArray(entry.capabilities) && entry.capabilities.length ? entry.capabilities : ['对话', '协作'],
    persona: String(entry.persona || `你是独立外部 Agent「${entry.name || id}」，通过 A2A 接入本办公室，坐镇会议桌。`),
    style: '独立判断，专业回应，以外部身份参与讨论与评审。',
    private_memory: `我是独立外部 Agent ${entry.name || id}。`,
  }
  runtimeAgents.push(cfg)
  return { ok: true, agent: cfg }
}

// 通过 A2A AgentCard 发现并注册外部 agent（P2-10）
export async function discoverAgent(url) {
  const base = String(url || '').trim().replace(/\/+$/, '')
  if (!base) return { ok: false, error: '缺少 url' }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    const res = await fetch(base + '/.well-known/agent-card.json', { signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const card = await res.json()
    const name = String(card.name || 'external-agent')
    const id = name.toLowerCase().replace(/[^a-z0-9_]/g, '-') || ('agent-' + Date.now().toString(36))
    return registerExternalAgent({
      id,
      url: base,
      name,
      role: '独立外部 Agent',
      avatar: '🤖',
      capabilities: (card.skills || []).map(s => s.name || s.id),
      persona: String(card.description || '').slice(0, 300),
    })
  } catch (e) {
    return { ok: false, error: `发现失败：${e?.message || e}` }
  } finally { clearTimeout(timer) }
}

// 更新某 Agent 配置（只更新提供的字段，保留其余；api_key 特殊处理可留空表示不清空）
export function updateAgentConfig(id, patch = {}) {
  const def = getAgentById(id)
  if (!def) return { ok: false, error: `未知 Agent: ${id}` }
  const current = overrides[id] || {}
  const next = { ...current }

  for (const key of ['name', 'role', 'avatar', 'avatar_image', 'color', 'engine', 'model', 'base_url', 'temperature', 'cli_command', 'cli_timeout', 'cli_cwd', 'a2a_url', 'a2a_timeout', 'a2a_token', 'persona', 'style', 'private_memory', 'desk', 'table', 'external', 'tools']) {
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
