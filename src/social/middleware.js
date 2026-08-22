// middleware.js —— 外部协议统一入站中间件（P2-19 第一步）
//
// 所有 HTTP 入站（social webhook / 未来 A2A / MCP 等）统一在此收口：
//   1) payload 大小限制（content-length 预检 + 流式读取上限）
//   2) JSON 解析 + 极简 schema 校验
//   3) Authorization: Bearer 校验
//   4) 幂等去重（按事件 id / message_id 缓存最近处理过的 key，防 webhook 重试导致重复入站）
//
// 用法：路由里先 `const body = await readJsonBody(req, res, {...})`，null 即已写好错误响应；
//       入站前 `if (isDuplicateEvent(msgId)) return jsonResponse(res, 200, { ok: true, deduped: true })`。
import { jsonResponse, readBody } from './http.js'

const DEFAULT_MAX_BYTES = 1024 * 1024

// 读取并解析 JSON body（带大小上限 + 可选 schema 校验）。失败返回 null（res 已写好错误响应）。
export async function readJsonBody(req, res, { maxBytes = DEFAULT_MAX_BYTES, schema = null, label = 'request' } = {}) {
  // content-length 预检：避免读完整个 body 才拒绝
  const contentLength = Number(req.headers['content-length'] || 0)
  if (contentLength > maxBytes) {
    jsonResponse(res, 413, { ok: false, error: `${label} body too large` })
    return null
  }
  let raw
  try {
    raw = await readBody(req, maxBytes)
  } catch (e) {
    jsonResponse(res, 413, { ok: false, error: `${label} body too large` })
    return null
  }
  let body
  try {
    body = JSON.parse(raw.toString('utf-8') || '{}')
  } catch {
    jsonResponse(res, 400, { ok: false, error: `invalid ${label} json` })
    return null
  }
  if (schema) {
    const err = validateSchema(body, schema)
    if (err) {
      jsonResponse(res, 400, { ok: false, error: `invalid ${label} payload: ${err}` })
      return null
    }
  }
  return body
}

// 极简 JSON schema 校验：{ required: { field: 'string'|'number'|'boolean'|'object' } }
// 够覆盖 webhook/A2A 的基础契约；复杂 schema 后续可按协议换成 zod/ajv。
export function validateSchema(obj, schema) {
  if (typeof obj !== 'object' || obj === null) return 'expected object'
  for (const [key, type] of Object.entries(schema?.required || {})) {
    if (obj[key] === undefined) return `missing required field '${key}'`
    if (type === 'string' && typeof obj[key] !== 'string') return `field '${key}' must be string`
    if (type === 'number' && typeof obj[key] !== 'number') return `field '${key}' must be number`
    if (type === 'boolean' && typeof obj[key] !== 'boolean') return `field '${key}' must be boolean`
    if (type === 'object' && (typeof obj[key] !== 'object' || obj[key] === null)) return `field '${key}' must be object`
  }
  return null
}

// Authorization: Bearer <token> 校验（timing-safe 不可行，token 为自定义值，直接 === 即可）
export function verifyBearer(req, expected) {
  if (!expected) return false
  const token = String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '').trim()
  return token.length > 0 && token === expected
}

// ── 幂等去重 ─────────────────────────────────────────────────────────────────
// 按事件 id（如飞书 message_id、企业微信 msgid）缓存最近处理过的 key，防 webhook 重试重复入站。
const idempotencyCache = new Map()
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000
const IDEMPOTENCY_MAX_ENTRIES = 5000

export function isDuplicateEvent(key) {
  if (!key) return false
  const now = Date.now()
  const prev = idempotencyCache.get(key)
  if (prev && now - prev < IDEMPOTENCY_TTL_MS) return true
  idempotencyCache.set(key, now)
  if (idempotencyCache.size > IDEMPOTENCY_MAX_ENTRIES) {
    for (const [k, ts] of idempotencyCache) {
      if (now - ts > IDEMPOTENCY_TTL_MS) idempotencyCache.delete(k)
    }
  }
  return false
}

// 清空幂等缓存（供测试/运维）
export function clearIdempotencyCache() {
  idempotencyCache.clear()
}
