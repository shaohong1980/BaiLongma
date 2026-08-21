// 工作台（Workbench）工具实现：manage_todo / weekly_review
import { createTodo, completeTodo, updateTodo, deleteTodo, listTodos, getTodoById, getWorkbenchSnapshot, saveWeeklyReview, getWeeklyReview, listWeeklyReviews, currentWeekKey } from '../../memory/workbench.js'
import { emitEvent } from '../../events.js'

function formatTodo(t) {
  const statusMark = t.status === 'done' ? '✅' : '⬜'
  const priorityMark = '★'.repeat(Math.max(0, Number(t.priority) || 0))
  const tags = (() => { try { const arr = JSON.parse(t.tags || '[]'); return arr.length ? ` [${arr.join(', ')}]` : '' } catch { return '' } })()
  const date = String(t.completed_at || t.created_at || '').slice(0, 10)
  return `#${t.id} ${statusMark} ${t.title}${t.detail ? ' — ' + t.detail : ''}${priorityMark ? ' ' + priorityMark : ''}${tags}  (${date})`
}

function emitWorkbenchEvent() {
  try {
    emitEvent('workbench_updated', { snapshot: getWorkbenchSnapshot() })
  } catch (e) { console.warn('[src/capabilities/tools/workbench.js] op failed:', e?.message || e) }
}

export function execManageTodo(args = {}) {
  const action = String(args.action || '').trim()
  if (!action) return '错误：未提供 action（add/complete/update/delete/list）'

  if (action === 'list') {
    const status = args.status === 'done' ? 'done' : (args.status === 'pending' ? 'pending' : null)
    const todos = listTodos({ status })
    if (!todos.length) return status ? `当前没有「${status === 'done' ? '已完成' : '待办'}」事项。` : '工作台目前没有待办事项。'
    const lines = status ? todos.map(formatTodo) : todos.map(t => formatTodo(t))
    const snapshot = getWorkbenchSnapshot()
    return `工作台共 ${todos.length} 条（待办 ${snapshot.pending} · 完成 ${snapshot.done}）：\n` + lines.join('\n')
  }

  if (action === 'add') {
    const title = String(args.title || '').trim()
    if (!title) return '错误：add 需要提供 title'
    const r = createTodo({ title, detail: args.detail || '', priority: args.priority, tags: args.tags })
    if (!r.ok) return `错误：${r.error}`
    emitWorkbenchEvent()
    return `已加入待办 #${r.todo.id}：${r.todo.title}（优先级 ${r.todo.priority}）`
  }

  const id = Number(args.id)
  if (!Number.isInteger(id) || id <= 0) return '错误：需要合法的待办 id（用 list 查看）'

  if (action === 'complete') {
    const r = completeTodo(id)
    if (!r.ok) return `错误：${r.error}`
    emitWorkbenchEvent()
    return `已完成 ✅ #${id}：${r.todo.title}`
  }

  if (action === 'delete') {
    const existing = getTodoById(id)
    if (!existing) return `错误：未找到待办 #${id}`
    const r = deleteTodo(id)
    if (!r.ok) return `错误：${r.error}`
    emitWorkbenchEvent()
    return `已从工作台删除 #${id}：${existing.title}`
  }

  if (action === 'update') {
    const patch = {}
    if (args.title !== undefined) patch.title = args.title
    if (args.detail !== undefined) patch.detail = args.detail
    if (args.priority !== undefined) patch.priority = args.priority
    if (args.tags !== undefined) patch.tags = args.tags
    if (args.status !== undefined) patch.status = args.status
    if (!Object.keys(patch).length) return '错误：update 需要提供至少一个要修改的字段'
    const r = updateTodo(id, patch)
    if (!r.ok) return `错误：${r.error}`
    emitWorkbenchEvent()
    const statusLabel = r.todo.status === 'done' ? '完成事项' : '待办'
    return `已更新 #${id}（现为${statusLabel}）：${r.todo.title}`
  }

  return `错误：未知 action "${action}"，仅支持 add/complete/update/delete/list`
}

export function execWeeklyReview(args = {}) {
  const action = String(args.action || 'show').trim()
  const weekKey = String(args.week_key || '').trim() || currentWeekKey()

  if (action === 'list') {
    const reviews = listWeeklyReviews(20)
    if (!reviews.length) return '还没有写过每周复盘。跟我说「写一下这周复盘」即可开始。'
    return `最近的每周复盘（共 ${reviews.length} 条）：\n` + reviews.map(r =>
      `${r.week_key} ${r.mood ? '· ' + r.mood : ''}\n${String(r.content || '(空)').slice(0, 180)}`
    ).join('\n\n')
  }

  if (action === 'write') {
    if (!String(args.content || '').trim()) return '错误：write 需要提供 content 内容'
    const r = saveWeeklyReview({ weekKey, content: args.content, mood: args.mood })
    if (!r.ok) return `错误：${r.error}`
    emitWorkbenchEvent()
    return `每周复盘（${r.review.week_key}）已保存。${r.review.mood ? `心情：${r.review.mood}。` : ''}`
  }

  // show
  const review = getWeeklyReview(weekKey)
  if (!review) return `还没有 ${weekKey} 的每周复盘。`
  return `每周复盘（${weekKey}）${review.mood ? `\n心情：${review.mood}` : ''}\n\n${review.content || '(空)'}`
}
