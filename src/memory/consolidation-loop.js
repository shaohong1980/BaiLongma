import { getCandidateEntitiesForConsolidation, getMemoriesByEntity, getMemoryCount } from '../db.js'
import { runConsolidator } from './consolidator.js'
import { maybeSyncVault } from './vault.js'
import { maybeGenerateBriefing } from '../runtime/briefing.js'
import { maybeRebuildGlobalSummaryTree } from './global-summary-tree.js'
import { runIdleMaintenance, isIdleMaintenanceDue } from '../runtime/idle-maintenance.js'

const BATCH_SIZE = 20                   // 上限让 LLM 一次能看全实体的近期记忆

// 自适应周期：记忆量少时更频繁（尽快沉淀），量大时更稀疏（省 LLM 调用与算力）。
function computeIntervalMs(memCount) {
  if (memCount < 500) return 10 * 60 * 1000   // 小库：10 分钟
  if (memCount < 5000) return 30 * 60 * 1000  // 中库：30 分钟（原默认）
  return 60 * 60 * 1000                       // 大库：60 分钟
}

// 内存里的 round-robin 游标：下次从哪个候选实体开始（v1 不持久化）
let cursor = 0

async function tick() {
  try {
    const candidates = getCandidateEntitiesForConsolidation(10)
    if (candidates.length === 0) {
      console.log('[整合循环] 无候选实体（fact/person 记忆数均 <3）')
      maybeSyncVault() // 无候选也顺带同步一次 vault（记忆整理 ≠ 实体整合）
      maybeRebuildGlobalSummaryTree() // 顺带刷新全局记忆鸟瞰树
      return
    }
    const pick = candidates[cursor % candidates.length]
    cursor = (cursor + 1) % candidates.length
    const memories = getMemoriesByEntity(pick.entity, BATCH_SIZE)
    if (!memories || memories.length === 0) {
      console.log(`[整合循环] entity=${pick.entity} 暂无记忆`)
      return
    }
    console.log(`[整合循环] 开始整合 entity=${pick.entity} (候选总数=${candidates.length})`)
    await runConsolidator({ entity: pick.entity, memories })
    maybeSyncVault() // 整合后同步 Obsidian vault（有节流）
    maybeRebuildGlobalSummaryTree() // 顺带刷新全局记忆鸟瞰树
  } catch (err) {
    console.error('[整合循环] 失败:', err)
  }
  // 每天早上首次：生成晨间简报（幂等，当天已有则跳过）
  try { await maybeGenerateBriefing() } catch (err) { console.error('[简报] 触发失败:', err?.message || err) }

  // 空闲/夜间深度整理（P2-2）：凌晨或长时间未整理时，清理旧输出 + 生成本周复盘草稿。
  // 有自身节流（每天最多一次），不影响常规记忆整合。
  try {
    if (isIdleMaintenanceDue()) await runIdleMaintenance()
  } catch (err) { console.warn('[整合循环] 空闲整理失败:', err?.message || err) }
}

let started = false
let timer = null

// 递归调度：每次 tick 后按当前记忆量重算下一次间隔，替代固定 setInterval。
async function scheduleNext() {
  if (!started) return
  try {
    const memCount = getMemoryCount() || 0
    const interval = computeIntervalMs(memCount)
    timer = setTimeout(async () => {
      timer = null
      try {
        await tick()
      } catch (err) {
        console.error('[整合循环] tick 异常:', err?.message || err)
      }
      scheduleNext()
    }, interval)
    console.log(`[整合循环] 下次运行约 ${Math.round(interval / 60000)} 分钟后（记忆 ${memCount} 条）`)
  } catch (err) {
    // getMemoryCount 异常不应让循环停摆：回退 30 分钟并继续
    timer = setTimeout(scheduleNext, 30 * 60 * 1000)
    console.warn('[整合循环] 调度异常（回退 30 分钟）:', err?.message || err)
  }
}

export function startConsolidationLoop() {
  if (started) return
  started = true
  // 启动后等 5 分钟再跑第一次，避免和启动自检挤
  setTimeout(() => { scheduleNext() }, 5 * 60 * 1000)
  console.log('[整合循环] 已注册，5 分钟后首次运行，之后按记忆量自适应周期')
}

export function stopConsolidationLoop() {
  if (timer) { clearTimeout(timer); timer = null }
  started = false
}
