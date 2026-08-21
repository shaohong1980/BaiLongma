// tool-receipts.js —— 工具执行加密回执（ZeroClaw tool receipts 移植）
//
// 每次工具执行在 action_logs 落盘时，额外生成一份「可验证回执」：
//   - 对 (id|tool|timestamp|status|risk|source|args_hash|result_hash|summary) 做 HMAC-SHA256
//   - 密钥为本机安装级随机密钥（data/.tool-receipt.key，首次生成后固定）
//   - 回执 JSON 存回 action_logs.receipt 列
//
// 意义：任何人（用户 / 外部审计 / Agent 自己）拿到一条 action_log，都能用本地密钥
// 验签确认「这条日志是这台机器上生成且未被篡改」。args/result 只存哈希，不扩大敏感面。
import fs from 'fs'
import path from 'path'
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'crypto'
import { paths } from '../paths.js'
import { config } from '../config.js'

const RECEIPT_VERSION = 1
const SECRET_FILE = path.join(paths.dataDir, '.tool-receipt.key')

let secretCache = null

// 本机安装级密钥：首次调用生成并落盘；之后复用。
export function getReceiptSecret() {
  if (secretCache) return secretCache
  try {
    if (fs.existsSync(SECRET_FILE)) {
      const raw = fs.readFileSync(SECRET_FILE, 'utf8').trim()
      if (raw && raw.length >= 32) {
        secretCache = raw
        return secretCache
      }
    }
  } catch (e) { console.warn('[src/capabilities/tool-receipts.js] op failed:', e?.message || e) }
  const secret = randomBytes(32).toString('hex')
  try {
    fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true })
    fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 })
  } catch (err) {
    console.warn('[tool-receipts] 无法持久化回执密钥（本进程内密钥仍有效）:', err?.message || err)
  }
  secretCache = secret
  return secretCache
}

// 回执开关：config.security.toolReceipts !== false 默认开启
export function toolReceiptsEnabled() {
  return config.security?.toolReceipts !== false
}

export function sha256Hex(text) {
  return createHash('sha256').update(String(text || '')).digest('hex')
}

// 回执的 canonical 签名串（字段顺序固定，验签与生成必须一致）
function canonicalString(r) {
  return [
    r.version || RECEIPT_VERSION,
    r.id,
    r.tool,
    r.timestamp,
    r.status,
    r.risk,
    r.source,
    r.args_hash,
    r.result_hash,
    r.summary,
  ].join('|')
}

/**
 * 生成一份工具回执。
 * @param {object} payload { id, tool, timestamp, status, risk, source, summary, argsHash, resultHash }
 * @returns {{ version, id, tool, timestamp, status, risk, source, args_hash, result_hash, summary, sig }}
 */
export function createToolReceipt(payload = {}) {
  // 兼容两种入参风格：构造时传 camelCase（argsHash），验签时传回执对象本身（args_hash）
  const receipt = {
    version: RECEIPT_VERSION,
    id: Number(payload.id) || 0,
    tool: String(payload.tool || ''),
    timestamp: String(payload.timestamp || ''),
    status: String(payload.status || 'ok'),
    risk: String(payload.risk || 'medium'),
    source: String(payload.source || ''),
    args_hash: String(payload.argsHash || payload.args_hash || ''),
    result_hash: String(payload.resultHash || payload.result_hash || ''),
    summary: String(payload.summary || '').slice(0, 300),
  }
  const hmac = createHmac('sha256', getReceiptSecret())
  hmac.update(canonicalString(receipt))
  receipt.sig = hmac.digest('hex')
  return receipt
}

/**
 * 校验回执签名是否与本地密钥匹配。
 * @param {object} receipt 回执对象（含 sig）
 * @returns {{ valid: boolean, reason?: string }}
 */
export function verifyToolReceipt(receipt = {}) {
  if (!receipt || typeof receipt !== 'object') return { valid: false, reason: 'receipt 不是对象' }
  const sig = String(receipt.sig || '')
  if (!sig) return { valid: false, reason: '缺少 sig' }
  const expected = createToolReceipt(receipt)
  if (expected.sig !== sig) return { valid: false, reason: '签名不匹配（记录可能被篡改或来自不同密钥）' }
  return { valid: true }
}

// 用 HMAC 常量时间比较做二次防护（结果与字符串比较一致，语义更明确）
export function verifyToolReceiptSafe(receipt = {}) {
  const sig = String(receipt?.sig || '')
  if (!sig) return { valid: false, reason: '缺少 sig' }
  try {
    const expected = createToolReceipt(receipt)
    const a = Buffer.from(expected.sig, 'hex')
    const b = Buffer.from(sig, 'hex')
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { valid: false, reason: '签名不匹配（记录可能被篡改或来自不同密钥）' }
    }
    return { valid: true }
  } catch (err) {
    return { valid: false, reason: err?.message || '验签异常' }
  }
}

// 从一条 action_logs 行生成回执（args_hash/result_hash 取自该行已脱敏/截断的存储值）
export function buildReceiptForLogRow(row) {
  if (!row || !row.id) return null
  return createToolReceipt({
    id: row.id,
    tool: row.tool,
    timestamp: row.timestamp,
    status: row.status,
    risk: row.risk,
    source: row.source,
    summary: row.summary,
    argsHash: sha256Hex(row.args_json || '{}'),
    resultHash: sha256Hex(String(row.result_preview || '') + '|' + String(row.error || '')),
  })
}

export const __internals = { canonicalString, SECRET_FILE, RECEIPT_VERSION }
