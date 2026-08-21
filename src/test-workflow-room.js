// F1 验证：主工作流引擎的 room 节点端到端（stub executeRoom / executeLLM）
import { createWorkflowEngine } from './workflow/engine.js'
import { validateWorkflow, WORKFLOW_TEMPLATES } from './workflow/schema.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✔ ' + m) } else { fail++; console.log('  ✘ ' + m) } }

const tpl = WORKFLOW_TEMPLATES.room_office

const engine = createWorkflowEngine({
  executeLLM: async ({ prompt }) => ({ content: '[LLM总结] ' + String(prompt).slice(0, 40) }),
  executeRoom: async ({ mode, content }) => {
    if (mode === 'office') return { ok: true, summary: '办公室已执行: ' + content }
    return { ok: false, error: 'unknown' }
  },
})

console.log('[1] schema')
ok(validateWorkflow(tpl).valid, 'room_office 通过校验')
ok(tpl.nodes.some(n => n.type === 'room'), '模板含 room 节点')

console.log('[2] 端到端 run（start → room → llm → end）')
const r = await engine.run(tpl, { input: '统计学生人数' })
ok(r.ok === true, 'run 返回 ok:true')
ok(r.status === 'completed', '状态 completed (实际 ' + r.status + ')')
ok(r.log.some(l => l.node_type === 'room'), 'room 节点执行记录存在')
const roomLog = r.log.find(l => l.node_type === 'room')
ok(roomLog && roomLog.output && String(roomLog.output).includes('办公室已执行'), 'room 节点输出正确 => ' + String(roomLog?.output))
ok(r.log.some(l => l.node_type === 'llm'), '后续 llm 节点执行')

// ── S3：code 节点 allowCode 开关 ──────────────────────────────────────
async function testCodeGate() {
  console.log('[3] code 节点 allowCode 防护')
  const mkFlow = () => ({ id: 'c', name: 'code', nodes: [
    { id: 'start', type: 'start', next: 'c' },
    { id: 'c', type: 'code', config: { code: 'return { executed: true, n: context.input.n + 1 }' }, next: 'end' },
    { id: 'end', type: 'end' },
  ] })
  // 默认禁用
  const noCode = createWorkflowEngine({ executeLLM: async () => ({ content: '' }) })
  const r1 = await noCode.run(mkFlow(), { input: { n: 1 } })
  const c1 = r1.log?.find(l => l.node_type === 'code')
  ok(r1.ok && c1 && c1.metadata?.codeDisabled === true, '默认 code 节点被禁用')
  // 显式开启
  const withCode = createWorkflowEngine({ executeLLM: async () => ({ content: '' }), allowCode: true })
  const r2 = await withCode.run(mkFlow(), { input: { n: 1 } })
  ok(r2.ok && r2.context?.c?.result?.executed === true && r2.context.c.result.n === 2, 'allowCode:true 时 code 节点执行 => ' + JSON.stringify(r2.context?.c?.result))
}
await testCodeGate()

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
