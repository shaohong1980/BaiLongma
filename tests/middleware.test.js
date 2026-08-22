// 外部协议统一入站中间件单测
import { describe, it, expect, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { readJsonBody, validateSchema, verifyBearer, isDuplicateEvent, clearIdempotencyCache } from '../src/social/middleware.js'

function mockReq(body, { headers = {} } = {}) {
  const req = new EventEmitter()
  req.headers = { 'content-length': Buffer.byteLength(body), ...headers }
  // readBody 用 req.on('data'/'end')，这里异步推送
  setImmediate(() => { req.emit('data', Buffer.from(body)); req.emit('end') })
  return req
}
function mockRes() {
  let status = 200
  let body = null
  return {
    writeHead(code) { status = code },
    end(b) { body = b },
    get status() { return status },
    get body() { return body ? JSON.parse(body) : null },
  }
}

describe('validateSchema', () => {
  it('通过合法对象', () => {
    expect(validateSchema({ a: 'x', n: 1 }, { required: { a: 'string', n: 'number' } })).toBeNull()
  })
  it('缺失必填字段', () => {
    expect(validateSchema({ a: 'x' }, { required: { b: 'string' } })).toContain("missing required field 'b'")
  })
  it('字段类型不符', () => {
    expect(validateSchema({ a: 1 }, { required: { a: 'string' } })).toContain("must be string")
    expect(validateSchema({ a: 'x' }, { required: { a: 'object' } })).toContain("must be object")
  })
  it('非对象拒绝', () => {
    expect(validateSchema(null, {})).toBe('expected object')
  })
})

describe('verifyBearer', () => {
  it('匹配 / 不匹配 / 缺失', () => {
    expect(verifyBearer({ headers: { authorization: 'Bearer abc' } }, 'abc')).toBe(true)
    expect(verifyBearer({ headers: { authorization: 'Bearer abc' } }, 'xyz')).toBe(false)
    expect(verifyBearer({ headers: {} }, 'abc')).toBe(false)
    expect(verifyBearer({ headers: { authorization: 'Bearer abc' } }, '')).toBe(false)
  })
})

describe('readJsonBody', () => {
  it('解析合法 JSON', async () => {
    const res = mockRes()
    const body = await readJsonBody(mockReq('{"a":1}'), res)
    expect(body).toEqual({ a: 1 })
  })
  it('无效 JSON 返回 400 并返回 null', async () => {
    const res = mockRes()
    const body = await readJsonBody(mockReq('{not json'), res)
    expect(body).toBeNull()
    expect(res.status).toBe(400)
  })
  it('content-length 超限返回 413', async () => {
    const res = mockRes()
    const body = await readJsonBody(mockReq('{"a":1}', { headers: { 'content-length': 999999 } }), res, { maxBytes: 10 })
    expect(body).toBeNull()
    expect(res.status).toBe(413)
  })
  it('schema 校验失败返回 400', async () => {
    const res = mockRes()
    const body = await readJsonBody(mockReq('{"a":"x"}'), res, { schema: { required: { b: 'string' } } })
    expect(body).toBeNull()
    expect(res.status).toBe(400)
  })
})

describe('isDuplicateEvent 幂等去重', () => {
  beforeEach(() => clearIdempotencyCache())
  it('首次 false，再次 true', () => {
    expect(isDuplicateEvent('msg:1')).toBe(false)
    expect(isDuplicateEvent('msg:1')).toBe(true)
  })
  it('不同 key 互不影响', () => {
    isDuplicateEvent('msg:1')
    expect(isDuplicateEvent('msg:2')).toBe(false)
  })
  it('空 key 恒为 false', () => {
    expect(isDuplicateEvent('')).toBe(false)
    expect(isDuplicateEvent(null)).toBe(false)
  })
})
