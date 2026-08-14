// 军机处任务流水线（移植 edict 三省六部制度）
// 皇上(董事长)下旨 → 太子分拣 → 中书省规划 → 门下省审议(可封驳) → 尚书省派发 → 六部执行 → 回奏
// 每步都写进「奏折」审计日志；支持叫停/取消/恢复；有军机处看板。
import fs from 'fs'
import path from 'path'
import { getAgentConfig } from './config.js'
import { runAgentEngine } from './engines.js'
import { getRoomHistory } from './room.js'
import { paths } from '../paths.js'
import { emitEvent } from '../events.js'

const TASKS_FILE = path.join(paths.dataDir, 'edict-tasks.json')
const MAX_TASKS = 50
let tasks = []
let nextId = 1

function load() {
  try {
    if (fs.existsSync(TASKS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf-8'))
      tasks = Array.isArray(raw.tasks) ? raw.tasks : []
      nextId = Number(raw.nextId) || 1
    }
  } catch { tasks = [] }
}
function persist() {
  try { fs.mkdirSync(path.dirname(TASKS_FILE), { recursive: true }); fs.writeFileSync(TASKS_FILE, JSON.stringify({ tasks, nextId }), 'utf-8') } catch {}
}
function save() { tasks = tasks.slice(0, MAX_TASKS); persist() }

export function listTasks() {
  return tasks
}
export function getTask(id) {
  return tasks.find(t => t.id === id) || null
}
export function resetTasks() {
  tasks = []; nextId = 1; persist()
}
function log(t, stage, agent, content) {
  t.log.push({ stage, agent, content: String(content || '').slice(0, 2000), ts: new Date().toISOString() })
  t.updated_at = new Date().toISOString()
  save()
}
function setStatus(t, status) {
  t.status = status; t.updated_at = new Date().toISOString(); save()
  emitEvent('edict_task', { id: t.id, status, title: t.content.slice(0, 40) })
}

// 单步调用某 Agent，返回回复；空结果时用更简短的提示重试一次
async function call(agentId, prompt, ctx) {
  let reply = await runAgentEngine(agentId, ctx, prompt, true).catch(() => '')
  if (!String(reply || '').trim()) {
    // 空回复重试：更短、更直接的提示
    reply = await runAgentEngine(agentId, [], `简短回答：${prompt.slice(0, 200)}`, true).catch(() => '')
  }
  return String(reply || '').trim() || '（该环节未返回内容）'
}

// 解析分类结果（太子分拣）：从文本里找 开发/技术/代码 或 教务/行政/文档
function parseDomain(text) {
  if (/开发|技术|代码|系统|软件|程序|脚本|架构|机器人|企微|部署/.test(text)) return 'dev'
  if (/教务|行政|招生|课程|台账|制度|文档|文案|PPT|宣传|会议纪要/.test(text)) return 'admin'
  return 'mixed'
}
function parseExecutor(text) {
  if (/开发|技术|代码|系统|软件|程序|脚本|架构/.test(text)) return 'coder'
  if (/教务|行政|招生|课程|台账|制度|文档|文案|PPT/.test(text)) return 'admin'
  return 'coder'
}
function parseVerdict(text) {
  if (/通过|批准|同意|合格|approve|ok|可以/.test(text)) return { pass: true }
  if (/驳回|封驳|不通过|不合格|reject|驳回/.test(text)) return { pass: false }
  return { pass: true } // 默认放行
}

// 运行完整流水线
export async function runEdictTask(content) {
  const ctx = getRoomHistory(30)
  const task = {
    id: `task_${String(nextId++).padStart(3, '0')}`,
    content: String(content || '').trim(),
    domain: '', plan: '', review: null, executor: '',
    execution: '', report: '',
    status: 'planning',
    log: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }
  tasks.unshift(task)
  save()
  emitEvent('edict_task', { id: task.id, status: task.status, title: task.content.slice(0, 40) })

  try {
    // 1. 太子分拣
    const taizi = getAgentConfig('host')
    log(task, '分拣', '太子', `收到旨意：${task.content}`)
    const classify = await call('host', `请对下列旨意做分拣，判断属于哪类任务（只说结论）：属于技术开发类、教务行政类、还是综合两类？\n旨意：${task.content}`, ctx)
    task.domain = parseDomain(task.content + classify)
    log(task, '分拣', '太子', `判定为：${task.domain === 'dev' ? '技术开发' : task.domain === 'admin' ? '教务行政' : '综合'}类（依据：${classify.slice(0, 200)}）`)

    // 2. 中书省规划
    task.status = 'planning'; save()
    const plan = await call('gm', `你是集团总经理。针对旨意做整体执行方案：目标、拆解、交付物清单、负责人。\n旨意：${task.content}\n（已分拣为${task.domain}类）`, ctx)
    task.plan = plan
    log(task, '规划', '中书省', plan)

    // 3. 门下省审议（可封驳）——由总经理终审（其人格含"成果终审、审核技术方案"，贴合门下省把关）
    task.status = 'review'; save()
    const review = await call('gm', `你是门下省审议官（总经理终审角色）。审视下面这份执行方案是否合格：可执行、无重大遗漏、符合旨意。用"通过"或"驳回"开头并说明理由。\n旨意：${task.content}\n方案：${plan.slice(0, 1500)}`, ctx)
    const verdict = parseVerdict(review)
    task.review = { pass: verdict.pass, note: review.slice(0, 800) }
    log(task, '审议', '门下省', review)
    if (!verdict.pass) {
      setStatus(task, 'rejected')
      return task
    }

    // 4. 尚书省派发
    task.executor = parseExecutor(task.content)
    const executorName = task.executor === 'coder' ? 'Claude Code' : 'HermesAgent'
    log(task, '派发', '尚书省', `派发给 ${executorName} 执行`)
    setStatus(task, 'executing')

    // 5. 六部执行
    const deliverable = await call(task.executor, `你是执行部门。按方案产出完整可交付成果（方案/代码/文档等，要具体可落地）。\n旨意：${task.content}\n方案：${task.plan.slice(0, 1200)}`, ctx)
    task.execution = deliverable
    log(task, '执行', executorName, deliverable)

    // 6. 回奏
    const report = await call('gm', `你是集团总经理。汇总本次任务的完成情况，向董事长回奏：做了什么、产出、下一步建议。\n旨意：${task.content}`, ctx)
    task.report = report
    log(task, '回奏', '总经理', report)
    setStatus(task, 'done')
  } catch (err) {
    setStatus(task, 'error')
    log(task, '异常', '军机处', err.message || String(err))
  }
  return task
}

// 任务干预：叫停/取消/恢复（看板状态控制）
export function controlTask(id, action) {
  const t = getTask(id)
  if (!t) return { ok: false, error: '任务不存在' }
  const act = String(action || '').toLowerCase()
  if (act === 'cancel') { t.cancel_requested = true; setStatus(t, 'cancelled') }
  else if (act === 'pause') { if (t.status === 'executing') setStatus(t, 'paused') }
  else if (act === 'resume') { if (t.status === 'paused') setStatus(t, 'executing') }
  else return { ok: false, error: 'action 需为 cancel/pause/resume' }
  return { ok: true, task: t }
}

// 手动审议/封驳
export function reviewTask(id, { pass, note }) {
  const t = getTask(id)
  if (!t) return { ok: false, error: '任务不存在' }
  t.review = { pass: !!pass, note: String(note || '') }
  log(t, '审议', '门下省', `董事长手动${pass ? '通过' : '封驳'}：${note || ''}`)
  setStatus(t, pass ? 'executing' : 'rejected')
  return { ok: true, task: t }
}

load()
