// retention.js —— P0-5：数据保留策略（周期性清理膨胀表，防磁盘无限增长）
// 清理对象：
//   action_logs   ：每次工具调用写一行，无限增长 → 保留 90 天
//   media_history ：媒体播放历史 → 保留 180 天
//   prefetch_cache：过期条目（repository 已按需清理，这里兜底再清）
import { getDB } from '../db.js'
import { every } from '../scheduler.js'

const RETENTION_DAYS = {
  action_logs: 90,
  media_history: 180,
}

export function pruneRetention(db = getDB()) {
  try {
    const nowIso = new Date().toISOString()
    const actionCutoff = new Date(Date.now() - RETENTION_DAYS.action_logs * 86400000).toISOString()
    const mediaCutoff = new Date(Date.now() - RETENTION_DAYS.media_history * 86400000).toISOString()

    const logs = db.prepare(`DELETE FROM action_logs WHERE timestamp < ?`).run(actionCutoff)
    const media = db.prepare(`DELETE FROM media_history WHERE played_at < ?`).run(mediaCutoff)
    const prefetch = db.prepare(`DELETE FROM prefetch_cache WHERE expires_at <= ?`).run(nowIso)

    const total = logs.changes + media.changes + prefetch.changes
    if (total > 0) console.log(`[retention] 清理 action_logs=${logs.changes} media_history=${media.changes} prefetch_expired=${prefetch.changes}`)
  } catch (e) {
    console.warn('[retention] prune failed:', e?.message || e)
  }
}

// 启动时跑一次 + 每日定时清理（统一 scheduler：防重叠 + 错误隔离 + unref）
export function startRetentionLoop(db = getDB()) {
  return every(24 * 60 * 60 * 1000, () => pruneRetention(db), {
    name: 'retention',
    runImmediately: true,
    onError: (e) => console.warn('[retention] prune failed:', e?.message || e),
  })
}
