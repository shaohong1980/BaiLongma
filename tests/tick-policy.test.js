// 从 src/test-tick-policy.js 迁移到 Vitest（纯逻辑单测）
import { describe, it, expect } from 'vitest'
import {
  buildAutonomousTickDirections,
  buildTaskContinuationDirection,
  buildMemoryNudge,
} from '../src/runtime/tick-policy.js'
import { evaluateToolPolicy } from '../src/capabilities/tool-policy.js'

describe('autonomous Tick policy directions', () => {
  it('ordinary Tick has no forced behavioral default', () => {
    const normal = buildAutonomousTickDirections()
    expect(normal).toContain('no obligation to act, speak, or remain passive')
    expect(normal).toContain('make your own situational judgment')
    expect(normal).toContain('use find_tool')
    expect(normal).toContain('private working text')
    expect(normal).toContain('calling send_message')
    expect(normal).toContain('do not narrate or justify silence')
    expect(normal).toContain('Treat unanswered conversation like a person would')
    expect(normal).toContain('several messages in a row')
  })

  it('ordinary Tick has no fixed time rule or action menu', () => {
    const normal = buildAutonomousTickDirections()
    expect(normal).not.toContain('23:00')
    expect(normal).not.toContain('Things you can proactively do')
  })

  it('ordinary Tick contains no behavioral hard-rule wording', () => {
    const normal = buildAutonomousTickDirections()
    expect(normal).not.toContain('HARD RULE')
    expect(normal).not.toContain('forbidden')
  })

  it('generic tick policy does not own the fixed startup self-check', () => {
    const startup = buildAutonomousTickDirections({ startupSelfCheckActive: true, awakeningTicks: 8 })
    expect(startup).not.toContain('diagnostic goal, not a mandatory checklist')
    expect(startup).toContain('early awakening period')
  })

  it('awakening leaves the outcome to model judgment', () => {
    const awakening = buildAutonomousTickDirections({ awakeningTicks: 3 })
    expect(awakening).toContain('not a prescribed exploration sequence')
    expect(awakening).toContain('exploration, reflection, task work, communication, or silence')
  })

  it('custom ticker status is visible to Tick context', () => {
    const customCadence = buildAutonomousTickDirections({
      tickerStatus: { active: true, seconds: 10, ttl: 7, reason: 'user asked for fast feelings', revision: 3 },
    })
    expect(customCadence).toContain('10s interval, 7 heartbeat(s) remaining')
    expect(customCadence).toContain('not an instruction to speak')
    expect(customCadence).toContain('not an instruction to speak or to confirm the setting')
  })

  it('neutral discovery context can be appended without changing policy', () => {
    const discovery = buildAutonomousTickDirections({ delegationDiscovery: '[available collaborators: Codex]' })
    expect(discovery.endsWith('[available collaborators: Codex]')).toBe(true)
  })
})

describe('autonomous Tick tool policy', () => {
  it('blocks high-risk execution without user authority', () => {
    expect(evaluateToolPolicy('delete_file', { path: 'x' }, { autonomous: true }).allowed).toBe(false)
    expect(evaluateToolPolicy('set_security', {}, { autonomous: true }).allowed).toBe(false)
    expect(evaluateToolPolicy('exec_command', { command: 'Get-ChildItem' }, { autonomous: true }).allowed).toBe(false)
    expect(evaluateToolPolicy('exec_background_command', { command: 'node worker.js' }, { autonomous: true }).allowed).toBe(false)
  })

  it('allows read-only web research and communication during Tick', () => {
    expect(evaluateToolPolicy('web_search', { query: 'news' }, { autonomous: true }).allowed).toBe(true)
    expect(evaluateToolPolicy('send_message', {}, { autonomous: true }).allowed).toBe(true)
  })

  it('blocks silent persistent-rule mutation but allows inspection', () => {
    expect(evaluateToolPolicy('manage_rule', { action: 'list' }, { autonomous: true }).allowed).toBe(true)
    expect(evaluateToolPolicy('manage_rule', { action: 'upsert' }, { autonomous: true }).allowed).toBe(false)
  })

  it('runtime can represent an explicit high-risk autonomy grant', () => {
    expect(evaluateToolPolicy('delete_file', { path: 'x' }, { autonomous: true, allowHighRiskAutonomy: true }).allowed).toBe(true)
  })
})

describe('buildTaskContinuationDirection', () => {
  it('无任务返回空串', () => {
    expect(buildTaskContinuationDirection({})).toBe('')
  })

  it('有下一步待办步骤时引导推进', () => {
    const d = buildTaskContinuationDirection({
      task: 'write report',
      steps: [{ text: 'draft', status: 'done' }, { text: 'review', status: 'pending' }],
    })
    expect(d).toContain('active task in progress')
    expect(d).toContain('1/2 steps done')
    expect(d).toContain('next pending step is: "review"')
  })

  it('全部完成但任务仍活动时引导 complete_task', () => {
    const d = buildTaskContinuationDirection({
      task: 'ship',
      steps: [{ text: 'build', status: 'done' }],
    })
    expect(d).toContain('All steps are already done')
    expect(d).toContain('complete_task')
  })

  it('无步骤时给通用推进指引，且有失败步骤时提示复盘', () => {
    const d = buildTaskContinuationDirection({
      task: 'debug',
      steps: [{ text: 'fix a', status: 'failed' }],
    })
    expect(d).toContain('Push this task forward')
    expect(d).toContain('1 step(s) are marked failed')
  })

  it('空闲多轮时提示不要沉默', () => {
    const d = buildTaskContinuationDirection({ task: 't', steps: [], idleTicks: 5 })
    expect(d).toContain('idle for 5+ heartbeats')
  })
})

describe('buildMemoryNudge', () => {
  it('包含沉淀知识与可静默的软引导', () => {
    const d = buildMemoryNudge()
    expect(d).toContain('Daily reflection moment')
    expect(d).toContain('upsert_memory')
    expect(d).toContain('silence is still a valid outcome')
  })
})
