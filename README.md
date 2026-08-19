![爻台 Yaotai](https://github.com/xiaoyuanda666-ship-it/Yaotai/blob/main/images/AGI128k.jpg)

# 爻台 Yaotai Agent Studio

> **爻台（Yaotai Agent）是基于 Bailongma（白龙马）深度二次开发的本地持续运行桌面 AI Agent。**

爻台在 Bailongma 开源底座之上做了**深度二次开发**：不仅完整继承了 Bailongma 的本地自主、动态记忆、工具执行与多协议能力，还进一步引入：

- **多智能体协同**：军机处 / 三省六部流水线（分拣→规划→审议封驳→派发→执行→回奏），六部按领域自动派活；
- **Agent 技能学习闭环**：`learn_skill` 沉淀可复用技能，`improve_skill` 在使用中自我改进；
- **行为级评估与对抗测试**：31 个端到端评估任务 + prompt injection / 危险指令 / 沙箱逃逸对抗集；
- **DeepSeek 深度优化**：prompt cache 前缀排序、flash/pro 模型分层、上下文 token 预算与自动降级；
- **标准协议**：MCP（Agent↔工具）+ A2A（Agent↔Agent）+ OTel trace 字段，面向 Agent 生态互操作。

它不是一次问答结束就退出的聊天程序，而是由主循环驱动：有用户消息时优先处理，空闲时按节奏继续整理记忆、检查任务、刷新上下文，并把状态实时推送到 Brain UI。

项目由 Electron 桌面壳、本地 HTTP 服务、LLM 调用层、记忆系统、工具执行器、语音系统、社交连接器和 Brain UI 组成。它的目标是让一个本地 Agent 既能聊天，也能记住、行动、观察自己的运行状态，并通过工具完成文件、网页、媒体、提醒、任务和系统级操作。

## 主要能力

- 持续运行的主循环：处理用户消息、后台消息、提醒、任务续跑和空闲心跳。
- 记忆系统：基于本地 SQLite 持久化对话、记忆、行动日志、提醒、预取缓存、媒体历史和线程状态，并支持全文检索、语义补充、去重与合并。
- 动态上下文注入：每轮对话前自动选择相关记忆、最近对话、用户画像、工具结果、UI 信号、预取内容和运行状态。
- 多模型接入：通过 OpenAI 兼容接口连接 DeepSeek、MiniMax、OpenAI、Qwen、Moonshot、Zhipu、MiMo 以及自定义服务。
- 工具系统：按需注入工具，支持通信、文件系统、Shell、网页读取、搜索、媒体生成、记忆管理、UI 卡片、任务、提醒、本地 Agent 委托和系统操作。
- 技能学习闭环（Agent Skills）：支持 `learn_skill` 把刚做过的工作流/文档沉淀成可复用的 `SKILL.md` 技能包，`view_skill`/`list_skills` 按需浏览，`improve_skill` 把使用中的踩坑写回技能（技能在使用中自我改进），并带用量遥测与 active/stale/archived 生命周期。
- MCP 接入：通过 `mcp_call` 调用已配置的 MCP（Model Context Protocol）服务器（Notion/Gmail/GitHub/数据库/文件系统等），服务器在 `data/mcp-servers.json` 里显式配置（白名单），`mcp_call`/`delete_skill` 在自主 Tick 下需显式用户上下文。
- 工具结果压缩（TokenJuice）：超过阈值的「只读/信息型」工具输出（read_file/exec/web_search…）进入模型前压成一行摘要，全文写 `data/tool-outputs/<id>.txt` 供按需取回，省 token 且不丢细节；可在设置/`config.json` 的 `toolCompression` 块调整。
- Brain UI：提供聊天、思考流、记忆图、焦点线程、热点面板、文档面板、人物卡片、语音控制、设置页和 ACUI 卡片渲染。
- 语音能力：支持云端语音识别和多种 TTS 服务，可在 UI 中配置语音输入、语音输出和声音参数。
- 社交连接器：支持 Discord 与微信桥接，外部消息进入同一个主循环，回复按渠道路由返回。
- 本地资源感知：启动时收集系统信息、桌面信息、已安装软件、本地 Agent、SSH 与 Git 资源、地理天气和热点内容。
- 桌面集成：Electron 窗口、托盘、自动更新状态、日志落盘、单实例运行和焦点横幅。
- **多Agent办公室（多智能体协同工作台）**：可视化办公大厅——CEO 决策者坐镇会议桌首席，独立外部 A2A Agent（Hermes / Claude Code）同桌，职能员工（文件管理/报表统计/电脑操作/应用调度/检索专员/系统体检员）在工位真实执行。能力包括：
  - **真实工具执行**：内部员工走 `callLLM` 工具循环（读写/执行/检索），外部 Agent 走 A2A `message/send`，告别"嘴炮"交付；
  - **CEO 结构化拆解**：输出 JSON `workers` 精确分派，正则关键词兜底；
  - **证据化交付验证**：验货员用真实工具核实产物存在，杜绝"文字声称已交付"；
  - **向量记忆 + 语义召回**：办公室决策/会议/事实沉淀进知识库与记忆图谱，相关历史按语义注入上下文；
  - **可编程流程编排**：JSON 定义多步流程（串行/并行/汇总/评审返工循环），预设 consult / implement / reviewfix；
  - **每 Agent 工作台账**：谁干了啥、耗时、结果；实时进度 SSE + 外部 Agent 状态灯；
  - **系统体检员**：对标 Marvis，一句话给电脑做全方位体检（磁盘/性能/电池/大文件），输出结构化报告；
  - **汇报座位按左右分侧**：左边工位角色到 CEO 左边汇报，右边到右边。

## 项目结构

```text
electron/              Electron 主进程、预加载脚本和桌面窗口控制
src/index.js           Agent 主循环、调度、任务状态和启动流程
src/api.js             本地 HTTP 服务、SSE、WebSocket、设置和管理接口
src/llm.js             LLM 流式调用、工具调用执行和重试保护
src/config.js          Provider、模型、语音、社交、搜索和安全配置
src/db.js              SQLite 数据表、索引和持久化读写
src/memory/            记忆识别、注入、线程、焦点、召回和整理
src/context/           运行时上下文、规则、关键词和片段选择
src/capabilities/      工具 schema、执行器、沙箱和工具市场
src/multi-agent/       多Agent办公室：agent 定义/引擎(A2A·CLI·工具循环)/房间/任务流水线/记忆/台账/流程编排
src/knowledge/         知识库：向量+全文混合检索（支撑办公室向量记忆）
src/social/            社交平台连接器和消息路由
src/voice/             云端 ASR、TTS 服务和语音相关逻辑
src/ui/brain-ui/       Brain UI 前端、ACUI 组件和可视化面板
scripts/               构建、探测、修复、冒烟测试和辅助脚本
sandbox/               Agent 工作区与生成内容存放区
data/                  本地运行数据，打包时不会带入安装包
```

## 环境要求

爻台强制要求 **Node.js 22.x**（作为构建 / 脚本运行环境：npm、electron-rebuild、lint 等；运行时统一走 Electron 33 内置 Node，见下）。版本不符时，启动守卫会直接报错退出，不会进入运行阶段。

> 升级说明：从 Node 20 → 22，是为了满足 `@electron/rebuild` 4.x 的 `node >=22.12` 声明——旧约束下 `npm install` 会因 engine 冲突直接失败。

项目通过以下机制强制版本：

- `package.json` 的 `engines` 字段声明 `>=22.0.0 <23.0.0`。
- `.nvmrc` 指定 `22.20.0`，使用 nvm-windows / fnm 时执行 `nvm use` 即可切换到目标版本。
- `.npmrc` 开启 `engine-strict=true`，版本不符时 `npm install` 会直接拒绝。
- `scripts/check-node.mjs` 作为 `predev` / `prestart` / `prestart:backend` / `prestart:backend:lan` 的启动守卫，版本不符时打印切换提示并以非零码退出。

### 统一运行时（Electron）

`better-sqlite3` 是原生模块，本项目统一在 **Electron 运行时**下运行：桌面端（`npm start`）与后端（`npm run dev` / `npm run start:backend`）都使用 Electron 33 内置的 Node，原生模块始终按 Electron ABI（130）编译，**无需在两种 ABI 之间来回切换**。系统 Node 22 的 ABI 与 Electron 内置 Node 不同，但只作为运行 electron-rebuild / lint / npm 脚本的宿主，不直接加载 `better-sqlite3`。

后端脚本通过 `ELECTRON_RUN_AS_NODE=1 electron ...` 运行，即把 Electron 当作普通 Node 使用：

```bash
npm run dev            # 后端开发（watch 模式，走 Electron-as-node）
npm start              # 桌面应用（走 Electron 运行时）
```

如需手动重编原生模块：

```bash
npm run electron:rebuild   # 重编 better-sqlite3 为 Electron ABI（默认/推荐状态）
```

> ⛔ **严禁执行 `npm rebuild better-sqlite3` 或 `npm run backend:rebuild`**：它们会把原生模块编回普通 Node ABI，导致桌面端与后端都无法启动（报 `NODE_MODULE_VERSION` 不匹配）。重编统一用 `npm run electron:rebuild`。
>
> 注意：不要用普通 `node xxx.js` 直接跑依赖 better-sqlite3 的脚本——普通 node 与 Electron 的 ABI 不同，会报错。请改用仓库提供的 `blm-run xxx.js`（Git Bash）或 `ELECTRON_RUN_AS_NODE=1 electron xxx.js`。

## 运行方式

先安装依赖：

```bash
npm install
```

启动桌面应用：

```bash
npm start
```

只启动本地后端：

```bash
npm run start:backend
```

开发时自动重启后端：

```bash
npm run dev
```

需要局域网访问时，可以使用仓库里已有的启动脚本：

```bash
npm run start:lan
npm run start:backend:lan
```

## 配置

首次启动后会进入激活页，填写任意已支持 Provider 的 API Key 即可。也可以通过 `.env` 提供环境变量：

```env
LLM_PROVIDER=minimax
MINIMAX_API_KEY=your_key
```

常用配置可以在 Brain UI 的设置页中完成：

- 模型 Provider、模型、温度和 API Key。
- 语音识别、TTS Provider、音色和凭证。
- 社交平台连接参数。
- 嵌入、网页搜索和安全开关。
- Agent 名称、UI 行为和媒体相关偏好。

配置会持久化到本地数据目录。敏感设置接口默认只允许本机访问；需要远程访问时应结合环境变量开启局域网访问或设置 API Token。

## Web 入口

本地服务默认监听：

```text
http://127.0.0.1:3721
```

常用页面：

| 页面 | 地址 | 用途 |
| --- | --- | --- |
| Brain UI | `/brain-ui` | 主界面、聊天、状态、设置和可视化 |
| 激活页 | `/activation` | 首次配置 API Key |
| 运行状态 | `/status` | 查看循环、任务和记忆概览 |
| 配额状态 | `/quota` | 查看当前请求与限流状态 |
| Turn Trace | `/turn-trace` | 查看回合级运行轨迹 |

如果 Electron 启动时默认端口被占用，主进程会自动寻找可用端口并加载对应地址。

## 常用 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/message` | 发送一条用户消息到主循环 |
| `GET` | `/events` | 订阅 SSE 事件流 |
| `GET` | `/status` | 获取运行状态 |
| `GET` | `/quota` | 获取配额与限流信息 |
| `GET` | `/memories` | 查询记忆 |
| `PATCH` | `/memories/:id` | 更新记忆 |
| `DELETE` | `/memories/:id` | 删除记忆 |
| `GET` | `/conversations` | 查询最近对话 |
| `GET` | `/settings` | 获取设置摘要 |
| `POST` | `/activate` | 写入 Provider 配置并激活 |
| `POST` | `/settings/model` | 切换模型 |
| `POST` | `/settings/temperature` | 调整温度 |
| `GET` | `/settings/voice` | 获取语音识别设置 |
| `POST` | `/settings/voice` | 保存语音识别设置 |
| `GET` | `/settings/tts` | 获取 TTS 设置 |
| `POST` | `/settings/tts` | 保存 TTS 设置 |
| `POST` | `/tts/stream` | 流式生成语音 |
| `GET` | `/social/wechat-clawbot/qr` | 获取微信桥接二维码状态 |
| `POST` | `/social/wechat-clawbot/logout` | 退出微信桥接 |
| `POST` | `/admin/stop` | 暂停主循环 |
| `POST` | `/admin/start` | 恢复主循环 |
| `POST` | `/admin/restart` | 重启应用进程 |
| `POST` | `/admin/reset-memories` | 清空记忆和对话 |
| `POST` | `/admin/reset-files` | 清空沙箱文件 |
| `GET` | `/agents` | 列出多Agent办公室成员 |
| `GET` | `/agents/health` | 外部 A2A Agent 在线状态探测 |
| `GET` | `/agents/ledger` | 每 Agent 工作台账 |
| `POST` | `/agents/:id/config` | 更新 Agent 配置（形象/引擎/工具等） |
| `GET` | `/room` | 会议室历史与轮次 |
| `POST` | `/room/office` | 办公室工作流（CEO 拆解→分派→执行→汇总→验货） |
| `POST` | `/room/message` | 会议室发言（@点名路由） |
| `POST` | `/room/reset` | 清空会议室 |
| `POST` | `/room/edict` | 三省六部任务流水线 |

部分接口还用于 Brain UI 内部面板，例如热点、文档、人物卡片、媒体历史、AI 视频面板、ACUI 和云端语音识别。

## 数据与持久化

爻台（Yaotai）的长期状态主要保存在本地 SQLite 数据库中，包括：

- 对话记录、参与者身份和用户画像。
- 记忆节点、记忆关系、全文检索索引和可见性状态。
- 行动日志、工具结果摘要和回合轨迹。
- 提醒、预取任务、预取缓存和 UI 信号。
- 媒体历史、音乐库和 AI 视频记录。
- 焦点线程、承诺状态和旧焦点栈迁移结果。
- 微信桥接凭证与各类本地配置。
- **多Agent办公室**：会议室对话（`data/room-conversation.json`）、决策/会议/事实记忆（`data/office-memory.json` + 知识库向量索引）、每 Agent 工作台账（`data/agent-ledger.json`）、任务流水线（`data/edict-tasks.json`）；会议结论同时写入 `memories` 表，出现在 3D 球形记忆图谱中。

`sandbox/` 用作 Agent 的工作区，适合放置生成文件、临时项目、下载内容和媒体产物。`data/` 是运行数据目录，打包时会被排除。

## 工具系统

工具 schema 按能力拆分在 `src/capabilities/schemas/` 下，运行时由 `src/capabilities/schemas.js` 汇总。主循环会根据当前消息、任务状态、最近行动日志、UI 信号和可用 Provider 能力选择本轮要暴露给模型的工具，避免每轮都注入完整工具集。

内置工具覆盖这些方向：

- 给用户或外部渠道发送消息。
- 读取、列目录、写入和删除文件。
- 执行 Shell 命令和管理长运行进程。
- 搜索网页、抓取网页、读取浏览器内容。
- 搜索、召回、写入、合并和降权记忆。
- 管理提醒和预取任务。
- 展示、更新和关闭 ACUI 卡片。
- 生成语音、控制媒体面板、管理音乐和生成视频。
- 委托本地 Agent 执行子任务。
- 复核已完成工作。
- 浏览/查看/学习/改进/删除 Agent Skills 技能包。
- 列出并调用 MCP 服务器上的外部工具。

工具市场允许安装自定义工具。安装后的工具会持久化在沙箱相关目录中，并在后续回合按需加入可用工具列表。

## Brain UI

Brain UI 是项目的主要操作界面，前端位于 `src/ui/brain-ui/`。它负责展示：

- 多渠道聊天和实时思考流。
- 记忆图、焦点线程和当前任务状态。
- **多Agent办公室**（可视化办公大厅）：CEO 与外部 A2A Agent 同桌、职能员工在工位动画执行、实时进度 SSE、状态灯、工作台账与最近完成、@点名直接派活。
- 热点信息、文档知识、人物卡片和系统提示预览。
- 语音面板、TTS 效果、微信二维码弹窗和设置页。
- ACUI 卡片，如天气、自检、唤醒、图片、视频和安全确认。

前端通过 HTTP、SSE 和 WebSocket 与后端通信。Electron 预加载脚本会额外提供桌面端能力，例如窗口缩放、更新状态和外链打开。

## 多Agent办公室

多Agent办公室是爻台内置的可视化多智能体协同工作台，在 Brain UI 中打开。

### 布局与角色

```
             会议桌
   👔 CEO 决策者 / 🧭 HermesAgent / 💻 ClaudeCode（独立外部 A2A）
   ┌───────────────┬───────────────┐
   │ 左侧工位        │ 右侧工位        │
   │ 文件管理 / 报表统计 / 电脑操作 │ 应用调度 / 检索专员 / 系统体检员 │
   └───────────────┴───────────────┘
  汇报：左侧角色到 CEO 左侧，右侧角色到 CEO 右侧
```

- **会议桌**：CEO 决策者（内部）+ 独立外部 A2A Agent（Hermes `127.0.0.1:9900`、Claude Code `127.0.0.1:9920`），以独立身份参与讨论与评审。
- **工位员工**：内部 Agent，走真实工具循环执行（文件管理=读写/归档，报表统计=python 统计，电脑操作=shell 执行，应用调度=对接，检索专员=知识/搜索，系统体检员=系统诊断）。

### 使用方式

- **直接派活**：输入指令 → CEO 结构化拆解（JSON workers）→ 员工真实执行 → 验货员证据化核实 → CEO 汇总。
- **@点名**：`@电脑操作 打开记事本` → 只让被点名员工响应。
- **系统体检**：`给电脑做一次全方位体检` → 派给系统体检员，用真实命令扫磁盘/性能/电池/大文件。
- **流程编排**：通过 `junjichu` 工具的 `workflow` action 运行预设流程（`consult` 会议桌评审 / `implement` 立项实施 / `reviewfix` 评审返工闭环），或传自定义 JSON 流程。
- **动态接入外部 Agent**：`junjichu` 工具的 `discover` action 传入 A2A URL，自动从 Agent Card 发现并拉上会议桌。

### 外部 A2A Agent 接入

外部 Agent 通过 A2A v1.0（JSON-RPC `message/send` / `tasks/get` / `tasks/cancel`）接入，Agent Card 位于 `/.well-known/agent-card.json`。办公室通过 `engine: 'a2a'` 调用，支持多轮 `contextId` 记忆、可选 Bearer token 鉴权；失败自动回退内部引擎。示例：Claude Code A2A 适配器见 `D:\ClaudeCode\a2a-test\claude_code_a2a_server.py`。

## 测试与维护脚本

常用脚本：

```bash
npm run smoke:tools
npm run smoke:brain-ui
npm run smoke:social
npm run test:rule-context
npm run test:complex-task
npm run test:relevance
npm run test:section-gate
npm run test:agent-skills
npm run test:config-upgrade
npm run test:learned-improvements
```

记忆修复和配置探测：

```bash
npm run repair:memories:dry
npm run repair:memories
npm run probe:config-upgrade
```

打包 Windows 安装包：

```bash
npm run build
```

发布到 GitHub Releases：

```bash
npm run publish
```

## 安全与访问控制

- 默认只允许本机访问本地服务。
- 敏感路径包括激活、设置、管理和记忆修改接口。
- 可以通过环境变量显式允许局域网访问。
- 可以通过 API Token 让远程请求携带凭证访问。
- 文件与工具能力经过执行器统一路由，部分危险操作会进入确认或策略流程。
- Electron 桌面端启用上下文隔离，前端通过预加载桥接访问必要能力。

## 本地优先（护城河）

BaiLongma 定位是**本地持续运行的自主 Agent**——数据与能力都在你机器上：

- **数据本地**：全部记忆/对话/配置存本地 SQLite（`data/`），不依赖云端。
- **离线可用**：本地嵌入模型（bge-large-zh）做向量召回；联网工具按需才走网络。
- **可迁移**：`backup_data` 工具一键备份 SQLite（含 WAL）快照 + 配置 + 沙箱文件到 `sandbox/backups/`，拷走即迁移。
- **可审计**：所有工具调用记录 `action_logs` + 回合轨迹（`turn-traces.jsonl`）；`backup_data` / 对抗测试集保障数据安全边界。

## 已知依赖风险（决策记录）

- **sharp（`@huggingface/transformers` 间接依赖）**：`npm audit` 报告 libvips 系列 CVE（GHSA-f88m-g3jw-g9cj 等），影响 sharp `<0.35.0`，且 0.34.x 无修复版。本项目仅用 transformers 做**纯文本嵌入**（bge-large-zh，`pipeline('feature-extraction')`），运行时**从不加载 sharp**（图像管线未触发），实际攻击面≈0；且 transformers 依赖链锁定 `sharp ^0.34`（最新版 4.2.0 仍未支持 0.35），升级需 npm overrides + 重建原生模块 + API 兼容风险。**决策：接受此风险**。若未来启用多模态/图像嵌入，需同步升级 transformers→sharp 0.35 链。
- **undici / ws**：已随版本升级修复（`undici ^6.28.0`、`ws ^8.21.3`）。

## License

[MIT License](./LICENSE)
