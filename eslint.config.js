// ESLint 扁平配置（ESLint 9+）。
// 本仓库后端为 ESM（package.json "type": "module"），Electron 主进程为 CJS（*.cjs）。
// 启用方式（在安装了 eslint 与 globals 后）：
//   npm i -D eslint globals
//   npx eslint src electron scripts
//
// 规则取向：仓库历史代码风格宽松，因此以「非破坏的防回归」为主——
//   只启用不会大面积报红、但能拦住真正 bug 的规则（未定义变量 / 未用变量 / 重复导入等）。
//   团队若想推进更严的规则（如 no-console），可逐步在 override 里加。

import js from '@eslint/js'
import globals from 'globals'

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'dist-v2/**',
      'build/**',
      'sandbox/**',
      'data/**',
      'voice-dist/**',
      'src/voice/whisper/**',   // 第三方 Python 仓库迁移来的推理代码，不做 JS lint
      'src/ui/brain-ui/vendor/**',  // 压缩 vendored 三方库（three/rive/d3/pinyin-pro 等）
      '**/__pycache__/**',
      '*.min.js',
    ],
  },

  // 后端 src（ESM，Node 环境）
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,   // 部分模块（如 ui-bridge）在 Electron 渲染进程运行
        process: 'readonly',
        globalThis: 'readonly',
        Buffer: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        structuredClone: 'readonly',
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      // 项目风格：允许 catch {} 空捕获（约定用于非致命后台路径）
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-control-regex': 'off',          // 语言词法/正则里大量使用控制字符类
      'no-useless-escape': 'off',
      'no-prototype-builtins': 'off',
      // `while ((m = re.exec(s)) !== null)` 是惯用正则循环，except-parens 无法豁免，
      // 该规则对本代码库误报过多，关闭（真实笔误 `if (a = b)` 由 code review 覆盖）。
      'no-cond-assign': 'off',
      'no-useless-assignment': 'warn',    // 历史代码有大量"先赋值后覆盖"，降级不阻塞
      'no-constant-binary-expression': 'warn',
      'no-unreachable': 'warn',
    },
  },

  // Electron 主进程（CJS）
  {
    files: ['electron/**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.electron },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-useless-escape': 'off',
      'no-prototype-builtins': 'off',
      'no-cond-assign': 'off',            // 同 src：正则循环误报
      'no-useless-assignment': 'warn',
    },
  },

  // 脚本（ESM .mjs / CJS .cjs 混用）
  {
    files: ['scripts/**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 'latest',   // 部分脚本用了 ES2025 import attributes（如 smoke-mac-artifacts）
      sourceType: 'module',
      // 部分脚本在浏览器上下文执行（page.evaluate / 前端工具），补 browser globals
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-constant-condition': 'off',
      'no-cond-assign': 'off',            // 同 src：正则循环误报
      'no-useless-assignment': 'warn',
    },
  },
]
