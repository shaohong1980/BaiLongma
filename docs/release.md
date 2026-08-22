# 发布与签名/公证（P2-18）

> 覆盖 Windows 代码签名、macOS notarization、发布前 smoke 与 GitHub Release 发布链路。

## 一、本地构建

```bash
npm run build          # 本机默认平台
npm run build:win      # 仅 Windows（nsis x64）
npm run build:mac      # 仅 macOS（dmg x64+arm64，需在 mac 上跑）
node scripts/smoke-release.mjs   # 构建后校验产物（--deep 额外校验解包内容）
```

electron-builder 产物在 `dist/`。构建时 `npmRebuild=false`，原生模块（better-sqlite3）需先按 electron ABI 重编：
```bash
npx @electron/rebuild -f -w better-sqlite3 -v 43.4.1
```
> 国内网络下 electron 头文件下载慢，可设 `npm_config_disturl=https://npmmirror.com/mirrors/electron/`。

## 二、Windows 代码签名

electron-builder 通过环境变量注入证书（证书**不提交仓库**）：

| 环境变量 | 说明 |
|---|---|
| `CSC_LINK` | 签名证书，`.pfx` base64 编码 或 file:// 路径 |
| `CSC_KEY_PASSWORD` | 证书密码 |

签名配置在 `package.json > build.win`：
- `signingHashAlgorithms: ["sha256"]`
- 平台资源裁剪：`win.files` 排除 darwin/linux 的 sharp/sherpa 原生二进制，减小安装包。

**本地签名示例**：
```powershell
$env:CSC_LINK = (Get-Content cert.pfx -AsByteStream -Raw | [Convert]::ToBase64String)
$env:CSC_KEY_PASSWORD = '你的密码'
npm run build:win
```

## 三、macOS notarization

electron-builder 对 mac 包做公证需要 Apple 开发者账号：

| 环境变量 | 说明 |
|---|---|
| `APPLE_ID` | Apple ID |
| `APPLE_APP_SPECIFIC_PASSWORD` | 专用密码（appleid.apple.com → App 专用密码） |
| `APPLE_TEAM_ID` | 团队 ID（Apple Developer 后台） |

配置在 `package.json > build.mac`：
- `hardenedRuntime: true`（公证必需）
- `gatekeeperAssess: false`
- `notarize: true`
- `mac.files` 排除 win32/linux 的 sharp/sherpa 原生二进制。

> 未配置 `APPLE_*` 时 electron-builder 跳过公证但保留 hardenedRuntime；发布仍会成功，只是包未经公证（Gatekeeper 会警告）。

## 四、GitHub Release 发布

打标签自动触发 `.github/workflows/release.yml`：

```bash
git tag v2.1.516
git push origin v2.1.516
```

工作流在 **Windows + macOS** 两个 runner 上并行：
1. `npm ci --ignore-scripts` + 按 electron ABI 重编 better-sqlite3
2. `npm run lint`
3. `electron-builder --publish always`（win 用 CSC_* 签名、mac 用 APPLE_* 公证）
4. `node scripts/smoke-release.mjs --deep`（发布前冒烟：校验安装包/asar/原生模块）

**需要的 GitHub Secrets**（Settings → Secrets and variables → Actions）：
`CSC_LINK`、`CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`。

## 五、发布前冒烟清单（scripts/smoke-release.mjs）

- Windows nsis 安装包存在且 >10MB（非空壳）
- macOS dmg 存在且 >10MB
- `app.asar` 存在且 >1MB
- `--deep`：解包目录含 electron 可执行文件、app.asar、better-sqlite3 原生模块

## 六、已知事项

- **publish provider 已修正**为 `github.com/shaohong1980/BaiLongma`（此前 owner 是旧的 `xiaoyuanda666-ship-it`，会导致上传 404）。
- 模型文件（ONNX/whisper）由运行时下载到 `userData/data/models`，不进安装包（见 `src/paths.js` modelsDir）；`asarUnpack` 只放推理运行时二进制。
- 自动更新（electron-updater）走 GitHub Release；`electron-updater` 需要签名才能静默更新（Windows），未签名时用户会看到 SmartScreen 提示。
