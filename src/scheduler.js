// scheduler.js —— 统一后台循环封装（最小治理）
//
// 项目里散布着 40+ 处 setInterval / setTimeout 手动循环。这里提供「所有后台循环」的统一薄封装，
// 默认保证：
//   · unref()：不阻止进程退出
//   · 防重叠：上一轮回调尚未结束则跳过本轮（避免循环积压 / 多 loop 排队打 SQLite）
//   · 错误隔离：回调抛错不会打断后续轮次（默认记 warn，可传 onError 自定义）
//   · 可选 runImmediately：启动后立即跑首轮（如启动即 checkpoint）
//
// 迁移方式：把 `setInterval(fn, ms)` 换成 `const loop = every(ms, fn, { name })`，
// 需要停止时 `loop.stop()`。

export function every(intervalMs, fn, { name = 'loop', onError, runImmediately = false } = {}) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error(`[scheduler] invalid interval: ${intervalMs}`)
  let running = false
  let timer = null
  let stopped = false

  const tick = async () => {
    if (stopped || running) return
    running = true
    try {
      await fn()
    } catch (err) {
      if (onError) {
        try { onError(err) } catch { /* onError 自身出错不扩散 */ }
      } else {
        console.warn(`[scheduler] ${name} 回调出错:`, err?.message || err)
      }
    } finally {
      running = false
    }
  }

  if (runImmediately) { void tick() }
  timer = setInterval(() => { void tick() }, intervalMs)
  timer.unref?.()

  return {
    stop() {
      stopped = true
      if (timer) { clearInterval(timer); timer = null }
    },
    isRunning: () => running,
  }
}
