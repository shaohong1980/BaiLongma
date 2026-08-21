// vault.js —— 记忆 Markdown 库（ReMe 双写）API
//
//   GET  /vault/status   vault 状态（文件数 / 更新时间）
//   POST /vault/sync     把记忆导出/刷新到 Markdown（记忆 → Markdown）
//   POST /vault/import   把 Markdown 里的编辑回写进记忆库（Markdown → 记忆）
//   POST /vault/open     用系统默认方式打开 vault 目录
//
// 路径说明：本地优先，vault 读写是纯本地副作用。敏感接口走 requireLocalOrToken。
import { jsonResponse } from '../utils.js'
import {
  exportVault, importVaultEdits, getVaultStatus, openVault,
} from '../../memory/vault.js'

export async function handleVaultRoutes(req, res, url, { requireLocalOrToken } = {}) {
  if (req.method === 'GET' && url.pathname === '/vault/status') {
    jsonResponse(res, 200, getVaultStatus())
    return true
  }

  if (req.method === 'POST' && url.pathname === '/vault/sync') {
    if (!requireLocalOrToken?.(req, res, url)) return true
    try {
      const result = exportVault()
      jsonResponse(res, 200, result)
    } catch (err) {
      jsonResponse(res, 400, { ok: false, error: err.message || String(err) })
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/vault/import') {
    if (!requireLocalOrToken?.(req, res, url)) return true
    try {
      const result = importVaultEdits()
      jsonResponse(res, 200, result)
    } catch (err) {
      jsonResponse(res, 400, { ok: false, error: err.message || String(err) })
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/vault/open') {
    if (!requireLocalOrToken?.(req, res, url)) return true
    const result = await openVault()
    jsonResponse(res, 200, result)
    return true
  }

  return false
}
