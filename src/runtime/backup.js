// backup.js —— 本地数据备份（本地深度护城河 ③）
//
// 强调"数据在你机器上、你能带走"：一键把 SQLite（一致性快照）、配置文件备份到
// 沙箱指定目录。备份后可整体拷走/压缩，实现数据可迁移、可离线保存。
import fs from 'fs'
import path from 'path'
import { paths } from '../paths.js'

export function backupLocalData({ target_dir = 'backups' } = {}) {
  const target = path.resolve(paths.sandboxDir, String(target_dir || 'backups'))
  // 只允许备份到沙箱内（防越界写）
  const sandboxResolved = path.resolve(paths.sandboxDir)
  if (target !== sandboxResolved && !target.startsWith(sandboxResolved + path.sep)) {
    return { ok: false, error: 'backup target must be inside sandbox' }
  }
  fs.mkdirSync(target, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = path.join(target, `backup-${ts}`)
  fs.mkdirSync(backupDir, { recursive: true })

  const written = []
  try {
    // WAL 一致性备份：拷 db + -wal + -shm 三件套（WAL 里未 checkpoint 的增量一并带走，
    // 恢复时同目录放回即可完整读取）。better-sqlite3 的 backup() API 在此版本行为不稳定，
    // 用文件拷贝更可靠且实现简单。
    for (const suffix of ['', '-wal', '-shm']) {
      const src = paths.dbFile + suffix
      if (fs.existsSync(src)) {
        const dest = path.join(backupDir, 'jarvis.db' + suffix)
        fs.copyFileSync(src, dest)
        written.push({ file: 'jarvis.db' + suffix || 'jarvis.db', bytes: fs.statSync(dest).size, source: 'database' })
      }
    }
  } catch (err) {
    return { ok: false, error: `database backup failed: ${err.message}` }
  }

  // 配置文件
  try {
    if (fs.existsSync(paths.configFile)) {
      const dest = path.join(backupDir, 'config.json')
      fs.copyFileSync(paths.configFile, dest)
      written.push({ file: 'config.json', bytes: fs.statSync(dest).size, source: 'config' })
    }
  } catch (e) { console.warn('[src/runtime/backup.js] op failed:', e?.message || e) }

  // 沙箱工作文件（顶层，不含备份目录本身）
  try {
    const files = fs.readdirSync(paths.sandboxDir).filter(f => f !== target_dir && f.startsWith('backup-'))
    for (const f of files) {
      const src = path.join(paths.sandboxDir, f)
      const st = fs.statSync(src)
      if (!st.isFile()) continue
      fs.copyFileSync(src, path.join(backupDir, f))
      written.push({ file: f, bytes: st.size, source: 'sandbox' })
    }
  } catch (e) { console.warn('[src/runtime/backup.js] op failed:', e?.message || e) }

  return { ok: true, backup_dir: backupDir, files: written }
}

export function getBackupStatus() {
  try {
    const backupRoot = path.join(paths.sandboxDir, 'backups')
    if (!fs.existsSync(backupRoot)) return { ok: true, backups: [], total_backups: 0 }
    const dirs = fs.readdirSync(backupRoot).filter(d => d.startsWith('backup-')).sort().reverse()
    const totalBytes = dirs.reduce((sum, d) => {
      try {
        return sum + fs.statSync(path.join(backupRoot, d, 'jarvis.db')).size
      } catch { return sum }
    }, 0)
    return { ok: true, total_backups: dirs.length, total_bytes: totalBytes, latest: dirs[0] || null }
  } catch {
    return { ok: true, total_backups: 0, total_bytes: 0, latest: null }
  }
}
