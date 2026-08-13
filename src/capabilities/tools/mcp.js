// MCP 工具实现：mcp_list_servers / mcp_call
import { listServerTools, callMcpTool, listAllServersWithTools } from '../../mcp/client.js'

export async function execMcpListServers() {
  const r = await listAllServersWithTools()
  if (!r.servers || !r.servers.length) {
    return '还没有配置任何 MCP 服务器。在 data/mcp-servers.json 里按 {"servers": {"名字": {"command": "...", "args": [...]}}} 加一个，就能让我调用它的工具。'
  }
  const lines = r.servers.map(s => {
    const header = `- ${s.name} (${s.command})${s.ok ? '' : ` ❌ ${s.error}`}`
    if (!s.ok) return header
    if (!s.tools.length) return `${header}: 该服务器没有暴露任何工具`
    return `${header}:\n` + s.tools.map(t => `    · ${t.name}: ${String(t.description || '').slice(0, 120)}`).join('\n')
  })
  return `已配置 ${r.servers.length} 个 MCP 服务器：\n` + lines.join('\n')
}

export async function execMcpCall(args = {}) {
  const server = String(args.server || '').trim()
  const tool = String(args.tool || '').trim()
  if (!server || !tool) return '错误：mcp_call 需要 server 和 tool 参数（用 mcp_list_servers 查看可用项）'
  const r = await callMcpTool(server, tool, args.args || {})
  if (!r.ok) return `MCP 调用失败（${server} / ${tool}）：${r.error}`
  return r.result || `（${server} 的 ${tool} 返回空结果）`
}

