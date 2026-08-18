// workbench 工作台 API：待办事项 / 完成事项 / 每周复盘的读取与增删改
import { createTodo, updateTodo, deleteTodo, listTodos, getWorkbenchSnapshot, saveWeeklyReview, getWeeklyReview, listWeeklyReviews, deleteWeeklyReview, currentWeekKey } from '../../memory/workbench.js'
import { emitEvent } from '../../events.js'
import { jsonResponse, readJsonBody } from '../utils.js'

function notifyUI() {
  try { emitEvent('workbench_updated', { snapshot: getWorkbenchSnapshot() }) } catch {}
}

function parseTodoId(pathname) {
  const m = String(pathname).match(/^\/workbench\/todos\/(\d+)$/)
  return m ? Number(m[1]) : null
}

export async function handleWorkbenchRoutes(req, res, url) {
  // ── GET /workbench：工作台总览（待办 + 最近完成 + 每周复盘概览） ──
  if (req.method === 'GET' && url.pathname === '/workbench') {
    const pending = listTodos({ status: 'pending' })
    const done = listTodos({ status: 'done', limit: 50 })
    const reviews = listWeeklyReviews(10)
    jsonResponse(res, 200, {
      ok: true,
      snapshot: getWorkbenchSnapshot(),
      pending,
      done,
      reviews,
      currentWeekKey: currentWeekKey(),
    })
    return true
  }

  // ── POST /workbench/todos：新建待办 ──
  if (req.method === 'POST' && url.pathname === '/workbench/todos') {
    try {
      const body = await readJsonBody(req)
      const r = createTodo({ title: body.title, detail: body.detail, priority: body.priority, tags: body.tags })
      if (!r.ok) { jsonResponse(res, 400, r); return true }
      notifyUI()
      jsonResponse(res, 200, { ok: true, todo: r.todo })
    } catch (err) { jsonResponse(res, 400, { ok: false, error: err.message }) }
    return true
  }

  // ── PATCH /workbench/todos/:id：更新待办（含完成） ──
  if (req.method === 'PATCH' && url.pathname.startsWith('/workbench/todos/')) {
    const id = parseTodoId(url.pathname)
    if (id == null) { jsonResponse(res, 404, { ok: false, error: 'unknown todo' }); return true }
    try {
      const body = await readJsonBody(req)
      const r = updateTodo(id, body)
      if (!r.ok) { jsonResponse(res, 400, r); return true }
      notifyUI()
      jsonResponse(res, 200, { ok: true, todo: r.todo })
    } catch (err) { jsonResponse(res, 400, { ok: false, error: err.message }) }
    return true
  }

  // ── DELETE /workbench/todos/:id：删除待办 ──
  if (req.method === 'DELETE' && url.pathname.startsWith('/workbench/todos/')) {
    const id = parseTodoId(url.pathname)
    if (id == null) { jsonResponse(res, 404, { ok: false, error: 'unknown todo' }); return true }
    const r = deleteTodo(id)
    if (!r.ok) { jsonResponse(res, 400, r); return true }
    notifyUI()
    jsonResponse(res, 200, { ok: true })
    return true
  }

  // ── GET /workbench/reviews?week_key=…：读取每周复盘（默认本周） ──
  if (req.method === 'GET' && url.pathname === '/workbench/reviews') {
    const weekKey = url.searchParams.get('week_key') || currentWeekKey()
    const reviews = listWeeklyReviews(10)
    jsonResponse(res, 200, { ok: true, currentWeekKey: currentWeekKey(), weekKey, review: getWeeklyReview(weekKey), reviews })
    return true
  }

  // ── POST /workbench/reviews：保存每周复盘 ──
  if (req.method === 'POST' && url.pathname === '/workbench/reviews') {
    try {
      const body = await readJsonBody(req)
      const r = saveWeeklyReview({ weekKey: body.week_key, content: body.content, mood: body.mood })
      if (!r.ok) { jsonResponse(res, 400, r); return true }
      notifyUI()
      jsonResponse(res, 200, { ok: true, review: r.review })
    } catch (err) { jsonResponse(res, 400, { ok: false, error: err.message }) }
    return true
  }

  // ── DELETE /workbench/reviews?week_key=…：删除某周复盘 ──
  if (req.method === 'DELETE' && url.pathname === '/workbench/reviews') {
    try {
      const weekKey = url.searchParams.get('week_key')
      if (!weekKey || !String(weekKey).trim()) { jsonResponse(res, 400, { ok: false, error: 'week_key 必填' }); return true }
      deleteWeeklyReview(weekKey)
      notifyUI()
      jsonResponse(res, 200, { ok: true, week_key: weekKey })
    } catch (err) { jsonResponse(res, 400, { ok: false, error: err.message }) }
    return true
  }

  return false
}
