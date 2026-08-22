# 安全模型与已接受风险

> 记录 BaiLongma/爻台 的安全设计与当前已知风险的处理状态。
> 相关代码位置：`src/api.js`、`src/capabilities/tools/web/util.js`（SSRF）、
> `src/capabilities/marketplace/index.js`（工具沙箱）、`src/workflow/expr-eval.js`（表达式求值）、
> `src/capabilities/secret-store.js`（密钥）、`src/social/middleware.js`（入站中间件）。

## 一、本地网络鉴权

- API 默认只监听 127.0.0.1；开启局域网（`start:lan` / `allowLanAccess`）时，命令面/数据面路径
  （`/message` `/agents` `/room` `/task` `/media` `/settings` `/admin` `/memories` `/knowledge`
  `/approvals` `/workflows` `/observability` `/vault` `/preview` `/embedding` `/panels` `/workbench` `/tts` `/events`）
  一律要求 `BAILONGMA_API_TOKEN`。
- **鉴权只接受 `Authorization: Bearer`**；`?token=` 查询参数已废弃（2026-08 移除），避免 token 落日志/历史/代理。
- `start-lan.ps1` 未设置 token 时自动生成随机值并持久化到 `.env`；前端从 URL 一次性读取 token 后
  立即用 `history.replaceState` 剥离，SSE 改 fetch 流带 Bearer 头。
- WebSocket 升级（scene/voice）对 LAN 校验 token（Bearer 或 subprotocol `bailongma.auth.<base64url>`）；CORS 有 origin 白名单。

## 二、SSRF 防护（web 工具）

`fetch_url` / `browser_read` / `browser_act` 的 URL 在发起请求前经 `assertSsrSafeUrl` 校验：
- 协议白名单：仅 `http:` / `https:`（`file:`/`javascript:`/`ftp:` 等拒绝）。
- 主机名黑名单：`localhost`、`*.local`、`*.internal`、`*.lan`、云 metadata。
- IP 段拦截：loopback / 私网（10/8、172.16/12、192.168/16）/ link-local / CGNAT / 组播/保留段 / IPv6 对应段。
- 域名先 DNS 解析，任一解析结果落在拦截段即拒绝；IPv6 字面量先去方括号再判。
- `fetch_url` 直连路径**逐跳复检重定向**，防止「公网 URL → 302 到内网」绕过。

## 三、动态代码执行

- **workflow 表达式**（condition/switch/transform/子流程输入）：改为手写 AST 求值器
  （`src/workflow/expr-eval.js`），标识符只从 `{item, context}` 作用域取值，不支持函数调用/new，
  `process`/`require`/`globalThis` 从根本上不可达。
- **workflow code 节点**：改在 `node:vm` 沙箱执行（无 process/require/fs/net），仍由 `allowCode` 门控。
- **marketplace 工具**（新格式，带 permissions）：在独立 vm realm 执行，全局对象无原型
  （阻断 `this.constructor.constructor` 逃逸），args/helpers 在上下文内重建为 context-native，
  工具代码拿不到任何宿主对象引用。
- **legacy 工具**（无 permissions 元数据、用户手工安装的历史文件）：保留宿主全局访问，属兼容行为。

## 四、Electron 渲染层

- 所有窗口：`contextIsolation: true`、`nodeIntegration: false`、preload 隔离。
- `window.open` / 导航：只放行 `http(s)`；`javascript:`/`data:`/`file:`/自定义协议一律 `deny`。
- 主页面 CSP（2026-08 收严）：`script-src 'self'`（**移除 `unsafe-eval`**，three/pinyin-pro 本地加载无需 eval）；
  `connect-src` 移除 `https:` 通配，只留本地后端/WS + `https://www.youtube.com`（oembed）；展示页同理。
- DevTools 仅开发模式（`!app.isPackaged`）可开；`shell.openExternal` 仅接受 `http(s)`。

## 五、密钥存储

