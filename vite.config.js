// vite.config.js —— Brain UI 构建（P1-10，渐进接入）
//
// 现状：Brain UI 46 个模块文件直接以 <script type="module"> 加载，无需构建即可跑
// （后端 src/api/routes/static.js 直接服务源码）。本配置提供一条**可选的**打包路径：
//   `npm run build:ui` → 产物到 dist-ui/（tree-shaking + 代码分割 + 动态 import）。
//
// 接入策略（不破坏现状）：
//   · 后端若检测到 dist-ui/ 存在则服务打包产物，否则回退源码加载（见 static.js 改造点）。
//   · 等 GUI 验证打包版正常后，再把 three/rive 等 vendor 迁到 npm 依赖、启用完整 tree-shaking。
//
// 注意：
//   · three/rive 走本地 vendor + 动态 import（含 CDN 兜底），这里不预构建它们；
//   · 路径用相对 base，方便后端从任意前缀下服务产物。
import { defineConfig } from 'vite'

export default defineConfig({
  root: '.',
  base: './',
  build: {
    outDir: 'dist-ui',
    emptyOutDir: true,
    // three/rive 等 vendor 很大，压制 chunk 体积告警噪音
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      input: {
        main: 'index.html',
        // 其余独立页面作为多页入口（各自 <script> 直接加载，暂不强制打包内联）
        activation: 'activation.html',
        website: 'website.html',
        systemPrompt: 'systemPrompt.html',
        turnTrace: 'turn-trace.html',
        focusBanner: 'focus-banner.html',
      },
    },
  },
  // 大型 vendored 库保持运行时动态 import，不参与预构建扫描
  optimizeDeps: {
    exclude: ['src/ui/brain-ui/vendor/**'],
  },
})
