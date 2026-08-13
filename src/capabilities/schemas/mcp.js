// MCP 工具 schema：mcp_list_servers / mcp_call
// MCP（Model Context Protocol）让 Bailongma 接进整个 MCP 生态（OpenHuman 5000+ MCP 服务器、OpenClaw tdoc-mcp-bridge、
// hermes mcp_serve 都靠它）。服务器在 data/mcp-servers.json 里显式配置（白名单），
// Agent 只能调用已配置服务器的工具，绝不能由模型指定命令执行。

export const mcpSchemas = {
  mcp_list_servers: {
    type: 'function',
    function: {
      name: 'mcp_list_servers',
      description: 'List configured MCP servers and the tools each exposes. Call before mcp_call when the user mentions an integration (e.g. Notion, Gmail, GitHub, filesystem) or asks what external services are connected. Servers are configured in data/mcp-servers.json.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  mcp_call: {
    type: 'function',
    function: {
      name: 'mcp_call',
      description: 'Call a tool on a configured MCP server (see mcp_list_servers for server/tool names). Use when the user wants an action that maps to a connected external service — e.g. filesystem operations, a database query, GitHub/Gmail/Notion actions — and no built-in Bailongma tool covers it. Pass arguments matching the tool\'s input schema.',
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'Configured MCP server name (from mcp_list_servers).' },
          tool: { type: 'string', description: 'Tool name on that server (from mcp_list_servers).' },
          args: { type: 'object', description: 'Tool arguments as an object matching the input schema.', additionalProperties: true },
        },
        required: ['server', 'tool'],
      },
    },
  },
}

