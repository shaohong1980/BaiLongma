# API 契约文档

> 本地 HTTP / SSE / WebSocket / A2A / MCP 接口总览。默认端口 `3721`（被占用自动换，见 `startup` 日志）。
> 路由实现在 `src/api/routes/` 与 `src/api.js`。

## 一、鉴权与安全

- 默认只监听 `127.0.0.1`；局域网模式需 `BAILONGMA_API_TOKEN`（`start-lan.ps1` 自动生成并持久化到 `.env`）。
- **鉴权只认 `Authorization: Bearer <token>`**；`?token=` 查询参数已废弃（会进日志/历史/代理，不再支持）。
- 敏感路径（命令面/数据面）在非 loopback 下必须带 token：
  `/message` `/agents` `/room` `/task` `/media` `/settings` `/admin` `/memories` `/knowledge`
  `/approvals` `/workflows` `/observability` `/vault` `/preview` `/embedding` `/panels` `/workbench` `/tts` `/events`。
- 公开只读：`/` `/site` `/brain-ui` `/activation` `/systemPrompt.html` `/turn-trace` 等静态页。
- 请求体上限 16MB（超限返回 413）；CORS 有 origin 白名单。
- 局域网入口 `http://<IP>:3721/?token=<token>` 仍可打开页面，前端读取后立即用 `history.replaceState` 从地址栏剥离 token，后续请求全走 Bearer 头。

## 二、核心 HTTP 端点（`src/api/routes/`）

### 消息
- `POST /message` — 发送消息给 Agent（body: `{content, channel?}`）。
- `GET /messages?...` — 消息历史（`src/api/routes/message.js`）。

### 多 Agent 办公室
- `GET /agents` — 列出全部 Agent（含形象/引擎/配置，key 已脱敏）。
- `GET /agents/health` — 外部 A2A Agent 在线状态（会议桌状态灯）。
- `POST /agents/:id/config` — 更新 Agent 配置。
- `POST /agents/:id/task` — 给指定 Agent 布置任务。
- `GET /room` — 会议室历史 + 轮次。
- `POST /room/message` — 老板发言（`{content, targetAgentIds?}`，@点名路由）。
- `POST /room/office` — 办公室工作流（`{content, graph?, approval?, thread_id?}`；`graph:true` 走状态图引擎）。
- `POST /room/office/resume` — 图模式审批/断点续跑（`{thread_id, approved?, note?}`）。
- `POST /room/reset` — 清空会议室。
- `GET /task` — 三省六部任务看板。
- `POST /task` — 下旨跑流水线（`{content, graph?, approval?}`）。
- `POST /task/resume` — 图模式流水线审批/续跑。
- `POST /task/:id/control` — 任务干预（pause/cancel/resume）。
- `POST /task/:id/review` — 手动审议/封驳。

### 设置 / 记忆 / 知识
- `GET /settings` — 运行配置（Provider key 已脱敏为 `••••后4位`）。
- `GET /settings/voice`、`POST /settings/voice` — 语音配置。
- `GET /memories?...` / `POST /memories` — 记忆读写。
- `GET /knowledge` / `POST /knowledge` — 知识库（RAG）。

### 工作流
- `GET /workflows/templates`、`POST /workflows/save`、`POST /workflows/run` — 主工作流引擎。
- `POST /workflows/:id`... 详见 `src/api/routes/workspace.js`。

## 三、SSE 实时事件（`GET /events`）

`text/event-stream`，事件类型：`message`、`message_received`、`tick`、`focus_frame`、
`office_progress`、`edict_progress`、`agent_tts`、`system_prompt`、`error` 等。
前端用 `subscribeEvents('/events')`（`src/ui/brain-ui/api-client.js`）——**基于 fetch + ReadableStream 解析**，
因为 EventSource 不能带自定义 header，LAN 鉴权靠 `Authorization: Bearer`。服务器 15s 发送 `: ping` 心跳。

## 四、WebSocket

