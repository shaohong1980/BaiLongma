// receipts.js —— 工具执行加密回执 API（ZeroClaw tool receipts 移植）
//
//   GET  /audit/receipts/:id        取某条 action_log 的回执（无则返回 null）
//   POST /audit/receipts/verify     验签一个回执对象
//   GET  /audit/receipts/verify/:id 取回执并当场验签（一个请求给结论）
//
// 敏感接口走 requireLocalOrToken；验签是本地 HMAC，无网络依赖。
import { jsonResponse, readJsonBody } from '../utils.js'
import { getActionLog } from '../../db.js'
import { buildReceiptForLogRow, verifyToolReceiptSafe } from '../../capabilities/tool-receipts.js'

function receiptForRow(row) {
  if (!row) return null
  if (row.receipt) {
    try { return JSON.parse(row.receipt) } catch (e) { console.warn('[src/api/routes/receipts.js] op failed:', e?.message || e) }
  }
  // 历史行没有回执：按当前存储值现算一份（不写回，只用于展示）
  return buildReceiptForLogRow(row)
}

export async function handleReceiptRoutes(req, res, url, { requireLocalOrToken } = {}) {
  // GET /audit/receipts/:id
  const match = req.method === 'GET' && url.pathname.match(/^\/audit\/receipts\/(\d+)$/)
  if (match) {
    if (!requireLocalOrToken?.(req, res, url)) return true
    const row = getActionLog(Number(match[1]))
    jsonResponse(res, 200, { ok: true, id: Number(match[1]), receipt: row ? receiptForRow(row) : null })
    return true
  }

  // GET /audit/receipts/verify/:id
  const verifyMatch = req.method === 'GET' && url.pathname.match(/^\/audit\/receipts\/verify\/(\d+)$/)
  if (verifyMatch) {
    if (!requireLocalOrToken?.(req, res, url)) return true
    const row = getActionLog(Number(verifyMatch[1]))
    if (!row) { jsonResponse(res, 404, { ok: false, error: 'action_log 不存在' }); return true }
    const receipt = receiptForRow(row)
    if (!receipt) { jsonResponse(res, 200, { ok: true, valid: false, reason: '该记录无回执' }); return true }
    const result = verifyToolReceiptSafe(receipt)
    jsonResponse(res, 200, { ok: true, ...result, receipt })
    return true
  }

  // POST /audit/receipts/verify
  if (req.method === 'POST' && url.pathname === '/audit/receipts/verify') {
    if (!requireLocalOrToken?.(req, res, url)) return true
    try {
      const body = await readJsonBody(req)
      const result = verifyToolReceiptSafe(body?.receipt || body)
      jsonResponse(res, 200, { ok: true, ...result })
    } catch (err) {
      jsonResponse(res, 400, { ok: false, error: err.message || String(err) })
    }
    return true
  }

  return false
}
