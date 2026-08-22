// 统一后台循环封装（scheduler.every）单测
import { describe, it, expect, vi } from 'vitest'
import { every } from '../src/scheduler.js'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

describe('scheduler.every', () => {
  it('防重叠：上一轮未结束则跳过本轮', async () => {
    let concurrent = 0
    let maxConcurrent = 0
    let runs = 0
    const loop = every(10, async () => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      runs++
      await sleep(40) // 比 interval 长，触发重叠场景
      concurrent--
    }, { name: 'overlap-test', runImmediately: true })
    await sleep(100)
    loop.stop()
    expect(maxConcurrent).toBe(1)
    expect(runs).toBeGreaterThanOrEqual(1)
  })

  it('错误隔离：回调抛错不打断后续轮次', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let runs = 0
    const loop = every(10, () => {
      runs++
      if (runs === 1) throw new Error('boom')
    }, { name: 'err-test', runImmediately: true })
    await sleep(50)
    loop.stop()
    expect(runs).toBeGreaterThanOrEqual(2)
    warnSpy.mockRestore()
  })

  it('stop() 后不再触发', async () => {
    let runs = 0
    const loop = every(10, () => { runs++ }, { name: 'stop-test' })
    await sleep(30)
    loop.stop()
    const afterStop = runs
    await sleep(40)
    expect(runs).toBe(afterStop)
  })

  it('runImmediately 启动即跑首轮', async () => {
    let runs = 0
    const loop = every(1000, () => { runs++ }, { name: 'immediate-test', runImmediately: true })
    await sleep(20)
    loop.stop()
    expect(runs).toBe(1)
  })

  it('非法 interval 抛错', () => {
    expect(() => every(-1, () => {})).toThrow()
    expect(() => every(0, () => {})).toThrow()
  })

  it('delayMs 延迟首轮后启动', async () => {
    let runs = 0
    const loop = every(10, () => { runs++ }, { name: 'delay-test', runImmediately: true, delayMs: 40 })
    await sleep(20)
    expect(runs).toBe(0) // delay 内不应运行
    await sleep(60)
    expect(runs).toBeGreaterThanOrEqual(1) // delay 后首轮 + 后续 interval
    loop.stop()
  })

  it('delayMs 期间 stop() 可取消', async () => {
    let runs = 0
    const loop = every(10, () => { runs++ }, { name: 'delay-cancel-test', runImmediately: true, delayMs: 100 })
    await sleep(20)
    loop.stop()
    await sleep(120)
    expect(runs).toBe(0)
  })
})
