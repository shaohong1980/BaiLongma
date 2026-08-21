# 安全模型与已接受风险

> 记录 BaiLongma/爻台 的安全设计与当前已知风险的处理状态。

## 一、本地网络鉴权

- API 默认只监听 127.0.0.1；开启局域网（`start:lan` / `allowLanAccess`）时，命令面/数据面路径
  （`/message` `/agents` `/room` `/task` `/media` `/settings` `/admin` `/memories` `/knowledge`
  `/approvals` `/workflows` `/observability` 等）一律要求 `BAILONGMA_API_TOKEN`。
- `start-lan.ps1` 未设置 token 时自动生成随机值并持久化到 `.env`；前端从 URL `?token=` 读取并随请求携带。
- WebSocket 升级（scene/voice）对 LAN 同样校验 token；CORS 有 origin 白名单。

## 二、Electron 渲染层

- 所有窗口：`contextIsolation: true`、`nodeIntegration: false`、preload 隔离。
- `window.open` / 导航：只放行 `http(s)`；`javascript:`/`data:`/`file:`/自定义协议一律 `deny`。
- 主页面带 CSP（`default-src 'self'`，脚本禁 inline，connect 放行本地后端/WS）。
- DevTools 仅开发模式可开；`shell.openExternal` 仅接受 `http(s)`。

## 三、密钥存储

- **已迁移**：Provider API Key（主 LLM + Minimax）已迁到 `src/capabilities/secret-store.js`
  （Electron safeStorage 加密，非 Electron 环境 AES-256-GCM 兜底，主密钥 0o600）。
  `config.json` 中明文已清除为 `'none'` 占位。
- **读取**：`getMinimaxKey()` / 主 LLM key 从 secret-store 优先读取，回退 config.json/env（旧安装兼容）。
- **写入**：`applyConfig` / `setMinimaxKey` 写入时同步加密到 secret-store。
- **迁移**：启动时自动把 config.json 明文 key 复制到 secret-store → 验证可回读 → 才清明文（不丢 key）。
- 接口返回已脱敏（`••••` + 后 4 位）。请勿把真实 key 暴露到不受信环境。

## 四、依赖安全（npm audit）

执行 `npm audit --omit=dev` 后，**已修复**：axios / js-yaml / protobufjs / form-data / @larksuiteoapi 等。

**当前剩余（4 high，均无上游修复，已评估为可接受）**：
| 包 | 来源 | 风险 | 缓解 |
|---|---|---|---|
| `sharp`(<0.35.0) | @huggingface/transformers 传递依赖 | libvips 若干 CVE | 仅本地文本嵌入路径、懒加载；文本嵌入不使用其图片函数 |
| `adm-zip`(<0.6.0) | onnxruntime-node 传递依赖 | 恶意 ZIP 触发大内存分配 | onnxruntime 只解压受信捆绑模型，非不可信输入；懒加载 |

**对策**：`npm audit` 已纳入 CI；上游修复可用后升级 transformers 链即可。

## 五、已接受 / 待办

- [x] LAN 鉴权、CSP、导航白名单、DevTools 控制、依赖可修部分
- [ ] 密钥迁移到 secret-store（进行中）
- [ ] 定期密钥轮换
- [ ] CI 中 npm audit（随 workflow 一并添加）
