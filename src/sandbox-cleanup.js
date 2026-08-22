// sandbox-cleanup.js —— 周期性清理 sandbox 测试残留 + 大小告警
//
// 测试一般用 finally 清理自己的临时目录（relevance-test-*/self-evolution-test-*/active-policy-test-*），
// 但进程被强杀（kill/超时/断电）时 finally 不执行，会越积越多（曾见 evo-jn1l3F 等残留）。
// 本模块在启动和每日定时扫一遍，只删「已知测试前缀 + 足够旧（默认 24h）」的目录，避免误删并发或用户数据。
import fs from 'fs'
import path from 'path'
import { paths } from './paths.js'
import { every } from './scheduler.js'

// 已知的测试临时目录前缀（对应 src/test-*.js 里 mkdtemp 的命名）
export const SANDBOX_TEST_DIR_PREFIXES = [
  'relevance-test-',
  'self-evolution-test-',
  'active-policy-test-',
  'evo-',
]

const SWEEP_AGE_MS = 24 * 60 * 60 * 1000     // 只删 1 天前的（防误删正在并发的同测试目录）
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000
const SIZE_WARN_BYTES = 1024 * 1024 * 1024   // 超过 1GB 告警

function totalSize(dir, depth = 0) {
  if (depth > 6) return 0
  let bytes = 0
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return 0 }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    try {
      if (entry.isDirectory()) bytes += totalSize(full, depth + 1)
      else if (entry.isFile()) bytes += fs.statSync(full).size
    } catch {}
  }
  return bytes
}

// 清扫一次过期测试残留目录，返回删除数量
export function sweepStaleSandbox(sandboxRoot = paths.sandboxDir) {
  let removed = 0
  let entries
  try { entries = fs.readdirSync(sandboxRoot, { withFileTypes: true }) } catch { return 0 }
  const cutoff = Date.now() - SWEEP_AGE_MS
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const isTestDir = SANDBOX_TEST_DIR_PREFIXES.some(p => entry.name.startsWith(p))
    if (!isTestDir) continue
    const full = path.join(sandboxRoot, entry.name)
    try {
      const stat = fs.statSync(full)
      if (stat.mtimeMs < cutoff) {
        fs.rmSync(full, { recursive: true, force: true })
        removed++
      }
    } catch {}
  }
  if (removed > 0) console.log(`[sandbox-cleanup] 清理 ${removed} 个过期测试残留目录`)
  return removed
}

// sandbox 总大小检查（只告警，不自动删用户数据）
export function checkSandboxSize(sandboxRoot = paths.sandboxDir) {
  try {
    const bytes = totalSize(sandboxRoot)
    if (bytes > SIZE_WARN_BYTES) {
      console.warn(`[sandbox-cleanup] sandbox 体积约 ${(bytes / 1048576).toFixed(0)}MB，已超过 1GB，建议手动清理`)
    }
    return bytes
  } catch {
    return 0
  }
}

export function sweepStaleSandboxAndReport() {
  sweepStaleSandbox()
  checkSandboxSize()
}

// 启动维护循环（统一 scheduler：防重叠 + 错误隔离 + unref）
export function startSandboxCleanup() {
  return every(SWEEP_INTERVAL_MS, sweepStaleSandboxAndReport, {
    name: 'sandbox-cleanup',
    runImmediately: true,
  })
}
