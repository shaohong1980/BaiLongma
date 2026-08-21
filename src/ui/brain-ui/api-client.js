// api-client.js —— 前端 API 基址 + LAN 鉴权 token 处理
//
// - API：页面经 http(s) 提供时取 location.origin（端口随后端实际端口），
//   否则回退 localhost:3721（file:// 场景）。
// - token：局域网访问时，后端要求 BAILONGMA_API_TOKEN。前端从 URL `?token=` 读取
//   并缓存到 localStorage，之后所有同源 fetch 自动带 Authorization: Bearer。
//   打开方式：http://<本机IP>:3721/?token=<token>
const TOKEN_KEY = 'bailongma_api_token'

function readTokenFromUrl() {
  try {
    const t = new URLSearchParams(window.location.search).get('token')
    if (t) { try { localStorage.setItem(TOKEN_KEY, t) } catch (e) { console.warn('[src/ui/brain-ui/api-client.js] op failed:', e?.message || e) } return t }
  } catch (e) { console.warn('[src/ui/brain-ui/api-client.js] op failed:', e?.message || e) }
  try { return localStorage.getItem(TOKEN_KEY) || '' } catch { return '' }
}

const _token = readTokenFromUrl()

export const API = /^https?:$/.test(window.location?.protocol || "")
  ? window.location.origin
  : "http://localhost:3721";

export function apiUrl(path) {
  return `${API}${path}`;
}

// 当前 token（供 EventSource/WebSocket 等无法设 header 的场景用）
export function getToken() {
  return _token
}

// EventSource 不支持自定义 header，用 ?token= 携带
export function apiSseUrl(path) {
  const base = apiUrl(path)
  return _token ? `${base}${base.includes('?') ? '&' : '?'}token=${encodeURIComponent(_token)}` : base
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
