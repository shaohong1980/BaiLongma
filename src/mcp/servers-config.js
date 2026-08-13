// servers-config.js —— MCP 服务器配置存储
//
// 配置文件：data/mcp-servers.json（与主 config.json 隔离，避免 activate() 等全量写覆盖）。
// 结构：
//   {
//     "servers": {
//       "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:\\notes"] },
//       "my-tool":    { "command": "node", "args": ["C:\\tools\\my-mcp-server.js"] }
//     }
//   }
//
// 安全边界：Agent 只能调用「已在此文件里显式配置」的服务器，绝不能由模型任意指定命令去执行。
// 配置文件相当于白名单；mcp_call 只能从列出的 server 里选工具。

import fs from 'fs'
import path from 'path'
import { paths } from '../paths.js'

const CONFIG_FILE = path.join(paths.dataDir, 'mcp-servers.json')

export function readMcpServersConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return { servers: {} }
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))
    return (parsed && typeof parsed === 'object' && parsed.servers && typeof parsed.servers === 'object')
      ? parsed
      : { servers: {} }
  } catch {
    return { servers: {} }
  }
}

function writeMcpServersConfig(data) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
    const tmp = `${CONFIG_FILE}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
    fs.renameSync(tmp, CONFIG_FILE)
  } catch { /* best-effort */ }
}

// 归一化一条服务器配置：校验 command 必填、args 为字符串数组。
function normalizeServerEntry(entry) {
  if (!entry || typeof entry !== 'object') return null
  const command = String(entry.command || '').trim()
  if (!command) return null
  return {
    command,
    args: Array.isArray(entry.args) ? entry.args.map(String) : [],
    env: (entry.env && typeof entry.env === 'object') ? { ...entry.env } : undefined,
    enabled: entry.enabled !== false,
  }
}

export function listMcpServers() {
  const { servers } = readMcpServersConfig()
  const out = {}
  for (const [name, entry] of Object.entries(servers)) {
    const normalized = normalizeServerEntry(entry)
    if (!normalized) continue
    out[name] = {
      command: normalized.command,
      args: normalized.args,
      env: normalized.env,
      enabled: normalized.enabled,
    }
  }
  return out
}

export function getMcpServer(name) {
  const all = listMcpServers()
  return all[name] || null
}

export function upsertMcpServer(name, entry) {
  const cleaned = normalizeServerEntry(entry)
  if (!cleaned) return { ok: false, error: '需要 command（可执行命令）与可选 args' }
  const config = readMcpServersConfig()
  config.servers[String(name || '').trim()] = cleaned
  writeMcpServersConfig(config)
  return { ok: true }
}

export function removeMcpServer(name) {
  const config = readMcpServersConfig()
  if (!config.servers[name]) return { ok: false, error: '服务器不存在' }
  delete config.servers[name]
  writeMcpServersConfig(config)
  return { ok: true }
}

