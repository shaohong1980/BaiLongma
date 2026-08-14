---
name: MCP Builder
description: 构建 MCP（Model Context Protocol）服务器，让 Agent 通过工具调用外部服务/API。Python 用 FastMCP，Node 用 MCP SDK。
tags:
  - mcp
  - server
  - api
  - integration
  - 集成
aliases:
  - 构建MCP
  - 写MCP服务器
  - 集成API
  - 外部服务
triggers:
  - 写个MCP服务器
  - 集成这个API
  - 建个MCP服务
  - 连外部系统
---

# MCP 服务器构建

把外部 API/服务封装成 Agent 可调用的工具。

## 最小示例（Python + FastMCP）
```python
from fastmcp import FastMCP
mcp = FastMCP("my-service")

@mcp.tool()
def get_weather(city: str) -> str:
    """查询某城市天气"""
    # 调外部 API...
    return f"{city}: 25°C 晴"

mcp.run()  # stdio 传输
```

## 设计原则
- **工具命名动宾**：`get_weather`、`send_email`、`list_orders`
- **每个工具一个清晰 description**（何时用、参数含义、返回值）
- **参数尽量少且明确**，类型用 JSON Schema 严格声明
- **错误处理**：API 失败返回结构化错误，不裸抛异常
- **凭证**：从环境变量/安全存储读，不硬编码

## 接入 BaiLongma
1. 写服务器脚本 → 用 `npx`/`node`/`python` 启动
2. 在 `data/mcp-servers.json` 里登记（白名单）：
```json
{ "servers": { "my-service": { "command": "python", "args": ["/path/to/server.py"] } } }
```
3. Agent 就能用 `mcp_list_servers` / `mcp_call` 调用

## 规范
- **先文档后代码**：搞清楚外部 API 的鉴权、限流、字段，再动手
- **本地先测**：直接用脚本调一次确认 API 通，再接 MCP
- **安全**：不暴露密钥、不放大权限、工具只做该做的事