- **已迁移完成**：主 LLM key、Minimax key、`tts.doubaoKey` 全部迁到 `src/capabilities/secret-store.js`
  （Electron safeStorage 加密，非 Electron 环境 AES-256-GCM 兜底，主密钥 0o600）。
  `config.json` 明文已清除为 `'none'` 占位。
- **读取**：从 secret-store 优先读取，回退 config.json/env（旧安装兼容）。
- **写入**：写入时同步加密到 secret-store，config 只留占位。
- **迁移**：启动自动把明文复制到 secret-store → 验证可回读 → 才清明文（不丢 key）。
- 接口返回已脱敏（`••••` + 后 4 位）。
- ⚠️ 若历史上有真实 key 曾明文落盘（如 doubaoKey），建议轮换。

## 六、外部协议入站

`src/social/middleware.js` 统一：payload 大小上限、JSON 解析 + schema 校验、Bearer 校验、幂等去重（10 分钟）。
已接入飞书/企业微信/微信公众号 webhook（2026-08）。

**协议级审计结果（2026-08）**：
- **A2A**（`src/a2a-server.js`）：JSON-RPC 2.0 有 method 分发与基础 params 校验、回信超时（120s）；
  2026-08 补上 **请求体 1MB 上限**（防内存耗尽）与 **任务存储 500 条上限**（防无限增长）。
- **MCP**（`src/mcp/client.js`）：stdio 请求/初始化均有超时，无缺口。
- **Telegram**（`src/social/telegram.js`）：出站 Bot，无入站 webhook 面。
- 未覆盖：重试/死信队列（外部协议多为一次性入站，重试由上游 webhook 平台负责）。

## 七、依赖安全（npm audit）

执行 `npm audit --omit=dev`（registry 已统一 npmjs，本地可跑）后，**已修复**：
axios / js-yaml / protobufjs / form-data / @larksuiteoapi / electron 可修部分等。

**当前剩余（dev 含 electron 共 6 high；生产 4 high，均无上游修复，已评估可接受）**：
| 包 | 来源 | 风险 | 缓解 |
|---|---|---|---|
| `sharp`(<0.35.0) | @huggingface/transformers 传递依赖 | libvips 若干 CVE | 仅本地文本嵌入路径、懒加载；文本嵌入不使用其图片函数 |
| `adm-zip`(<0.6.0) | onnxruntime-node 传递依赖 | 恶意 ZIP 触发大内存分配 | onnxruntime 只解压受信捆绑模型，非不可信输入；懒加载 |
| `electron`(<=40.10.2) | 直接依赖 | 若干渲染层 CVE | **待升级** 33 → 41/43（breaking，需重编原生模块，单独排期） |

**对策**：`npm audit` 已纳入 CI（非阻断，报告不阻断避免无上游修复时长期红）。

## 八、运维维护

- SQLite：WAL checkpoint 30min + 增量 VACUUM（`src/db/connection.js`）。
- 数据保留：action_logs 90 天 / media_history 180 天（`src/db/retention.js`）。
- sandbox：启动 + 每日清理中断测试残留目录（`src/sandbox-cleanup.js`）。
- 后台循环统一封装：`src/scheduler.js`（防重叠 + 错误隔离 + unref）。

## 九、已接受 / 待办

- [x] LAN 鉴权（Bearer-only）、SSRF 防护、CSP 收严、导航白名单、DevTools 控制
- [x] 密钥迁移到 secret-store（含 doubaoKey）
- [x] CI：lint / audit / Vitest 单元测试（含覆盖率阈值）
- [x] workflow 表达式去 `new Function`、marketplace 工具 vm 沙箱
- [x] 外部协议入站中间件（大小/校验/幂等）
- [ ] **定期密钥轮换**（doubaoKey 历史明文，建议轮换）
- [ ] **electron 33 → 41/43 升级**（breaking，需重编 better-sqlite3，单独排期）
- [ ] ML 栈（sharp/adm-zip）无上游修复，待 transformers 链升级
