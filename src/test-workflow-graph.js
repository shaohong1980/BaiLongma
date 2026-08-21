// 自测：workflow.js 状态图集成（学 LangGraph）
// 运行：./blm-run src/test-workflow-graph.js
import { WORKFLOWS, compileFlowToGraph, resumeGraphFlow } from './multi-agent/workflow.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✔ ' + m) } else { fail++; console.log('  ✘ ' + m) } }

async function main() {
  console.log('[1] WORKFLOWS.production 是 graph 流程')
  ok(WORKFLOWS.production && WORKFLOWS.production.graph === true, 'production.graph=true')
  ok(Array.isArray(WORKFLOWS.production.steps) && WORKFLOWS.production.steps.length === 5, '5 个步骤（拆解/并行/评审返工/人工审批/汇总结案）')

  console.log('[2] compileFlowToGraph 结构')
  const g = compileFlowToGraph(WORKFLOWS.production, '测试')
  const app = g.compile()
  ok(app.nodes.includes('step_0') && app.nodes.includes('step_4'), '生成 step_0..step_4')
  ok(app.nodes.length === WORKFLOWS.production.steps.length, '节点数 = 步骤数 => ' + app.nodes.length)

  console.log('[3] 审批/续跑错误路径')
  try {
    await resumeGraphFlow('no-such-thread', { approved: true })
    ok(false, '未知线程应抛错')
  } catch (e) {
    ok(/未知流程线程/.test(String(e.message)), '未知线程抛错 => ' + String(e.message).slice(0, 40))
  }

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
  process.exit(fail ? 1 : 0)
}
main()
