// idle-maintenance —— 空闲/夜间深度整理（P2-2）
// 在整合循环之外的低频维护：清理旧工具输出、给本周生成复盘草稿（仅当本周还没有）、
// 压缩旧对话。每天最多执行一次（持久化 last_run 到 config）。
import { getDB, getConfig, setConfig } from '../db.js'
import { saveWeeklyReview, getWeeklyReview, currentWeekKey } from '../memory/workbench.js'
import { cleanupOldToolOutputs } from './tool-result-compressor.js'
import { emitEvent } from '../events.js'
import { paths } from '../paths.js'

const RUN_KEY = 'idle_maintenance_last_run'

// 是否到了该跑的时间：凌晨 1:00–6:00，或距上次已 >36h
export function isIdleMaintenanceDue(now = new Date()) {
  const hour = now.getHours()
  const last = getConfig(RUN_KEY) || ''
  const lastTs = last ? new Date(last).getTime() : 0
  const nightWindow = hour >= 1 && hour <= 6
  const overdue = lastTs && (now.getTime() - lastTs) > 36 * 60 * 60 * 1000
  return nightWindow || overdue
}

// 本周周一起点（ISO 周，本地时区）
function weekStartIso(now = new Date()) {
  const d = new Date(now)
  const day = d.getDay() || 7
  d.setDate(d.getDate() - day + 1) // 回到周一
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

function buildWeeklyDraft() {
  const db = getDB()
  const start = weekStartIso()
  const weekKey = currentWeekKey()

  const toolRows = db.prepare(`
    SELECT tool, COUNT(*) AS c FROM action_logs
    WHERE timestamp >= ? AND source != 'recognizer'
    GROUP BY tool ORDER BY c DESC LIMIT 8
  `).all(start)

  const todosDone = db.prepare(`
    SELECT COUNT(*) AS c FROM workbench_todos WHERE status = 'done' AND completed_at >= ?
  `).get(start)?.c || 0

  const tasksDone = db.prepare(`
    SELECT COUNT(*) AS c FROM memories WHERE event_type = 'task_complete' AND timestamp >= ?
  `).get(start)?.c || 0

  const lines = []
  lines.push(`# 每周复盘草稿（${weekKey}）`)
  lines.push(`> 这是系统空闲时自动生成的草稿，供你补充修改后确认。`)
  lines.push('')
  if (todosDone) lines.push(`**本周完成待办：${todosDone} 项**`)
  if (tasksDone) lines.push(`**本周完成任务：${tasksDone} 项**`)
  if (toolRows.length) {
    lines.push('')
    lines.push(`**本周主要动作**（按次数）：`)
    for (const r of toolRows) lines.push(`- ${r.tool} × ${r.c}`)
  }
  lines.push('')
  lines.push(`**本周收获 / 不足 / 下周计划**：（待你补充）`)
  return lines.join('\n')
}

export async function runIdleMaintenance({ force = false } = {}) {
  if (!force && !isIdleMaintenanceDue()) return []
  const done = []

  // 1. 清理旧工具输出（释放磁盘；函数自带 6h 节流，这里 force=false）
  try {
    cleanupOldToolOutputs({ dataDir: paths.dataDir, force: false })
    done.push('清理旧工具输出')
  } catch (err) { console.warn('[idle-maintenance] 清理工具输出失败:', err.message) }

  // 2. 本周复盘草稿（仅当本周还没有复盘时生成）
  const weekKey = currentWeekKey()
  try {
    if (!getWeeklyReview(weekKey)) {
      const draft = buildWeeklyDraft()
      if (draft) {
        saveWeeklyReview({ weekKey, content: draft, mood: '' })
        done.push(`已生成本周复盘草稿（${weekKey}）`)
        emitEvent('workbench_updated', { source: 'idle_maintenance' })
      }
    }
  } catch (err) { console.warn('[idle-maintenance] 复盘草稿失败:', err.message) }

  if (done.length) {
    setConfig(RUN_KEY, new Date().toISOString())
    console.log('[idle-maintenance] 完成:', done.join(' | '))
    emitEvent('action', { tool: 'idle_maintenance', summary: '空闲自动整理完成', detail: done.join(' | ') })
  }
  return done
}
