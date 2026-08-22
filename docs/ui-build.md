# Brain UI 构建体系（P1-10）

## 现状与策略
Brain UI 共 46 个模块文件，历史上**直接以 `<script type="module">` 加载**（无需构建即可跑，
后端 `src/api/routes/static.js` 服务源码）。本轮引入 Vite 提供**可选的打包路径**，不破坏现状：

- 默认仍服务源码（零依赖、无需构建）。
- 只有同时满足「`config.json` 里 `ui.useBundledBuild: true`」且「`dist-ui/` 存在」时，
  才改服务打包产物（`vite build` 输出到 `dist-ui/`）。
- 切换前务必先在 GUI 里 `npm run build:ui && npm start` 人工验证打包版正常。

## 使用

```bash
npm run build:ui            # vite build → dist-ui/
# 验证构建产物：dist-ui/index.html + dist-ui/assets/*
# 然后在 config.json 加：{ "ui": { "useBundledBuild": true } }
# 重启后端，/ 与 /assets/* 即走打包产物；删掉该字段或删 dist-ui/ 即回退源码。
```

## 构建产物（`dist-ui/`，已 gitignore）
- 入口：`index.html` + 独立页（activation / website / systemPrompt / turn-trace / focus-banner）
- `assets/main-*.js`（应用主包，~489KB）、`assets/knowledge-sphere-*.js`（动态 import 拆包）、
  `assets/pinyin-pro-*.js`（动态 import 拆包）、`assets/main-*.css`（styles.css 打包）
- 地球贴图等资源按需输出（`assets/earth_*.jpg/png`）

## 已生效的构建能力
- ✅ 75 模块 tree-shaking 打包 + 代码分割（动态 import 拆 chunk：knowledge-sphere / pinyin-pro）
- ✅ CSS 打包
- ✅ 多页入口
- ⏳ 尚未做（待 GUI 验证打包版后逐步迁移）：
  - three/rive 从 vendored → npm 依赖（`import 'three'` 需构建环境才能解析）
  - 移除大型 vendored 文件（`vendor/three/` 1.3MB、`vendor/rive/` 5MB）
  - CSS 模块化
  - 开发模式 vite dev server

## 切换时的注意事项
- **CSP**：打包版 index.html 沿用源码的 CSP；`unsafe-eval` 已移除，three 本地加载无需 eval。
- **动态 import 的 three**：hotspot-earth/knowledge-sphere 用 `import(THREE_LOCAL)`（本地 vendor）
  + CDN 兜底；Vite 构建会保留这些运行时动态 import，不预构建 vendor。
- **Electron/后端**：`bundledUiEnabled()` 每请求读一次 config.json（`readParsedConfig`），
  开关即时生效，无需重启后端。
