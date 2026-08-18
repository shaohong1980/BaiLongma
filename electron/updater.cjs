// updater.cjs —— 自动更新器（自 electron/main.cjs 拆出）
// 职责：electron-updater 事件监听、初始检查、以及 updater:* IPC 处理。
// sendStatus 由 main.cjs 注入（用 mainWindow 转发到渲染层，并附带 currentVersion）。
const { autoUpdater } = require('electron-updater')

function setupAutoUpdater({ isPortable, isDev, sendStatus }) {
  if (isPortable) {
    console.log('[updater] skipped in portable mode')
    sendStatus({ stage: 'portable', portable: true })
    return
  }

  autoUpdater.autoDownload = false
  // Avoid applying an already downloaded update while Windows is shutting down.
  // The renderer still installs explicitly through updater:quit-and-install.
  autoUpdater.autoInstallOnAppQuit = false

  autoUpdater.on('checking-for-update', () => {
    sendStatus({ stage: 'checking' })
  })

  autoUpdater.on('update-available', info => {
    console.log('[updater] update available', info?.version)
    sendStatus({ stage: 'available', version: info?.version })
  })

  autoUpdater.on('download-progress', progress => {
    sendStatus({
      stage: 'downloading',
      percent: Number(progress?.percent || 0),
      transferred: progress?.transferred || 0,
      total: progress?.total || 0,
    })
  })

  autoUpdater.on('update-downloaded', info => {
    console.log('[updater] update downloaded', info?.version)
    sendStatus({ stage: 'downloaded', version: info?.version })
  })

  autoUpdater.on('update-not-available', info => {
    sendStatus({
      stage: 'up-to-date',
      version: info?.version,   // sendStatus 会附带 currentVersion 兜底
    })
  })

  autoUpdater.on('error', err => {
    const message = err?.message || String(err || 'Update failed')
    console.warn('[updater] update failed', message)
    sendStatus({ stage: 'error', message })
  })

  if (!isDev) {
    autoUpdater.checkForUpdates().catch(err => {
      // 不要静默吞掉更新检查失败。GitHub 在国内经常超时/不可达，若整段吞掉，
      // 用户会卡在「永远没有更新」且无任何痕迹。这里至少落到日志，便于排查。
      console.warn('[updater] initial check failed', err?.message || err)
    })
  }
}

function registerUpdaterIpc(ipcMain, { isPortable, isDev, sendStatus }) {
  ipcMain.handle('updater:check-for-updates', async () => {
    if (isPortable) {
      sendStatus({ stage: 'portable', portable: true })
      return { ok: false, skipped: true, reason: 'portable' }
    }
    if (isDev) {
      sendStatus({ stage: 'dev' })
      return { ok: false, skipped: true, reason: 'dev' }
    }
    try {
      sendStatus({ stage: 'checking' })
      const result = await autoUpdater.checkForUpdates()
      return { ok: true, updateInfo: result?.updateInfo || null }
    } catch (error) {
      const message = error?.message || String(error || 'Update check failed')
      sendStatus({ stage: 'error', message })
      return { ok: false, message }
    }
  })

  ipcMain.handle('updater:start-download', async () => {
    if (isPortable) {
      sendStatus({ stage: 'portable', portable: true })
      return { ok: false, skipped: true, reason: 'portable' }
    }
    try {
      await autoUpdater.downloadUpdate()
      return { ok: true }
    } catch (error) {
      const message = error?.message || String(error || 'Download failed')
      sendStatus({ stage: 'error', message })
      return { ok: false, message }
    }
  })

  ipcMain.handle('updater:quit-and-install', () => {
    if (isPortable) {
      sendStatus({ stage: 'portable', portable: true })
      return { ok: false, skipped: true, reason: 'portable' }
    }
    autoUpdater.quitAndInstall()
    return { ok: true }
  })
}

module.exports = { setupAutoUpdater, registerUpdaterIpc }
