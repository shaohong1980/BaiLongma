// vitest.config.js —— 单元测试（Vitest）
//
// 迁移策略（渐进式）：
//   · tests/**/*.test.js 是 Vitest 管理的纯逻辑单测（不依赖 better-sqlite3/Electron 原生 ABI）。
//   · 依赖原生模块 / LLM / 网络 / Electron 的集成测试仍由 scripts/run-tests.mjs 接管
//     （node/electron 自动选运行时），后续逐步迁入。
//   · 覆盖率用 v8 provider，include 只列已迁移的文件；当前全局约 81% 语句 / 83% 行，
//     阈值 70/70/60/70 已达标，随迁移进度上调。
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: [
        'src/scheduler.js',
        'src/workflow/expr-eval.js',
        'src/runtime/tick-policy.js',
        'src/runtime/turn-trace.js',
        'src/capabilities/tools/web/util.js',
        'src/social/middleware.js',
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 60,
        statements: 70,
      },
    },
  },
})
