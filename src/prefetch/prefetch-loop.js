// prefetch-loop.js —— 预取的周期自动执行（OpenHuman auto-fetch / OpenClaw auto-memory 的本地版）
//
// 之前 runPrefetch 只在工具/手动路径调用，预取缓存长期是空的 → 预热功能形同虚设。
// 这里把它挂进 consciousness-loop，像 consolidation-loop 一样定期跑：
//   - 每 30 分钟一轮（与整合循环同节奏）
//   - skipFresh：TTL 内仍新鲜的 source 自动跳过，不反复打外部 API（天气/HN/自定义 feed）
//   - 用户开口前，天气/新闻/订阅内容就已躺在缓存里，注入器直接取用
// 所有错误吞掉，绝不影响主循环。

import { runPrefetch } from './runner.js'
import { every } from '../scheduler.js'

const RUN_INTERVAL_MS = 30 * 60 * 1000   // 30 分钟
const FIRST_DELAY_MS = 10 * 60 * 1000    // 启动 10 分钟后再首次运行（避开启动自检/首次 L1）

async function tick() {
  try {
    await runPrefetch(null, { skipFresh: true })
  } catch (err) {
    console.error('[预热循环] 失败:', err?.message || err)
  }
}

let started = false
let loop = null

export function startPrefetchLoop() {
  if (started) return
  started = true
  loop = every(RUN_INTERVAL_MS, tick, {
    name: 'prefetch-loop',
    runImmediately: true,
    delayMs: FIRST_DELAY_MS,
    onError: (err) => console.error('[预热循环] 失败:', err?.message || err),
  })
  console.log(`[预热循环] 已注册，${FIRST_DELAY_MS / 60000} 分钟后首次运行，之后每 ${RUN_INTERVAL_MS / 60000} 分钟一次（跳过 TTL 内新鲜缓存）`)
}

export function stopPrefetchLoop() {
  if (loop) { loop.stop(); loop = null }
  started = false
}

