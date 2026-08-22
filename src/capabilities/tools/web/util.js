// web 工具共享底层：HTTP 头、URL/HTML 处理、长文落盘
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import dns from 'dns/promises'
import net from 'net'
import { SANDBOX_ROOT } from '../../sandbox.js'

export const WEB_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
}

export function webJson(payload) {
  return JSON.stringify(payload)
}

export function normalizeWebUrl(raw) {
  const value = String(raw || '').trim()
  if (!value) return ''
  if (/^https?:\/\//i.test(value)) return value
  // 协议相对：//host/path → https://host/path
  if (/^\/\//.test(value)) return `https:${value}`
  // 显式带其他 scheme（file:/javascript:/data:/ftp: 等）：原样返回，
  // 由 SSRF 校验拒绝；不要前缀成 https://xxx 导致 scheme 被吞掉而漏判。
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value
  return `https://${value}`
}

// ── SSRF 防护 ────────────────────────────────────────────────────────────────
// fetch_url / browser_read / browser_act 会把 LLM 提供的 URL 交给本地 HTTP 客户端
// 或真实浏览器去取。若目标指向 loopback / 私网 / 链路本地 / 云 metadata，就可能被
// 诱导读取本机后端、管理面、内网设备或云实例元数据。这里统一在发起请求前校验：
//   1) 协议白名单（仅 http/https）
//   2) 主机名黑名单（localhost / *.local / *.internal / metadata 等）
//   3) 直接给出的 IP 按段拦截
//   4) 域名先解析 DNS，解析出的任一 IP 落在拦截段即拒绝
// 注：仍有 DNS rebinding 理论残留（校验与连接之间 DNS 可能变化），redirect 跳转在
// fetch.js 里逐跳复检；更严格可改为固定解析后的 IP 连接，暂不引入。

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata',
  'metadata.google.internal',
  'metadata.internal',
])

const BLOCKED_HOSTNAME_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.lan',
  '.home',
  '.localdomain',
]

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0
}

const BLOCKED_IPV4_RANGES = [
  [0x00000000, 0x00ffffff],  // 0.0.0.0/8（本网络）
  [0x0a000000, 0x0affffff],  // 10.0.0.0/8（私网）
  [0x64400000, 0x647fffff],  // 100.64.0.0/10（CGNAT）
  [0x7f000000, 0x7fffffff],  // 127.0.0.0/8（loopback）
  [0xa9fe0000, 0xa9feffff],  // 169.254.0.0/16（link-local，含云 metadata 169.254.169.254）
  [0xac100000, 0xac1fffff],  // 172.16.0.0/12（私网）
  [0xc0000000, 0xc00000ff],  // 192.0.0.0/24（IETF 保留）
  [0xc0000200, 0xc00002ff],  // 192.0.2.0/24（TEST-NET-1）
  [0xc0a80000, 0xc0a8ffff],  // 192.168.0.0/16（私网）
  [0xc6120000, 0xc613ffff],  // 198.18.0.0/15（benchmark）
  [0xc6336400, 0xc63364ff],  // 198.51.100.0/24（TEST-NET-2）
  [0xcb007100, 0xcb0071ff],  // 203.0.113.0/24（TEST-NET-3）
  [0xe0000000, 0xffffffff],  // 224.0.0.0/4 组播 + 240.0.0.0/4 保留
]

function isBlockedIpv4(ip) {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const int = ipv4ToInt(ip)
  return BLOCKED_IPV4_RANGES.some(([lo, hi]) => int >= lo && int <= hi)
}

function isBlockedIpv6(ip) {
  const lower = String(ip || '').toLowerCase()
  // IPv4-mapped（::ffff:a.b.c.d / ::a.b.c.d）：校验内嵌的 IPv4
  const m = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/) || lower.match(/^::(\d+\.\d+\.\d+\.\d+)$/)
  if (m) return isBlockedIpv4(m[1])
  if (lower === '::' || lower === '::1') return true          // 未指定 / loopback
  if (/^fc[0-9a-f]/i.test(lower) || /^fd[0-9a-f]/i.test(lower)) return true   // fc00::/7 ULA
  if (/^fe[89ab][0-9a-f]/i.test(lower)) return true            // fe80::/10 link-local
  if (lower.startsWith('2001:db8')) return true                // 文档段
  if (lower.startsWith('100:')) return true                    // 100::/64 discard-only
  return false
}

function isBlockedIp(ip) {
  if (net.isIP(ip) === 4) return isBlockedIpv4(ip)
  if (net.isIP(ip) === 6) return isBlockedIpv6(ip)
  return true // 解析不出 IP 格式，按不安全处理
}

function isBlockedHostname(hostname) {
  const h = String(hostname || '').trim().toLowerCase().replace(/\.$/, '')
  if (!h) return true
  if (BLOCKED_HOSTNAMES.has(h)) return true
  return BLOCKED_HOSTNAME_SUFFIXES.some(sfx => h.endsWith(sfx))
}

