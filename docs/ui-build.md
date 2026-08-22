# Brain UI 构建体系（P1-10）

## 现状与策略
Brain UI 共 46 个模块文件。已引入 Vite 打包，**打包版成为默认**：

- 后端 `src/api/routes/static.js`：只要 `dist-ui/`（`npm run build:ui` 产物）存在就服务打包版；
  否则回退源码直载。
- **双模式兼容**：three / pinyin-pro 走「npm 优先 → 本地 vendor → CDN」动态 import 链——
  - 打包版：`import('three')` / `import('pinyin-pro')` 解析到 npm（tree-shaking、独立 chunk）。
  - 源码直载：浏览器解析不了裸 specifier 会抛错，自动回退到本地 vendor（`@vite-ignore` 让打包版不重复打包）。
- 切换回源码：删除 `dist-ui/` 即可。

## 使用

```bash
npm run build:ui            # vite build → dist-ui/
npm start                   # 后端检测到 dist-ui/ 即服务打包版
rm -rf dist-ui              # 回退源码直载
```

## 构建产物（`dist-ui/`，已 gitignore）
- 入口：`index.html` + 独立页（activation / website / systemPrompt / turn-trace / focus-banner）
- `assets/main-*.js`（应用主包，~489KB）
- `assets/three.module-*.js`（npm three，动态 import 独立 chunk，~658KB，比 vendored 1.3MB 小）
- `assets/esm-*.js`（npm pinyin-pro 独立 chunk，~296KB）
- `assets/knowledge-sphere-*.js`（动态 import 拆包）、`assets/main-*.css`（styles.css 打包）
- 地球贴图等资源按需输出（`assets/earth_*.jpg/png`）

## 已生效的构建能力
- ✅ 104 模块打包 + 代码分割（three / pinyin-pro / knowledge-sphere 独立 chunk）
- ✅ three / pinyin-pro 迁到 npm 依赖（`vendor/three`、`vendor/pinyin-pro` 降级为源码兜底）
- ✅ CSS 打包、多页入口
- ✅ 删除大型 vendored d3（`vendor/d3/d3.v7.min.js`；npm d3 路由保留供 smoke）
- ⏳ 尚未做（需 GUI 验证后继续）：
  - rive → npm（`@rive-app/canvas`，voice-rive.js 需重写，风险高）
  - CSS 模块化（styles.css 8464 行拆分）
  - 开发模式 vite dev server

## 切换时的注意事项
- **CSP**：打包版 index.html 沿用源码的 CSP；`unsafe-eval` 已移除，three 本地加载无需 eval。
- **Electron/后端**：`bundledUiEnabled()` 仅检查 `dist-ui/` 是否存在，无需 config 开关。
- **源码兜底**：`vendor/three/three.module.js`（1.3MB）与 `vendor/pinyin-pro/pinyin-pro.mjs`（564KB）
  保留供源码直载；确认打包版在 GUI 稳定后可删除（届时源码直载不再可用）。

