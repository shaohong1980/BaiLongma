// 自测：state-graph.js（学 LangGraph 的状态图引擎）
//  1) 菱形并行 fan-in + reducer
//  2) 条件循环（评审→返工→再评审）
//  3) 人工审批 interrupt + resume
//  4) 断点续跑（checkpoint 落盘）
// 纯 Node，无网络/无 LLM。运行：node src/test-state-graph.js
import fs from 'fs'
import os from 'os'
import path from 'path'
import { StateGraph } from './multi-agent/state-graph.js'

let pass = 0, fail = 0
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✔ ' + msg) }
  else { fail++; console.log('  ✘ ' + msg) }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-'))

async function testDiamond() {
  console.log('[1] 菱形并行 fan-in + reducer')
  const g = new StateGraph({ checkpointDir: tmpDir })
  g.addNode('planner', async () => ({ task: 'x', audit: ['[planner]'] }))
  g.addNode('branch_a', async (s) => ({ audit: ['[A]' + s.task] }))
  g.addNode('branch_b', async (s) => ({ audit: ['[B]' + s.task] }))
  g.addNode('join', async (s) => ({ merged: s.audit.join('|') }))
  g.addReducer('audit', 'add')
  g.setEntry('planner')
  g.addEdge('planner', 'branch_a')
  g.addEdge('planner', 'branch_b')
  g.addEdge('branch_a', 'join')
  g.addEdge('branch_b', 'join')
  const app = g.compile()
  const r = await app.invoke({})
  const audit = r.audit.filter(a => a.node !== '__start')
  ok(!r.interrupted, '执行完成未中断')
  ok(audit.some(a => a.node === 'planner') && audit.some(a => a.node === 'branch_a') && audit.some(a => a.node === 'branch_b') && audit.some(a => a.node === 'join'), '经过 planner→branch_a/b→join')
  ok(r.state.merged === '[planner]|[A]x|[B]x', 'fan-in reducer 合并 audit 正确 => ' + r.state.merged)
}

async function testLoop() {
  console.log('[2] 条件循环（评审→返工→再评审，最多2轮）')
  const g = new StateGraph({ checkpointDir: tmpDir })
  g.addNode('exec', async () => ({ attempt: 1, quality: 'bad' }))
  g.addNode('review', async (s) => ({ passed: s.quality === 'good', attempts: s.attempt }))
  g.addNode('rework', async (s) => ({ attempt: s.attempt + 1, quality: s.attempt >= 2 ? 'good' : 'bad' }))
  g.addNode('end', async (s) => ({ finalAttempts: s.attempts }))
  g.setEntry('exec')
  g.addEdge('exec', 'review')
  g.addConditionalEdge('review', s => s.passed ? 'end' : 'rework', { end: 'end', rework: 'rework' })
  g.addEdge('rework', 'review')
  const app = g.compile()
  const r = await app.invoke({})
  const reviewRuns = r.audit.filter(a => a.node === 'review').length
  ok(r.state.passed === true, '最终通过')
  ok(reviewRuns >= 2, 'review 至少跑了2轮（循环生效）=> ' + reviewRuns)
  ok(r.state.finalAttempts >= 2, '记录最终尝试次数 => ' + r.state.finalAttempts)
}

async function testApproval() {
  console.log('[3] 人工审批 interrupt + resume（同意）')
  const g = new StateGraph({ checkpointDir: tmpDir })
  g.addNode('draft', async () => ({ draft: '方案草稿' }))
  g.addNode('publish', async (s) => ({ published: '已发布:' + s.draft }))
  g.addApproval('publish')
  g.setEntry('draft')
  g.addEdge('draft', 'publish')
  const app = g.compile()
  const tid = 'approval-test-' + Date.now()
  const r1 = await app.invoke({}, { threadId: tid })
  ok(r1.interrupted === true, '在 publish 前暂停等待审批 => waiting=' + r1.waitingNode)
  ok(!r1.state.published, '审批前未执行 publish')
  const r2 = await app.resume(tid, { approved: true, note: '同意' })
  ok(r2.resumed === true, 'resume 后继续执行')
  ok(r2.state.published === '已发布:方案草稿', '审批通过后 publish 执行 => ' + r2.state.published)
  const r3 = await app.resume(tid, { approved: false })
  ok(r3.rejected === true || !r3.resumed, '已完成后再次 resume 不再重跑')
}

async function testReject() {
  console.log('[4] 人工审批 驳回（拒绝）')
  const g = new StateGraph({ checkpointDir: tmpDir })
  g.addNode('draft', async () => ({ draft: '方案' }))
  g.addNode('publish', async (_s) => ({ published: 'yes' }))
  g.addApproval('publish')
  g.setEntry('draft')
  g.addEdge('draft', 'publish')
  const app = g.compile()
  const tid = 'reject-test-' + Date.now()
  const r1 = await app.invoke({}, { threadId: tid })
  ok(r1.interrupted === true, '暂停等待')
  const r2 = await app.resume(tid, { approved: false, note: '需修改' })
  ok(r2.rejected === true, '驳回后不执行 publish，状态保留')
  ok(!r2.state.published, '未发布')
}

async function testCheckpoint() {
  console.log('[5] checkpoint 落盘（断点续跑）')
  const g = new StateGraph({ checkpointDir: tmpDir })
  g.addNode('n1', async () => ({ a: 1 }))
  g.addNode('n2', async (s) => ({ b: s.a + 1 }))
  g.setEntry('n1')
  g.addEdge('n1', 'n2')
  const app = g.compile()
  const tid = 'cp-test-' + Date.now()
  await app.invoke({}, { threadId: tid })
  const st = app.getState(tid)
  ok(st && st.state.b === 2, 'checkpoint 状态可读 => b=' + (st && st.state.b))
  const file = path.join(tmpDir, tid.replace(/[^\w-]/g, '_') + '.json')
  ok(fs.existsSync(file), 'checkpoint 文件已落盘')
}

async function main() {
  await testDiamond()
  await testLoop()
  await testApproval()
  await testReject()
  await testCheckpoint()
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
  process.exit(fail ? 1 : 0)
}

main()
