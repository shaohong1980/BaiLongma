// api-client.js —— 前端 API 基址 + LAN 鉴权 token 处理
//
// - API：页面经 http(s) 提供时取 location.origin（端口随后端实际端口），
//   否则回退 localhost:3721（file:// 场景）。
// - token：局域网访问时，后端要求 BAILONGMA_API_TOKEN。前端从 URL `?token=` 读取
//   并缓存到 localStorage，之后所有同源 fetch 自动带 Authorization: Bearer。
//   注意：token 只从 URL 一次性读取（兼容旧书签/入口链接），但不会再回写进 URL；
//   SSE 用 fetch 流带 Authorization 头，WebSocket 用 subprotocol 传 token。
//   打开方式：http://<本机IP>:3721/?token=<token>（前端读取后即丢弃查询参数）
const TOKEN_KEY = 'bailongma_api_token'

function readTokenFromUrl() {
  let t = ''
  try {
    t = new URLSearchParams(window.location.search).get('token') || ''
    // 读取后立即从地址栏剥离 token，避免停留在 URL 上被书签/历史/代理留存
    if (t && typeof window.history === 'object' && window.history.replaceState) {
      const u = new URL(window.location.href)
      u.searchParams.delete('token')
      try { window.history.replaceState({}, '', u.toString()) } catch (e) { console.warn('[src/ui/brain-ui/api-client.js] op failed:', e?.message || e) }
    }
  } catch (e) { console.warn('[src/ui/brain-ui/api-client.js] op failed:', e?.message || e) }
  if (t) { try { localStorage.setItem(TOKEN_KEY, t) } catch (e) { console.warn('[src/ui/brain-ui/api-client.js] op failed:', e?.message || e) } return t }
  try { return localStorage.getItem(TOKEN_KEY) || '' } catch { return '' }
}

const _token = readTokenFromUrl()

export const API = /^https?:$/.test(window.location?.protocol || "")
  ? window.location.origin
  : "http://localhost:3721";

export function apiUrl(path) {
  return `${API}${path}`;
}

// 当前 token（供 WebSocket subprotocol 等无法设 header 的场景用）
export function getToken() {
  return _token
}

// WebSocket subprotocol 传 token（后端 websocket-security 支持 bailongma.auth.<base64url>）
export function wsSubprotocol() {
  if (!_token) return undefined
  try {
    return `bailongma.auth.${btoa(_token).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
  } catch { return undefined }
}

// 基于 fetch 的 SSE 订阅：EventSource 不支持自定义 header，无法带 Bearer token，
// 改为 fetch + ReadableStream 解析。回调风格对齐 EventSource：
//   onopen()  连接建立（收到响应头）
//   onmessage(dataStr)  每条 data: 事件的原始字符串
//   onerror() 连接失败/中断（不含主动 close()）
// 返回 { close() }；close 后不会再触发 onerror/重连逻辑。
export function subscribeEvents(path, handlers = {}) {
  const { onopen, onmessage, onerror } = handlers
  let controller = null
  let closed = false

  const connect = async () => {
    if (closed) return
    try {
      const headers = {}
      if (_token) headers['Authorization'] = `Bearer ${_token}`
      controller = new AbortController()
      const res = await fetch(apiUrl(path), { headers, signal: controller.signal })
      if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`)
      onopen && onopen()
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
        let idx
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const dataLines = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, ''))
          if (dataLines.length && onmessage) {
            try { onmessage(dataLines.join('\n')) } catch (e) { console.warn('[api-client] sse handler error:', e?.message || e) }
          }
        }
      }
    } catch (err) {
      if (closed) return
      if (err?.name === 'AbortError') return
    }
    if (closed) return
    // 流结束（服务端关闭/断线）→ 交回调用方触发重连
    onerror && onerror()
  }

  connect()
  return {
    close() {
      closed = true
      try { controller && controller.abort() } catch (e) { console.warn('[api-client] sse abort failed:', e?.message || e) }
    },
  }
}

// 同源/API 请求自动带 Authorization: Bearer（覆盖散落在各文件的 fetch(API+...)）
if (_token && typeof window !== 'undefined' && typeof window.fetch === 'function') {
  const _origFetch = window.fetch.bind(window)
  window.fetch = (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input && input.url) || ''
    const isApi =
      url.startsWith('/') ||
      url.startsWith(API) ||
      url.startsWith(window.location.origin) ||
      /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)
    if (isApi) {
      const headers = new Headers(init.headers || {})
      if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${_token}`)
      init = { ...init, headers }
    }
    return _origFetch(input, init)
  }
}
