// 军机处控制工具：让主 Agent（小白龙）能通过对话/语音调动军机处
//   open/close 打开关闭面板；edict 下旨走三省六部；ask 点将/提问；status 看板；task_control/review 干预。
import { emitEvent } from '../events.js'
import { runEdictTask, listTasks, controlTask, reviewTask, getTask } from './task-flow.js'
import { bossSpeak, assignTask, getRoomHistory } from './room.js'
import { getAgentConfig } from './config.js'

function toolJson(obj) { return JSON.stringify(obj, null, 2) }

export async function execJunjichu(args = {}) {
  const action = String(args.action || '').trim().toLowerCase()
  const content = String(args.content || args.task || args.edict || args.prompt || '').trim()

  // 打开/关闭面板
  if (action === 'open' || action === 'show' || action === 'launch') {
    emitEvent('junjichu_mode', { active: true, source: 'agent_tool' })
    return toolJson({ ok: true, tool: 'junjichu', action, message: '军机处已打开。', hint: '已打开军机处面板，可在里面看到各位臣工。' })
  }
  if (action === 'close' || action === 'hide') {
    emitEvent('junjichu_mode', { active: false, source: 'agent_tool' })
    return toolJson({ ok: true, tool: 'junjichu', action, message: '军机处已关闭。' })
  }

  // 看板状态
  if (action === 'status' || action === 'list') {
    const tasks = listTasks()
    emitEvent('junjichu_mode', { active: true, source: 'agent_tool' })
    const summary = tasks.map(t => `${t.id} [${t.status}] ${t.content.slice(0, 30)}`).join('\n') || '暂无任务'
    return toolJson({ ok: true, tool: 'junjichu', action, task_count: tasks.length, tasks: tasks.map(t => ({ id: t.id, status: t.status, title: t.content.slice(0, 60) })), summary })
  }

  // 下旨：走三省六部流水线
  if (action === 'edict' || action === 'issue' || action === 'create') {
    if (!content) return toolJson({ ok: false, tool: 'junjichu', action, error: '下旨需要内容（content）' })
    emitEvent('junjichu_mode', { active: true, source: 'agent_tool' })
    const task = await runEdictTask(content)
    emitEvent('edict_task', { id: task.id, status: task.status })
    return toolJson({
      ok: true, tool: 'junjichu', action: 'edict', task_id: task.id, status: task.status,
      domain: task.domain, executor: task.executor,
      report: String(task.report || '').slice(0, 800),
      log: (task.log || []).map(e => `${e.stage}·${e.agent}: ${String(e.content || '').slice(0, 120)}`),
      hint: '三省六部流水线已完成，详情见军机处看板（奏折）。' + (task.status === 'rejected' ? ' 门下省封驳了此方案。' : ''),
    })
  }

  // 点将 / 提问：让某位臣工回答，或对军机处说话
  if (action === 'ask' || action === 'speak' || action === 'chat') {
    if (!content) return toolJson({ ok: false, tool: 'junjichu', action, error: '提问需要内容（content）' })
    emitEvent('junjichu_mode', { active: true, source: 'agent_tool' })
    // 若指定了 agent，直接点将
    if (args.agent) {
      const cfg = getAgentConfig(String(args.agent).toLowerCase())
      if (cfg) {
        const r = await assignTask(cfg.id, content)
        return toolJson({ ok: true, tool: 'junjichu', action, agent: cfg.name, reply: String(r.reply || '').slice(0, 1000) })
      }
    }
    // 否则作为军机处发言（点名/推断）
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
