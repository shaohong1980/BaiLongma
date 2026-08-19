// 多Agent办公室控制工具：让主 Agent 能通过对话/语音调动办公室
//   open/close 打开关闭面板；edict 派活走 CEO 拆解→分派→执行→汇总；ask 指派/提问；status 看板；task_control/review 干预。
import { emitEvent } from '../events.js'
import { runEdictTask, listTasks, controlTask, reviewTask } from './task-flow.js'
import { bossSpeak, assignTask } from './room.js'
import { getAgentConfig } from './config.js'
import { runFlow, WORKFLOWS } from './workflow.js'
import { discoverAgent } from './config.js'

function toolJson(obj) { return JSON.stringify(obj, null, 2) }

export async function execJunjichu(args = {}) {
  const action = String(args.action || '').trim().toLowerCase()
  const content = String(args.content || args.task || args.edict || args.prompt || '').trim()

  // 打开/关闭面板
  if (action === 'open' || action === 'show' || action === 'launch') {
    emitEvent('junjichu_mode', { active: true, source: 'agent_tool' })
    return toolJson({ ok: true, tool: 'junjichu', action, message: '多Agent办公室已打开。', hint: '已打开多Agent办公室，CEO 决策者坐镇会议桌，可在里面看到各位成员。' })
  }
  if (action === 'close' || action === 'hide') {
    emitEvent('junjichu_mode', { active: false, source: 'agent_tool' })
    return toolJson({ ok: true, tool: 'junjichu', action, message: '多Agent办公室已关闭。' })
  }

  // 看板状态
  if (action === 'status' || action === 'list') {
    const tasks = listTasks()
    emitEvent('junjichu_mode', { active: true, source: 'agent_tool' })
    const summary = tasks.map(t => `${t.id} [${t.status}] ${t.content.slice(0, 30)}`).join('\n') || '暂无任务'
    return toolJson({ ok: true, tool: 'junjichu', action, task_count: tasks.length, tasks: tasks.map(t => ({ id: t.id, status: t.status, title: t.content.slice(0, 60) })), summary })
  }

  // 派活：走 CEO 拆解→分派→执行→汇总
  if (action === 'edict' || action === 'issue' || action === 'create') {
    if (!content) return toolJson({ ok: false, tool: 'junjichu', action, error: '派活需要任务内容（content）' })
    emitEvent('junjichu_mode', { active: true, source: 'agent_tool' })
    const task = await runEdictTask(content)
    emitEvent('edict_task', { id: task.id, status: task.status })
    return toolJson({
      ok: true, tool: 'junjichu', action: 'edict', task_id: task.id, status: task.status,
      domain: task.domain, executor: task.executor,
      report: String(task.report || '').slice(0, 3000),
      log: (task.log || []).map(e => `${e.stage}·${e.agent}: ${String(e.content || '').slice(0, 300)}`),
      hint: 'CEO 拆解→分派→执行→汇总已完成，详情见办公室任务看板。' + (task.status === 'rejected' ? ' 方案未通过，可查看驳回理由。' : ''),
    })
  }

  // 指派 / 提问：让某位成员回答，或对办公室说话
  if (action === 'ask' || action === 'speak' || action === 'chat') {
    if (!content) return toolJson({ ok: false, tool: 'junjichu', action, error: '提问需要内容（content）' })
    emitEvent('junjichu_mode', { active: true, source: 'agent_tool' })
    // 若指定了 agent，直接指派
    if (args.agent) {
      const cfg = getAgentConfig(String(args.agent).toLowerCase())
      if (cfg) {
        const r = await assignTask(cfg.id, content)
        return toolJson({ ok: true, tool: 'junjichu', action, agent: cfg.name, reply: String(r.reply || '').slice(0, 4000) })
      }
    }
    // 否则作为办公室发言（点名/推断）
    const r = await bossSpeak(content)
    const replies = (r.responses || []).map(x => `【${x.agentName}】${x.reply}`).join('\n\n')
    return toolJson({ ok: true, tool: 'junjichu', action, responses: (r.responses || []).map(x => ({ agent: x.agentName, reply: String(x.reply).slice(0, 600) })), summary: replies || r.hint || '' })
  }

  // 任务干预
  if (action === 'task_control' || action === 'control') {
    const id = String(args.task_id || '')
    const ctl = String(args.control || '')
    if (!id || !ctl) return toolJson({ ok: false, tool: 'junjichu', action, error: '需要 task_id 和 control(pause/cancel/resume)' })
    const r = controlTask(id, ctl)
    if (!r.ok) return toolJson({ ok: false, tool: 'junjichu', action, error: r.error })
    return toolJson({ ok: true, tool: 'junjichu', action, task_id: id, status: r.task.status })
  }

  // 可编程编排（P2-7）：运行 JSON 定义的流程，或预设流程
  if (action === 'workflow' || action === 'flow') {
    if (!content) return toolJson({ ok: false, tool: 'junjichu', action, error: 'workflow 需要内容（content）' })
    const name = String(args.flow || args.name || '').trim()
    let flow = WORKFLOWS[name]
    if (!flow && Array.isArray(args.flow_def)) flow = { name: name || 'custom', steps: args.flow_def }
    if (!flow) return toolJson({ ok: false, tool: 'junjichu', action, error: `未知流程 '${name}'，可用：${Object.keys(WORKFLOWS).join(', ')}；也可传 flow_def JSON` })
    emitEvent('junjichu_mode', { active: true, source: 'agent_tool' })
    const r = await runFlow(flow, content)
    return toolJson({
      ok: true, tool: 'junjichu', action, flow: r.flow_name,
      steps: r.results.map(x => ({
        stage: x.stage,
        agent: x.name || (x.parallel || []).map(p => p.name).join('、') || x.summary || '',
        ms: x.ms,
        reply: String(x.merged || x.reply || '').slice(0, 800),
      })),
      hint: `流程「${r.flow_name}」执行完成，详见步骤结果。`,
    })
  }

  // 动态注册外部 Agent（P2-10）：通过 A2A AgentCard 发现并拉上会议桌
  if (action === 'discover' || action === 'register') {
    const url = String(args.url || args.agent || '').trim()
    if (!url) return toolJson({ ok: false, tool: 'junjichu', action, error: 'discover 需要 url（如 http://127.0.0.1:9920）' })
    emitEvent('junjichu_mode', { active: true, source: 'agent_tool' })
    const r = await discoverAgent(url)
    if (!r.ok) return toolJson({ ok: false, tool: 'junjichu', action, error: r.error })
    emitEvent('agent_register', { agent: r.agent })
    return toolJson({ ok: true, tool: 'junjichu', action, agent: r.agent, hint: `外部 Agent「${r.agent.name}」已注册并坐镇会议桌。` })
  }

  // 手动审议/封驳
  if (action === 'review' || action === 'approve' || action === 'reject') {
    const id = String(args.task_id || '')
    if (!id) return toolJson({ ok: false, tool: 'junjichu', action, error: '需要 task_id' })
    const pass = action !== 'reject' && args.pass !== false
    const r = reviewTask(id, { pass, note: args.note })
    if (!r.ok) return toolJson({ ok: false, tool: 'junjichu', action, error: r.error })
    return toolJson({ ok: true, tool: 'junjichu', action, task_id: id, status: r.task.status, verdict: pass ? '通过' : '封驳' })
  }

  return toolJson({ ok: false, tool: 'junjichu', action, error: '未知 action，支持 open/close/status/edict/ask/task_control/review' })
}