- `/scene` — 场景渲染协议（`src/ui/scene-shell/`）。
- `/voice/cloud` — 语音 ASR/TTS 云通道。
- LAN 下 WS 升级校验 token：`Authorization: Bearer` 或 **subprotocol** `bailongma.auth.<base64url-token>`。
- 浏览器 WebSocket 不能设 header，前端 `voice-core.js` 用 subprotocol 携带 token。

## 五、A2A（Agent2Agent，JSON-RPC 2.0）

- 入站：`src/a2a-server.js`，`POST /`（JSON-RPC），发现 `GET /.well-known/agent-card.json`。
  - `message/send`、`tasks/get`、`tasks/list`、`tasks/cancel`。
- 出站：`src/agents/a2a-client.js`（会议桌通过 `engine:'a2a'` 调用外部 Agent）。

## 六、MCP（Model Context Protocol）

- `mcp_list_servers` / `mcp_call` 工具调用已配置的 MCP 服务器（白名单 `data/mcp-servers.json`）。

## 七、外部协议入站中间件（`src/social/middleware.js`）

所有 HTTP 入站（social webhook，未来 A2A/MCP）统一：
- **payload 大小限制**：`content-length` 预检 + 流式读取上限（默认 1MB，超限 413）。
- **JSON 解析 + schema 校验**：`readJsonBody(req, res, { schema })`，失败自动回 400/413。
- **Bearer 校验**：`verifyBearer(req, expected)`。
- **幂等去重**：`isDuplicateEvent(key)` 按事件 id 缓存 10 分钟，防 webhook 重试重复入站。
- 已接入：飞书（`/social/feishu/webhook`，按 message_id 去重）、企业微信（`/social/wecom/webhook`，Bearer + 按 message_id 去重）、微信公众号（`/social/wechat/official`，签名 + 时间窗 + MsgId 去重）。

## 八、配置字段（config.json，gitignored）

| 字段 | 说明 |
|---|---|
| `provider` / `model` / `baseURL` | 主 LLM Provider（key 已迁 secret-store，config 存 `'none'` 占位） |
| `apiKey` / `minimax_api_key` | 已迁 secret-store（`data/api-capability-secrets.json` 加密） |
| `tts` | TTS 音色/Provider（`tts.doubaoKey` 已迁 secret-store） |
| `embedding` | 本地嵌入配置 |
| `social` | 社交连接器凭证 |
| `network.allowLanAccess` | 是否允许局域网访问 |
| `security` | 安全开关 |
| `schemaVersion` | config 迁移版本 |

## 九、数据目录（`data/`，gitignored）

| 文件 | 内容 |
|---|---|
| `jarvis.db` (+wal/shm) | SQLite：conversations/memories/action_logs/threads/...（77 表） |
| `office-memory.json` | 多 Agent 办公室长期记忆 |
| `room-conversation.json` | 会议室对话 |
| `edict-tasks.json` | 三省六部任务看板 |
| `turn-traces.jsonl` | 回合 trace（上限 12MB 自动轮转） |
| `api-capability-secrets.json` | 加密的 secret-store（Provider key / API capability / TTS key） |
| `graph-checkpoints/` | 状态图流程 checkpoint |
| `office-graph-checkpoints/` / `edict-graph-checkpoints/` | 图模式 checkpoint |
| `models/` | 本地嵌入模型（transformers.js） |
| `mcp-servers.json` | MCP 服务器白名单 |
| `sandbox/` | Agent 工作区（`src/sandbox-cleanup.js` 启动+每日清理测试残留） |

## 十、保留与维护

- `action_logs` 保留 90 天、`media_history` 180 天、`prefetch_cache` 过期即清（启动 + 每日定时，`src/db/retention.js`）。
- SQLite 维护（`src/db/connection.js`）：WAL checkpoint 每 30 分钟；`auto_vacuum=INCREMENTAL` + 空闲页 >25% 时增量 VACUUM（每 6h 检查）。
