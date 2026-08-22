// web 工具共享底层：SSRF 防护（assertSsrSafeUrl / normalizeWebUrl）
// DNS 解析依赖用 vi.mock('dns/promises') 隔离，测试不依赖真实网络。
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('dns/promises', () => ({
  default: {
    lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
  },
}))

import { assertSsrSafeUrl, normalizeWebUrl } from '../src/capabilities/tools/web/util.js'

describe('normalizeWebUrl', () => {
  it('补全缺失协议', () => {
    expect(normalizeWebUrl('example.com')).toBe('https://example.com')
    expect(normalizeWebUrl('http://example.com')).toBe('http://example.com')
  })
  it('协议相对 URL 按 https 处理', () => {
    expect(normalizeWebUrl('//example.com/x')).toBe('https://example.com/x')
  })
  it('非 http(s) scheme 原样返回（交给 SSRF 拒绝）', () => {
    expect(normalizeWebUrl('file:///etc/passwd')).toBe('file:///etc/passwd')
    expect(normalizeWebUrl('javascript:alert(1)')).toBe('javascript:alert(1)')
  })
  it('空串返回空', () => {
    expect(normalizeWebUrl('')).toBe('')
  })
})

describe('assertSsrSafeUrl 拒绝内网/敏感地址', () => {
  const blocked = [
    'http://127.0.0.1:3721/admin',
    'http://localhost/',
    'http://10.0.0.1/',
    'http://192.168.1.1/',
    'http://172.16.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/',
    'http://[::1]/',
    'http://[fe80::1]/',
    'http://0.0.0.0/',
    'http://metadata.google.internal/',
    'http://foo.local/',
    'http://foo.internal/',
    'file:///etc/passwd',
    'ftp://example.com/',
    'javascript:alert(1)',
  ]
  it.each(blocked)('拒绝 %s', async (url) => {
    const r = await assertSsrSafeUrl(url)
    expect(r.ok).toBe(false)
  })
})

describe('assertSsrSafeUrl 放行公网', () => {
  it('放行公网 IP / 域名', async () => {
    expect((await assertSsrSafeUrl('http://93.184.216.34/')).ok).toBe(true)
    // 域名走 mock 的 dns.lookup → 93.184.216.34
    expect((await assertSsrSafeUrl('https://example.com')).ok).toBe(true)
  })
  it('域名解析出内网地址时拒绝', async () => {
    const dnsMock = (await import('dns/promises')).default.lookup
    dnsMock.mockImplementation(async () => [{ address: '127.0.0.1', family: 4 }])
    const r = await assertSsrSafeUrl('https://evil.example.com/')
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('blocked address')
  })
  it('缺少 url 时拒绝', async () => {
    const r = await assertSsrSafeUrl('')
    expect(r.ok).toBe(false)
  })
  it('DNS 解析失败时放行交给下游报错（resolve_error 标记）', async () => {
    const dnsMock = (await import('dns/promises')).default.lookup
    const notFound = new Error('getaddrinfo ENOTFOUND')
    notFound.code = 'ENOTFOUND'
    dnsMock.mockImplementation(async () => { throw notFound })
    const r = await assertSsrSafeUrl('https://no-such-host.invalid/')
    expect(r.ok).toBe(true)
    expect(r.resolve_error).toBe('ENOTFOUND')
  })
})
