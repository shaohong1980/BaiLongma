import Database from 'better-sqlite3'
import { paths } from '../paths.js'
import { initializeSchema } from './schema.js'

const DB_PATH = paths.dbFile

let db

export function getDB() {
  if (!db) {
    db = new Database(DB_PATH)
    db.pragma('journal_mode = WAL')
    initializeSchema(db)
  }
  return db
}

export function closeDBForTest() {
  if (!db) return
  // P0-5：关闭前 checkpoint WAL，避免测试库残留膨胀的 -wal/-shm 文件
  try { db.pragma('wal_checkpoint(TRUNCATE)') } catch {}
  db.close()
  db = null
}
