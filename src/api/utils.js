import path from 'path'

// P1-9：日志/错误信息里的密钥脱敏 —— 防止 API key / Bearer token 泄漏到日志、trace、UI 事件。
// 匹配：sk- 开头的 key、Authorization Bearer、JSON 里的 apiKey/api_key/secret/token 字段值。
const SECRET_PATTERNS = [
  // sk- 开头的 key（无上下文）
  { re: /sk-[A-Za-z0-9_-]{8,}/g, replace: '••••' },
  // JSON 字段 "apiKey":"..." → "apiKey":"••••"
  { re: /("(?:api[_-]?key|secret|token|minimax_api_key|DEEPSEEK_API_KEY)"\s*:\s*")[^"]{4,}(")/gi, replace: '$1••••$2' },
  // Authorization: Bearer xxx → Authorization: Bearer ••••
  { re: /(Authorization:\s*Bearer\s+)[A-Za-z0-9._-]+/gi, replace: '$1••••' },
  // apiKey: xxx / api_key = xxx 等非 JSON 形式
  { re: /((?:api[_-]?key|secret|token)\s*[:=]\s*)[A-Za-z0-9._-]{4,}/gi, replace: '$1••••' },
]
export function redactSecrets(value) {
  if (value == null) return value
  const s = String(value)
  if (!/sk-|apiKey|api_key|Bearer|secret|token/i.test(s)) return s
  let out = s
  for (const { re, replace } of SECRET_PATTERNS) {
    out = out.replace(re, replace)
  }
  return out
}

export function jsonResponse(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

export function isPathInside(parentDir, candidatePath) {
  const parent = path.resolve(parentDir)
  const candidate = path.resolve(candidatePath)
  const relative = path.relative(parent, candidate)
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

export function getRequestCharset(contentType = '') {
  const match = String(contentType || '').match(/(?:^|;)\s*charset\s*=\s*"?([^";\s]+)"?/i)
  return match?.[1]?.trim().toLowerCase() || ''
}

export function decodeRequestBody(buffer, contentType = '') {
  if (!buffer || buffer.length === 0) return ''

  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.slice(3).toString('utf8')
  }
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.slice(2).toString('utf16le')
  }
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    try { return new TextDecoder('utf-16be').decode(buffer.slice(2)) } catch (e) { console.warn('[src/api/utils.js] op failed:', e?.message || e) }
  }

  const charset = getRequestCharset(contentType)
  if (charset === 'utf8' || charset === 'utf-8' || charset === '') {
    const decoded = buffer.toString('utf8')
    if (!charset && decoded.includes('\uFFFD')) {
      try {
        const fallback = new TextDecoder('gbk', { fatal: true }).decode(buffer)
        if (fallback && !fallback.includes('\uFFFD')) return fallback
      } catch (e) { console.warn('[src/api/utils.js] op failed:', e?.message || e) }
    }
    return decoded
  }
  if (charset === 'utf16le' || charset === 'utf-16le' || charset === 'ucs-2' || charset === 'utf16') {
    return buffer.toString('utf16le')
  }

  try {
    return new TextDecoder(charset, { fatal: true }).decode(buffer)
  } catch {
    return buffer.toString('utf8')
  }
}

export function readRawBody(req, { maxBytes = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let done = false
    const fail = (err) => {
      if (done) return
      done = true
      reject(err)
    }
    req.on('data', chunk => {
      if (done) return
      size += chunk.length
      if (maxBytes > 0 && size > maxBytes) {
        const err = new Error('request body too large')
        err.statusCode = 413
        fail(err)
        try { req.destroy() } catch (e) { console.warn('[src/api/utils.js] op failed:', e?.message || e) }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (done) return
      done = true
      resolve(Buffer.concat(chunks))
    })
    req.on('error', fail)
  })
}

export async function readJsonBody(req, options = {}) {
  const raw = decodeRequestBody(await readRawBody(req, options), req.headers['content-type'])
  return raw ? JSON.parse(raw) : {}
}

export function safeJsonParse(value, fallback) {
  try { return JSON.parse(value || '') } catch { return fallback }
}

export function parseBooleanish(value, defaultValue = false) {
  if (typeof value === 'boolean') return value
  if (value === undefined || value === null || value === '') return defaultValue
  return /^(1|true|yes|open|show)$/i.test(String(value || ''))
}

export function contentTypeFor(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.html':
    case '.htm':
      return 'text/html; charset=utf-8'
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8'
    case '.css':
      return 'text/css; charset=utf-8'
    case '.json':
      return 'application/json; charset=utf-8'
    case '.svg':
      return 'image/svg+xml'
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    case '.wasm':
      return 'application/wasm'
    case '.riv':
    case '.woff':
    case '.woff2':
    case '.ttf':
      return 'application/octet-stream'
    default:
      return 'text/plain; charset=utf-8'
  }
}
