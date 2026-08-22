import Database from 'better-sqlite3'
import { paths } from '../paths.js'
import { initializeSchema } from './schema.js'
import { every } from '../scheduler.js'

const DB_PATH = paths.dbFile

// WAL 维护：每 30 分钟 checkpoint，防 -wal 文件无限增长（此前可见 data/jarvis.db-wal 涨到 4MB+）。
const WAL_CHECKPOINT_INTERVAL_MS = 30 * 60 * 1000
// 增量 VACUUM：每 6 小时看一次空闲页（= 12 个 checkpoint 周期），占比超过阈值才回收，避免频繁重建。
const VACUUM_EVERY_TICKS = 12
const VACUUM_FREE_PAGE_RATIO = 0.25

let db
let maintenanceTimer = null

// 一次性把 auto_vacuum 切到 INCREMENTAL（需要一次全量 VACUUM 使其生效）。
// 之后周期性 incremental_vacuum 就能只回收空闲页，不必整库重建。
function ensureIncrementalVacuum() {
  try {
    if (db && db.pragma('auto_vacuum', { simple: true }) === 0) {
      db.pragma('auto_vacuum = INCREMENTAL')
      db.exec('VACUUM')
    }
  } catch (e) {
    console.warn('[db/connection] 切换 auto_vacuum=INCREMENTAL 失败:', e?.message || e)
  }
}

// 单次维护：WAL checkpoint + 按空闲页比例增量 VACUUM。可导出供测试/手动调用。
// checkVacuum 传 false 可跳过空闲页检查（由调度器按计数节流）。
export function runDbMaintenance(checkVacuum = true) {
  if (!db || db.open === false) return
  try {
    db.pragma('wal_checkpoint(TRUNCATE)')
  } catch (e) {
    console.warn('[db/connection] wal_checkpoint failed:', e?.message || e)
  }
  if (!checkVacuum) return
  try {
    const freelist = db.pragma('freelist_count', { simple: true })
    const pageCount = db.pragma('page_count', { simple: true })
    if (freelist > 0 && pageCount > 0 && freelist / pageCount > VACUUM_FREE_PAGE_RATIO) {
      db.pragma('incremental_vacuum')
    }
  } catch (e) {
    console.warn('[db/connection] incremental_vacuum failed:', e?.message || e)
  }
}

// 启动维护循环（统一 scheduler：WAL checkpoint 每 30min + 增量 VACUUM 每 6h 检查）。
export function startDbMaintenance(dbInstance = getDB()) {
  if (maintenanceTimer) return
  db = dbInstance
  let tickCount = 0
  maintenanceTimer = every(WAL_CHECKPOINT_INTERVAL_MS, () => {
    tickCount += 1
    // 启动首轮也立即 checkpoint（WAL 可能已在积压）
    runDbMaintenance(tickCount % VACUUM_EVERY_TICKS === 0)
  }, { name: 'db-maintenance', runImmediately: true })
  return maintenanceTimer
}

export function getDB() {
  if (!db) {
    db = new Database(DB_PATH)
    db.pragma('journal_mode = WAL')
    ensureIncrementalVacuum()
    initializeSchema(db)
  }
  return db
}

export function closeDBForTest() {
  if (maintenanceTimer) {
    try { maintenanceTimer.stop() } catch (e) { console.warn('[db/connection] op failed:', e?.message || e) }
    maintenanceTimer = null
  }
  if (!db) return
  // P0-5：关闭前 checkpoint WAL，避免测试库残留膨胀的 -wal/-shm 文件
  try { db.pragma('wal_checkpoint(TRUNCATE)') } catch {}
  db.close()
  db = null
}