// 校验 URL 是否允许发起请求。返回 { ok: true, url } 或 { ok: false, reason, url }。
// 异步：域名会做一次 DNS 解析并检查全部结果。
export async function assertSsrSafeUrl(rawUrl) {
  const raw = String(rawUrl || '').trim()
  if (!raw) return { ok: false, reason: 'missing url', url: '' }
  // 原始输入显式带 scheme 的：只放行 http/https（file:/javascript:/data:/ftp: 等一律拒绝）
  const schemeMatch = raw.match(/^([a-z][a-z0-9+.-]*):/i)
  if (schemeMatch && !/^https?$/i.test(schemeMatch[1])) {
    return { ok: false, reason: `unsupported protocol ${schemeMatch[1].toLowerCase()}`, url: raw }
  }
  const normalized = normalizeWebUrl(raw)
  if (!normalized) return { ok: false, reason: 'missing url', url: raw }
  let parsed
  try {
    parsed = new URL(normalized)
  } catch {
    return { ok: false, reason: 'invalid url', url: normalized }
  }
  // URL.hostname 对 IPv6 字面量带方括号（[::1]），net.isIP 识别不了，先去括号
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '')

  // 直接给 IP 的：按段拦截
  if (net.isIP(hostname)) {
    return isBlockedIp(hostname)
      ? { ok: false, reason: `blocked address ${hostname}`, url: normalized }
      : { ok: true, url: normalized }
  }

  // 主机名：先查黑名单，再解析 DNS 校验所有解析结果
  if (isBlockedHostname(hostname)) {
    return { ok: false, reason: `blocked hostname ${hostname}`, url: normalized }
  }
  try {
    const addrs = await dns.lookup(hostname, { all: true, verbatim: true })
    for (const a of addrs) {
      if (isBlockedIp(a.address)) {
        return { ok: false, reason: `resolved to blocked address ${a.address} (${hostname})`, url: normalized }
      }
    }
  } catch (err) {
    // DNS 解析失败：交给下游 fetch 报真实错误，这里不拦（resolve_error 仅供日志/调试）
    return { ok: true, url: normalized, resolve_error: err?.code || 'dns_error' }
  }
  return { ok: true, url: normalized }
}

export function decodeHtmlEntities(value = '') {
  return String(value)
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

export function htmlToText(html = '') {
  return decodeHtmlEntities(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function extractTitle(html = '') {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return match ? htmlToText(match[1]).slice(0, 200) : ''
}

export function isLowValuePageText(text = '') {
  const compact = String(text || '').replace(/\s+/g, ' ').trim()
  if (compact.length < 80) return true
  return /^(please wait|just a moment|checking your browser|enable javascript|access denied|forbidden|captcha|安全验证|请稍候|请稍等|正在验证|访问受限)/i.test(compact)
}

// 长文阈值：抓取结果超过此长度时落盘，识别器只看摘要 + body_path
export const ARTICLE_LENGTH_THRESHOLD = 2000
export const ARTICLE_SUMMARY_EXCERPT = 800

function urlHash8(url) {
  return crypto.createHash('sha1').update(String(url || '')).digest('hex').slice(0, 8)
}

function sanitizeSlugPart(value, max = 40) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, max)
}

// 把长文写入 sandbox/articles/{YYYY-MM}/{date}_{titleSlug}_{hash8}.md
// 同 URL 当天再次抓取直接复用已有文件，避免重复落盘
export function saveLongArticle({ url, finalUrl, title, body, source }) {
  const now = new Date()
  const yyyyMm = now.toISOString().slice(0, 7)
  const date = now.toISOString().slice(0, 10)
  const hash = urlHash8(finalUrl || url || '')
  const titleSlug = sanitizeSlugPart(title)
  const baseName = titleSlug ? `${date}_${titleSlug}_${hash}.md` : `${date}_${hash}.md`

  const monthDir = path.join(SANDBOX_ROOT, 'articles', yyyyMm)
  const absPath = path.join(monthDir, baseName)
  const relPath = path.posix.join('articles', yyyyMm, baseName)

  if (fs.existsSync(absPath)) {
    return { path: relPath, bytes: fs.statSync(absPath).size, reused: true }
  }

  fs.mkdirSync(monthDir, { recursive: true })
  const frontmatter = [
    '---',
    `title: ${JSON.stringify(title || '')}`,
    `source_url: ${url || ''}`,
    finalUrl && finalUrl !== url ? `final_url: ${finalUrl}` : null,
    `source_tool: ${source || 'fetch_url'}`,
    `fetched_at: ${now.toISOString()}`,
    '---',
    '',
  ].filter(Boolean).join('\n')
  const content = frontmatter + (title ? `# ${title}\n\n` : '') + body
  fs.writeFileSync(absPath, content, 'utf-8')
  return { path: relPath, bytes: Buffer.byteLength(content, 'utf-8'), reused: false }
}
