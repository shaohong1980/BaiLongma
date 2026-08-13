// 长期目标工具实现：set_goal / list_goals / update_goal / show_briefing
import { createGoal, updateGoal, listGoals } from '../../memory/goals.js'
import { getLatestBriefing, generateBriefing } from '../../runtime/briefing.js'
import { emitEvent } from '../../events.js'

function formatGoal(g) {
  const statusIcon = { active: '▶', paused: '⏸', done: '✅', abandoned: '✖' }
  return `${statusIcon[g.status] || '·'} #${g.id} 【${g.title}】 进度 ${g.progress || 0}% · 优先级 ${g.priority}${g.due_at ? ' · 截止 ' + String(g.due_at).slice(0, 10) : ''}${g.result_note ? '\n   注: ' + g.result_note : ''}`
}

export function execSetGoal(args = {}) {
  const r = createGoal(args)
  if (!r.ok) return `错误：${r.error}`
  const g = r.goal
  return `已创建长期目标 #${g.id}「${g.title}」（优先级 ${g.priority}）。我会在晨间简报里跟进它的进展；想改进度或状态时说一声，或用 update_goal。`
}

export function execListGoals(args = {}) {
  const goals = listGoals({ status: args.status || null })
  if (!goals.length) return args.status ? `当前没有 ${args.status} 状态的目标。` : '当前还没有长期目标。可以跟我说「定个目标：…」来创建。'
  return `共 ${goals.length} 个目标：\n` + goals.map(formatGoal).join('\n')
}

export function execUpdateGoal(args = {}) {
  const id = Number(args.id)
  if (!Number.isInteger(id) || id <= 0) return '错误：update_goal 需要合法的目标 id（用 list_goals 查看）'
  const { id: _drop, ...patch } = args
  const r = updateGoal(id, patch)
  if (!r.ok) return `错误：${r.error}`
  const g = r.goal
  if (g.status === 'done') return `目标 #${id}「${g.title}」已完成 🎉`
  return `目标 #${id} 已更新：${g.title} · 进度 ${g.progress || 0}% · 状态 ${g.status}`
}

// 晨间简报：取今天的简报（没有则生成），推事件让前端展开简报卡片
export async function execShowBriefing(args = {}) {
  let briefing = getLatestBriefing()
  if (!briefing || args.force) {
    const r = await generateBriefing({ force: !!args.force })
    if (r.ok && r.content) briefing = { date: r.date, content: r.content }
  }
  if (!briefing || !briefing.content) {
    return '晨间简报还没生成成功，稍后再试；如果持续失败，可能是 LLM 配置的问题。'
  }
  emitEvent('briefing_show', { date: briefing.date, content: briefing.content })
  return `已为你打开今日晨间简报（${briefing.date}）。`
}
