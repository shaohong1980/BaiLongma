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
import { StateGraph } from './state-graph.js'

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
  try { fs.mkdirSync(path.dirname(TASKS_FILE), { recursive: true }); fs.writeFileSync(TASKS_FILE, JSON.stringify({ tasks, nextId }), 'utf-8') } catch (e) { console.warn('[src/multi-agent/task-flow.js] op failed:', e?.message || e) }
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
  // P2-8：结构化 trace —— 记录每阶段耗时（距上一阶段），可观测/回放
  const now = Date.now()
  const ms = t._lastMs ? now - t._lastMs : 0
  t._lastMs = now
  t.log.push({ stage, agent, content: String(content || '').slice(0, 4000), ms, ts: new Date().toISOString() })
  t.updated_at = new Date().toISOString()
  save()
  // 实时推给前端军机处，像群聊一样显示每位臣工的干活过程
  try {
    emitEvent('edict_progress', {
      taskId: t.id, stage, agent,
      content: String(content || '').slice(0, 600),
      status: t.status, ts: new Date().toISOString(),
    })
  } catch (e) { console.warn('[src/multi-agent/task-flow.js] op failed:', e?.message || e) }
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

// 解析分类结果（太子分拣）：从文本里找归属部堂
function parseDomain(text) {
  if (/财务|预算|成本|报表|投资|经济|税|钱粮/.test(text)) return 'finance'
  if (/安全|风险|加固|运维|防护|漏洞|应急|防御/.test(text)) return 'security'
  if (/合同|合规|法律|法务|条款|契约/.test(text)) return 'legal'
  if (/人事|招聘|考核|组织|绩效|岗位|人力/.test(text)) return 'hr'
  if (/开发|技术|代码|系统|软件|程序|脚本|架构|机器人|企微|部署/.test(text)) return 'dev'
  if (/教务|行政|招生|课程|台账|制度|文档|文案|PPT|宣传|会议纪要|管理|协调|排期|项目/.test(text)) return 'admin'
  return 'mixed'
}
// 部堂 → 执行 Agent（对齐当前办公室职能员工 agents.js，dev→外部 Claude Code，admin→外部 Hermes）
const DOMAIN_EXECUTOR = { dev: 'claudecode', admin: 'hermesagent', finance: 'libu', security: 'tijian', legal: 'xingbu', hr: 'hermesagent', mixed: 'claudecode' }
function parseExecutor(text) {
  return DOMAIN_EXECUTOR[parseDomain(text)] || 'claudecode'
}
function domainLabel(domain) {
  return { dev: '研发·技术(ClaudeCode)', admin: '运营·管理(Hermes)', finance: '财务·报表(报表统计)', security: '安全·体检(系统体检)', legal: '法务·检索(检索专员)', hr: '人事·管理(Hermes)', mixed: '综合' }[domain] || domain
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
    log(task, '分拣', '太子', `收到旨意：${task.content}`)
    const classify = await call('host', `请对下列旨意做分拣，判断属于哪类任务（只说结论）：属于技术开发类、教务行政类、还是综合两类？\n旨意：${task.content}`, ctx)
    task.domain = parseDomain(task.content + classify)
    log(task, '分拣', '太子', `判定归属：${domainLabel(task.domain)}（依据：${classify.slice(0, 200)}）`)

    // 2. 中书省规划
    task.status = 'planning'; save()
    const plan = await call('gm', `你是集团总经理。针对旨意做整体执行方案：目标、拆解、交付物清单、负责人。\n旨意：${task.content}\n（已分拣为${task.domain}类）`, ctx)
    task.plan = plan
    log(task, '规划', '中书省', plan)

    // 3. 门下省审议（可封驳）——由总经理终审（其人格含"成果终审、审核技术方案"，贴合门下省把关）
    task.status = 'review'; save()
    const review = await call('gm', `你是门下省审议官（总经理终审角色）。审视下面这份执行方案是否合格：可执行、无重大遗漏、符合旨意。用"通过"或"驳回"开头并说明理由。\n旨意：${task.content}\n方案：${plan.slice(0, 3500)}`, ctx)
    const verdict = parseVerdict(review)
    task.review = { pass: verdict.pass, note: review.slice(0, 800) }
    log(task, '审议', '门下省', review)
    if (!verdict.pass) {
      setStatus(task, 'rejected')
      return task
    }

    // 4. 尚书省派发（按部堂分派给对应尚书/大臣）
    task.executor = parseExecutor(task.content)
    const execCfg = getAgentConfig(task.executor)
    const executorName = execCfg ? `${execCfg.name}（${execCfg.role}）` : task.executor
    log(task, '派发', '尚书省', `派发给 ${executorName} 执行`)
    setStatus(task, 'executing')

    // 5. 六部执行（P1-3：失败自动重试，重试仍无有效交付则切换降级执行人）
    // 降级映射：外部 agent 挂掉 → 内部通用执行人；内部执行人挂掉 → claudecode/CEO
    const FALLBACK_EXECUTOR = { claudecode: 'hubu', hermesagent: 'hubu', hubu: 'claudecode', host: 'claudecode', libu: 'claudecode', xingbu: 'claudecode', bingbu: 'claudecode', gm: 'claudecode' }
    const isVoid = (txt) => !String(txt || '').trim() || /响应失败|执行失败|（执行失败|（该环节未返回内容）/.test(String(txt))
    let deliverable = ''
    let effectiveExecutor = task.executor
    for (let attempt = 0; attempt < 2; attempt++) {
      const execId = attempt === 0 ? task.executor : (FALLBACK_EXECUTOR[task.executor] || 'claudecode')
      const execCfg = getAgentConfig(execId)
      const execLabel = execCfg ? `${execCfg.name}（${execCfg.role}）` : execId
      deliverable = await call(execId, `你是执行部门。按方案产出完整可交付成果（方案/代码/文档等，要具体可落地）。\n旨意：${task.content}\n方案：${task.plan.slice(0, 3500)}`, ctx)
      task.execution = deliverable
      log(task, '执行', execLabel, deliverable)
      if (!isVoid(deliverable)) { effectiveExecutor = execId; break }
      if (attempt === 0) log(task, '执行', execLabel, '⚠️ 首次执行未产出有效交付，切换执行人自动重试…')
    }
    task.executor = effectiveExecutor

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

// ── F2：三省六部图模式（状态图引擎）────────────────────────────────────
// 用 state-graph 跑「分拣→规划→审议(可封驳)→派发→执行→回奏」：
//   · checkpoint：每节点落盘 data/edict-graph-checkpoints/<threadId>.json，可断点续跑
//   · approval：opts.approval 时，尚书省派发（执行前）暂停等人工审批
//   · audit：invoke 返回审计轨迹；任务看板（edict-tasks.json）仍同步更新
const EDICT_GRAPH_CP_DIR = () => path.join(paths.dataDir, 'edict-graph-checkpoints')
const edictGraphs = new Map()   // threadId -> { app, task, content }

export async function runEdictGraph(content, opts = {}) {
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

  const ctx = getRoomHistory(30)
  const FALLBACK_EXECUTOR = { claudecode: 'hubu', hermesagent: 'hubu', hubu: 'claudecode', host: 'claudecode', libu: 'claudecode', xingbu: 'claudecode', bingbu: 'claudecode', gm: 'claudecode' }
  const isVoid = (txt) => !String(txt || '').trim() || /响应失败|执行失败|（执行失败|（该环节未返回内容）/.test(String(txt))

  const g = new StateGraph({ checkpointDir: opts.checkpointDir || EDICT_GRAPH_CP_DIR() })

  g.addNode('classify', async (_state) => {
    log(task, '分拣', '太子', `收到旨意：${task.content}`)
    const classify = await call('host', `请对下列旨意做分拣，判断属于哪类任务（只说结论）：属于技术开发类、教务行政类、还是综合两类？\n旨意：${task.content}`, ctx)
    const domain = parseDomain(task.content + classify)
    task.domain = domain
    log(task, '分拣', '太子', `判定归属：${domainLabel(domain)}（依据：${classify.slice(0, 200)}）`)
    return { domain }
  })

  g.addNode('plan', async (_state) => {
    task.status = 'planning'; save()
    const plan = await call('gm', `你是集团总经理。针对旨意做整体执行方案：目标、拆解、交付物清单、负责人。\n旨意：${task.content}\n（已分拣为${task.domain}类）`, ctx)
    task.plan = plan
    log(task, '规划', '中书省', plan)
    return { plan }
  })

  g.addNode('review', async (state) => {
    task.status = 'review'; save()
    const review = await call('gm', `你是门下省审议官（总经理终审角色）。审视下面这份执行方案是否合格：可执行、无重大遗漏、符合旨意。用"通过"或"驳回"开头并说明理由。\n旨意：${task.content}\n方案：${String(state.plan || '').slice(0, 3500)}`, ctx)
    const verdict = parseVerdict(review)
    task.review = { pass: verdict.pass, note: review.slice(0, 800) }
    log(task, '审议', '门下省', review)
    return { reviewPass: verdict.pass, reviewNote: review }
  })
  g.addConditionalEdge('review', (s) => s.reviewPass ? 'dispatch' : 'end_rejected', { dispatch: 'dispatch', end_rejected: 'end_rejected' })

  g.addNode('dispatch', async (_state) => {
    task.executor = parseExecutor(task.content)
    const execCfg = getAgentConfig(task.executor)
    log(task, '派发', '尚书省', `派发给 ${execCfg ? `${execCfg.name}（${execCfg.role}）` : task.executor} 执行`)
    setStatus(task, 'executing')
    return { executor: task.executor }
  }, { approval: !!opts.approval })

  g.addNode('execute', async (_state) => {
    let deliverable = ''
    let effectiveExecutor = task.executor
    for (let attempt = 0; attempt < 2; attempt++) {
      const execId = attempt === 0 ? task.executor : (FALLBACK_EXECUTOR[task.executor] || 'claudecode')
      const execCfg = getAgentConfig(execId)
      const execLabel = execCfg ? `${execCfg.name}（${execCfg.role}）` : execId
      deliverable = await call(execId, `你是执行部门。按方案产出完整可交付成果（方案/代码/文档等，要具体可落地）。\n旨意：${task.content}\n方案：${String(task.plan || '').slice(0, 3500)}`, ctx)
      task.execution = deliverable
      log(task, '执行', execLabel, deliverable)
      if (!isVoid(deliverable)) { effectiveExecutor = execId; break }
      if (attempt === 0) log(task, '执行', execLabel, '⚠️ 首次执行未产出有效交付，切换执行人自动重试…')
    }
    task.executor = effectiveExecutor
    return { execution: deliverable, effectiveExecutor }
  })

  g.addNode('report', async (_state) => {
    const report = await call('gm', `你是集团总经理。汇总本次任务的完成情况，向董事长回奏：做了什么、产出、下一步建议。\n旨意：${task.content}`, ctx)
    task.report = report
    log(task, '回奏', '总经理', report)
    setStatus(task, 'done')
    return { report }
  })

  g.addNode('end_rejected', async (_state) => {
    setStatus(task, 'rejected')
    return { rejected: true }
  })

  g.setEntry('classify')
  g.addEdge('classify', 'plan')
  g.addEdge('plan', 'review')
  g.addEdge('dispatch', 'execute')
  g.addEdge('execute', 'report')

  const app = g.compile()
  const threadId = opts.threadId || ('edict-' + Date.now().toString(36))
  edictGraphs.set(threadId, { app, task, content: task.content })
  const r = await app.invoke({ content: task.content }, { threadId, onStep: opts.onStep })

  if (r.interrupted) {
    return { ok: true, graph: true, task_id: task.id, interrupted: true, threadId, waitingNode: r.waitingNode, task: { ...task, log: task.log } }
  }
  return { ok: true, graph: true, task_id: task.id, threadId, task: { ...task, log: task.log }, audit: r.audit || [] }
}

// 图模式：人工审批 / 断点续跑（approved=true 继续，false 驳回）
export async function resumeEdictGraph(threadId, { approved = true, note = '' } = {}) {
  const entry = edictGraphs.get(threadId)
  if (!entry) throw new Error(`未知流水线图线程: ${threadId}（请先以 graph:true 下旨）`)
  const r = await entry.app.resume(threadId, { approved, note })
  if (r.rejected) {
    setStatus(entry.task, 'rejected')
    return { ok: true, graph: true, rejected: true, threadId, task: { ...entry.task, log: entry.task.log }, note }
  }
  if (r.resumed) return { ok: true, graph: true, task_id: entry.task.id, threadId, task: { ...entry.task, log: entry.task.log }, audit: r.audit || [] }
  return { ok: true, graph: true, threadId, task: { ...entry.task, log: entry.task.log }, note: '该线程无待审批任务' }
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

