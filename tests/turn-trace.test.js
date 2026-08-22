// turn-trace 异步队列化落盘单测（P2-15：persist 不再同步阻塞 agent 回合）
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

let tmp
let tt

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-turn-trace-'))
  process.env.BAILONGMA_USER_DIR = tmp
  tt = await import('../src/runtime/turn-trace.js')
})

afterAll(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
})

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

describe('turn-trace 异步落盘', () => {
  it('beginTurn + end 后队列化写入文件且可读回', async () => {
    tt.clearTraces()
    const h = tt.beginTurn({ label: 'vitest-turn', channel: 'TUI' })
    h.recordRound({ round: 1, content: 'first round' })
    h.end({ messages: [{ role: 'user', content: 'hi' }], delivered: true })
    await sleep(150) // 等异步队列 flush

    const traces = tt.getTraces(5)
    expect(traces.some(t => t.meta?.label === 'vitest-turn')).toBe(true)
    expect(fs.existsSync(path.join(tmp, 'data', 'turn-traces.jsonl'))).toBe(true)
  })

  it('end() 同步返回不 await 落盘（不阻塞调用方）', async () => {
    tt.clearTraces()
    const h = tt.beginTurn({ label: 'sync-return' })
    let returned = false
    h.end({ messages: [], delivered: false })
    returned = true // end() 是同步调用，立即返回
    expect(returned).toBe(true)
    await sleep(150)
    expect(tt.getTraces(1)[0]?.meta?.label).toBe('sync-return')
  })

  it('getTrace 按 id 可查', async () => {
    tt.clearTraces()
    const h = tt.beginTurn({ label: 'by-id' })
    h.end({ messages: [], delivered: true })
    await sleep(150)
    const t = tt.getTraces(10)[0]
    expect(tt.getTrace(t.id)?.id).toBe(t.id)
  })
})
