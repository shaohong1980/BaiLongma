// 多 Agent 军机处室 —— 共享会话 + 点名响应
// 皇上在军机处室发言 → 所有 Agent 在场；点名某位（名字/角色）→ 该 Agent 响应。
// 未点名时按话题/能力推断最相关的一位响应；都不确定则无人响应（皇上可再点名）。
import fs from 'fs'
import path from 'path'
import { AGENTS } from './agents.js'
import { getAgentConfig, getAllAgentConfigs } from './config.js'
import { runAgentEngine } from './engines.js'
import { remember, setSummary } from './memory.js'
import { recordActivity } from './ledger.js'
import { paths } from '../paths.js'
import { emitEvent } from '../events.js'

const ROOM_FILE = path.join(paths.dataDir, 'room-conversation.json')
const MAX_HISTORY = 60
const COMPACT_THRESHOLD = 40   // P1-5：超过此条数开始压缩旧消息为摘要
const MAX_ROUNDS = 20   // 军机处最大轮次（主持人硬性上限，防死循环）
const SESSION_IDLE_MS = 10 * 60 * 1000   // 距上次活动超过 10 分钟 → 视为新会话，重置轮次

// 距上次活动超过阈值视为新会话：重置轮次，避免"轮次上限跨会话永久卡死"。
// （防死循环只对持续进行的同一场会议有意义；隔了很久的新指令不该被旧轮次拦住）
function maybeNewSession() {
  const last = history[history.length - 1]
  if (!last || !last.ts) return
  try {
    if (Date.now() - new Date(last.ts).getTime() > SESSION_IDLE_MS) round = 0
  } catch {}
}

// 军机处室消息：{ role: 'boss'|'agent', agentId?, agentName?, avatar?, content, ts }
let history = []
let round = 0

function load() {
  try {
    if (fs.existsSync(ROOM_FILE)) {
      const raw = JSON.parse(fs.readFileSync(ROOM_FILE, 'utf-8'))
      history = Array.isArray(raw) ? raw : (raw.messages || [])
      round = Number(raw?.round || 0)
    }
  } catch { history = [] }
}
function persist() {
  try { fs.mkdirSync(path.dirname(ROOM_FILE), { recursive: true }); fs.writeFileSync(ROOM_FILE, JSON.stringify({ messages: history, round }), 'utf-8') } catch {}
}
function push(msg) {
  history.push(msg)
  // P1-5：会话压缩——历史过长时把最早的消息压缩成一条滚动摘要，
  // 而不是直接硬丢弃（避免长会议"前半段失忆"）。
  if (history.length > COMPACT_THRESHOLD) {
    const overflow = history.slice(0, history.length - COMPACT_THRESHOLD)
    const lines = overflow.map(m => `[${m.role === 'boss' ? '老板' : (m.agentName || '成员')}] ${String(m.content || '').slice(0, 150)}`)
    setSummary(lines.join('\n'))
    history = history.slice(-COMPACT_THRESHOLD)
  }
  history = history.slice(-MAX_HISTORY)
  persist()
}

export function getRoomHistory(limit = MAX_HISTORY) {
  return history.slice(-limit)
}
export function getMeetingRound() { return round }
export function resetRoom() {
  history = []
  round = 0
  persist()
}

// 点名检测：返回被点到的 Agent id 数组（名字/角色/@，大小写不敏感）
export function detectAddressedAgents(text) {
  const t = String(text || '').trim()
  if (!t) return []
  const lower = t.toLowerCase()
  const hits = []
  for (const a of getAllAgentConfigs()) {
    const name = String(a.name || '').trim().toLowerCase()
    const role = String(a.role || '').trim().toLowerCase()
    const id = String(a.id || '').trim().toLowerCase()
    // @ 直接点名：@名称 / @角色 / @id（名称含空格也能整段匹配）
    const atMentions = (t.match(/@([^\s@，,。！!？?：:]+)/g) || []).map(m => m.slice(1).toLowerCase())
    const mentionsFullName = name && lower.includes('@' + name)
    if ((name && (atMentions.includes(name) || mentionsFullName)) || (role && atMentions.includes(role)) || (id && atMentions.includes(id))) {
      hits.push(a.id)
      continue
    }
    // 自然语言点名：给/叫/让/请/问/找 + 名称或角色
    const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const nameRe = new RegExp(`(?:给|叫|让|请|问|找)\\s*${esc(name)}|${esc(name)}\\s*[，,：:。!！？?]`, 'i')
    const roleRe = new RegExp(`(?:@|给|找|问|让|请|叫)\\s*${esc(role)}`, 'i')
    if ((name && nameRe.test(t)) || (role && roleRe.test(t))) hits.push(a.id)
  }
  return [...new Set(hits)]
}

// 按话题推断最相关 Agent：统计所有角色关键词命中，取得分最高者（避免顺序抢答）
function inferRelevantAgent(text) {
  const t = String(text || '')
  const roleMap = [
    { re: /技术|开发|代码|架构|系统|接口|数据库|前端|后端|脚本|部署|机器人|设计|页面|界面|登录|网站|网页|app|软件|程序/g, id: 'claudecode', w: 1 },
    { re: /管理|协调|排期|进度|统筹|分工|资源|跨部门|组织|汇报|会议|教务|行政|文案|PPT|制度|招生|课程/g, id: 'hermesagent', w: 1 },
    { re: /财务|预算|成本|报表|投资|经济|税/g, id: 'hubu', w: 1 },
    { re: /安全|风险|加固|运维|应急|防护|漏洞/g, id: 'bingbu', w: 1 },
    { re: /合同|合规|法律|法务|条款|风险提示/g, id: 'xingbu', w: 1 },
    { re: /人事|招聘|考核|组织|绩效|岗位/g, id: 'libu', w: 1 },
    { re: /体检|诊断|磁盘|性能|电池|系统检查|大文件|垃圾|健康|cpu|内存占用/g, id: 'tijian', w: 1 },
    { re: /统筹|协调|评审|复盘|分工|全局/g, id: 'gm', w: 1 },
  ]
  let best = null, bestScore = 0
  for (const { re, id, w } of roleMap) {
    const hits = (t.match(re) || []).length
    if (hits * w > bestScore) { bestScore = hits * w; best = id }
  }
  if (bestScore > 0) return best
  // 能力词命中
  for (const a of getAllAgentConfigs()) {
    let score = 0
    for (const cap of (a.capabilities || [])) if (t.includes(cap)) score += 1
    if (score > bestScore) { bestScore = score; best = a.id }
  }
  return bestScore > 0 ? best : null
}

// 皇上发言 → 点名/推断 → 让对应 Agent 响应
// targetAgentIds：前端 @点名解析出的精确目标（只让被点名的成员回答，跳过推断/开会编排）
export async function bossSpeak(content, targetAgentIds = null) {
  const text = String(content || '').trim()
  if (!text) throw new Error('发言不能为空')

  // 军机处轮次限制（主持人硬性上限 20 轮）；新会话自动重置
  maybeNewSession()
  if (round >= MAX_ROUNDS) {
    return { ok: true, forced_end: true, hint: `军机处已达 ${MAX_ROUNDS} 轮上限，本轮强制结束。可清空军机处室（/room/reset）重新开会。`, responses: [] }
  }
  round += 1
  push({ role: 'boss', content: text, ts: new Date().toISOString() })

  // 显式 @点名：精确路由到被点名的成员，其他成员一律不响应
  const explicit = Array.isArray(targetAgentIds) && targetAgentIds.length > 0
  let targets = []
  if (explicit) {
    targets = targetAgentIds.filter(id => getAgentConfig(id))
    if (!targets.length) { /* 全部无效 → 回落自动推断 */ }
  }
  if (!explicit || targets.length === 0) {
    targets = detectAddressedAgents(text)
    if (!targets.length) {
      const inferred = inferRelevantAgent(text)
      if (inferred) targets = [inferred]
    }
    // 兜底：仍无人被点名/推断到 → 爻台中枢接旨统筹，保证皇上说话必有回应
    if (!targets.length) targets = ['gm']
    // 开会编排：点名主持人或消息含"开会/军机处" → 主持人先拆解，爻台中枢跟着牵头统筹
    const isMeeting = /开会|军机处|启动|开始|部署|搭建|立项/.test(text)
    if (isMeeting && !targets.includes('host')) targets.unshift('host')
    if (isMeeting && targets.includes('host') && !targets.includes('gm')) targets.push('gm')
  }

  const responses = []
  for (const agentId of targets.slice(0, 3)) {
    const agent = getAgentConfig(agentId)
    const roomCtx = getRoomHistory(MAX_HISTORY)
    try {
      const t0 = Date.now()
      const reply = await runAgentEngine(agentId, roomCtx, text, false)
      push({ role: 'agent', agentId, agentName: agent.name, avatar: agent.avatar, content: reply, ts: new Date().toISOString() })
      if (agent.voice?.enabled) emitEvent('agent_tts', { agentId, text: reply.slice(0, 300), voiceId: agent.voice?.voiceId || '' })
      responses.push({ agentId, agentName: agent.name, avatar: agent.avatar, role: agent.role, reply })
      recordActivity({ agentId, agentName: agent.name, task: text, result: reply.slice(0, 300), ms: Date.now() - t0 })   // B
    } catch (err) {
      responses.push({ agentId, agentName: agent.name, avatar: agent.avatar, reply: '（响应失败：' + err.message + '）', error: true })
    }
  }
  // P1-4：会议纪要沉淀到办公室长期记忆
  if (responses.length) {
    const digest = responses.map(r => `${r.agentName}：${String(r.reply).slice(0, 100)}`).join(' / ')
    await remember({ type: 'meeting', agent: '会议桌', content: `议题「${text}」→ ${digest}` })
  }

  return { ok: true, no_target: false, round, responses }
}

// 办公版工作流：按任务关键词推断应参与的职能员工（多选，最多 3 个）
function inferOfficeWorkers(text) {
  const t = String(text || '')
  const map = [
    { re: /代码|开发|架构|技术|编程|重构|部署|实现|系统设计|接口|方案|规划|需求|计划|设计|脚本|python|程序|函数|代码库|写.*脚本|写.*程序/g, id: 'claudecode', w: 1 },
    { re: /排期|协调|进度|分工|安排|组织|任务分派|统筹|汇报|管理|跨部门/g, id: 'hermesagent', w: 1 },
    { re: /文件|归档|文档|整理|资料|版本|备份|目录/g, id: 'host', w: 1 },
    { re: /电脑|操作|运行|桌面|本地|系统设置|安装|应用启动/g, id: 'hubu', w: 1 },
    { re: /应用|连接|接口调用|第三方|对接|连接器|app|插件/g, id: 'bingbu', w: 1 },
    { re: /搜索|查找|检索|资料|知识库|调研|查询/g, id: 'xingbu', w: 1 },
    { re: /报表|数据|统计|汇总|表格|图表|进度看板|口径/g, id: 'libu', w: 1 },
    { re: /体检|诊断|磁盘|性能|电池|系统检查|大文件|垃圾|健康|cpu|内存占用/g, id: 'tijian', w: 1 },
  ]
  const scores = {}
  for (const { re, id, w } of map) {
    const hits = (t.match(re) || []).length
    if (hits) scores[id] = (scores[id] || 0) + hits * w
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]).map(x => x[0])
  return ranked.slice(0, 3)
}

// 从 CEO 拆解回复里提取 {"workers":[...]} JSON 行，过滤出有效 agent id（不含 CEO）
function extractCeoWorkers(reply) {
  try {
    const m = String(reply || '').match(/\{[\s\S]*?"workers"[\s\S]*?\}/)
    if (!m) return []
    const parsed = JSON.parse(m[0])
    if (!Array.isArray(parsed.workers)) return []
    const valid = [...new Set(
      parsed.workers
        .map(w => String(w).trim().toLowerCase())
        .filter(id => id && id !== 'gm' && getAgentConfig(id))
    )]
    return valid.slice(0, 3)
  } catch { return [] }
}

// A：证据化交付验证 —— 员工交付后，验货员（文件管理 host）用真实工具核实产物存在、
// 内容匹配，杜绝"文字声称已交付但实体不存在"的嘴炮交付。
// 返回 { verified: true, pass: bool, verdict } 或 { verified: false }（验证器不可用时）。
async function verifyDelivery(workerName, taskText, reply) {
  try {
    emitEvent('office_progress', { agentId: 'host', status: 'working', stage: 'verify', text: `验货：${workerName} 的交付` })
    const verdict = await runAgentEngine('host', getRoomHistory(MAX_HISTORY),
      `你是办公室验货员。员工「${workerName}」针对任务「${taskText}」交付了以下内容。请用工具（list_dir/read_file/exec_command）**实际核实**交付产物是否真实存在、内容是否匹配任务。\n规则：必须给出可复核的证据（文件路径/命令输出/运行结果）；没有证据就判不通过。\n返回格式：**第一行只写"通过"或"不通过"两个汉字**，随后列出证据。\n\n员工交付内容：\n${String(reply).slice(0, 1500)}`, true)
    const v = String(verdict || '').trim()
    // 宽容判定：优先看全文信号，有明确证据/通过标记即判过；出现不通过/缺失/无法验证才判不过
    const failSignal = /不通过|未通过|不存在|无法验证|未找到|缺少(?:关键|交付|证据)/i.test(v)
    const passSignal = /通过|存在|已确认|已核实|已验证|ok\b/i.test(v)
    const pass = passSignal && !failSignal
    emitEvent('office_progress', { agentId: 'host', status: 'reporting', stage: 'verify_done', text: `验货：${pass ? '通过' : '不通过'}` })
    return { verified: true, pass, verdict: v.slice(0, 400) }
  } catch (err) {
    emitEvent('office_progress', { agentId: 'host', status: 'idle', stage: 'verify_failed', text: '—' })
    return { verified: false }
  }
}

// 多Agent办公室工作流：上级发指令 → CEO 决策者拆解 → 分派相关职能员工执行 → CEO 汇总
export async function officeCommand(content) {
  const text = String(content || '').trim()
  if (!text) throw new Error('指令不能为空')
  const tStart = Date.now()   // 记录整个指令周期耗时（B：CEO 台账）
  // 新会话自动重置轮次（避免跨会话卡死）
  maybeNewSession()
  if (round >= MAX_ROUNDS) {
    return { ok: true, forced_end: true, hint: `办公室已达 ${MAX_ROUNDS} 轮上限，本轮强制结束。可重置后重新派单。`, ceoReply: '', workerReplies: [], ceoSummary: '' }
  }
  round += 1
  push({ role: 'boss', content: `【上级指令】${text}`, ts: new Date().toISOString() })

  const ceo = getAgentConfig('gm')

  // 1. CEO 拆解（要求末尾输出 JSON workers，作为分派依据，修掉"想派的≠实际派的"）
  let ceoReply = ''
  emitEvent('office_progress', { agentId: 'gm', status: 'thinking', stage: 'ceo', text: `拆解：${text}` })
  try {
    const ceoOptions = getAllAgentConfigs().filter(a => a.id !== 'gm').map(a => `${a.id}(${a.name})`).join('、')
    ceoReply = await runAgentEngine('gm', getRoomHistory(MAX_HISTORY),
      `收到上级指令：「${text}」。请你作为 CEO 决策者先拆解任务并点名参与的职能员工。
1) 用文字说明任务拆解与分工。
2) 在回复最末尾单独输出一行 JSON（只这一行，不要放进代码块）：{"workers":["员工id",...]}
   最多 3 个，只列真正需要的人；无需任何人可输出 {"workers":[]}。
可选员工 id：${ceoOptions}。`, false)
    push({ role: 'agent', agentId: 'gm', agentName: ceo.name, avatar: ceo.avatar, content: ceoReply, ts: new Date().toISOString() })
  } catch (err) {
    ceoReply = '（CEO 拆解失败：' + err.message + '）'
  }
  emitEvent('office_progress', { agentId: 'gm', status: 'reporting', stage: 'ceo_done', text: '拆解完成，分派中…' })

  // 2. 分派工人：优先用 CEO 点名的 workers，解析失败再回退关键词推断
  let workers = extractCeoWorkers(ceoReply)
  if (!workers.length) workers = inferOfficeWorkers(text)
  const workerName = workers.map(id => getAgentConfig(id)?.name || id).join('、')
  emitEvent('office_progress', { agentId: 'gm', status: 'reporting', stage: 'dispatch', text: `分派给：${workerName || '（无）'}` })

  // 3. 分派工人执行（每个 worker 开始/结束都实时推送，让前端看到"眼睛在动"）
  const workerReplies = []
  for (const wid of workers) {
    const worker = getAgentConfig(wid)
    if (!worker) continue
    emitEvent('office_progress', { agentId: wid, status: 'working', stage: 'executing', text, bubble: '⚙️ 收到任务，开始处理…' })
    const t0 = Date.now()
    try {
      const reply = await runAgentEngine(wid, getRoomHistory(MAX_HISTORY),
        `上级指令：「${text}」。CEO 已把属于你职责的部分交给你，请直接产出可执行交付。`, true)
      push({ role: 'agent', agentId: wid, agentName: worker.name, avatar: worker.avatar, content: reply, ts: new Date().toISOString() })
      if (worker.voice?.enabled) emitEvent('agent_tts', { agentId: wid, text: reply.slice(0, 300), voiceId: worker.voice?.voiceId || '' })
      emitEvent('office_progress', { agentId: wid, status: 'reporting', stage: 'done', text: '交付完成' })
      // A：证据化验证（验货员核实产物真实存在）
      const verified = await verifyDelivery(worker.name, text, reply)
      workerReplies.push({ agentId: wid, agentName: worker.name, avatar: worker.avatar, role: worker.role, reply, verified })
      // B：台账记录
      recordActivity({ agentId: wid, agentName: worker.name, task: text, result: reply.slice(0, 300), ms: Date.now() - t0 })
    } catch (err) {
      const ms = Date.now() - t0
      workerReplies.push({ agentId: wid, agentName: worker.name, avatar: worker.avatar, role: worker.role, reply: '（执行失败：' + err.message + '）', error: true, verified: { verified: true, pass: false, verdict: '执行异常，无法验证交付' } })
      recordActivity({ agentId: wid, agentName: worker.name, task: text, result: '（执行失败）' + err.message, ms })
    }
    emitEvent('office_progress', { agentId: wid, status: 'idle', stage: 'idle', text: '—' })
  }

  // 3. CEO 汇总
  let ceoSummary = ''
  try {
    emitEvent('office_progress', { agentId: 'gm', status: 'thinking', stage: 'summary', text: '汇总结果…' })
    if (workerReplies.length) {
      ceoSummary = await runAgentEngine('gm', getRoomHistory(MAX_HISTORY),
        `上级指令：「${text}」。各成员交付如下：\n${workerReplies.map(r => `【${r.agentName}】${r.reply}`).join('\n\n')}\n请汇总结果并向用户汇报（总结要点、指出待确认事项）。`, true)
    } else {
      ceoSummary = ceoReply
    }
    push({ role: 'agent', agentId: 'gm', agentName: ceo.name, avatar: ceo.avatar, content: ceoSummary, ts: new Date().toISOString() })
  } catch (err) {
    ceoSummary = ceoReply
  }
  emitEvent('office_progress', { agentId: 'gm', status: 'idle', stage: 'complete', text: '—' })

  // P1-4：结论沉淀到办公室长期记忆
  if (ceoSummary && !/响应失败|失败/.test(ceoSummary)) {
    await remember({ type: 'decision', agent: 'CEO', content: `指令「${text}」→ 分派 ${workerName} → 结论：${String(ceoSummary).slice(0, 500)}` })
  }
  // B：CEO 台账（整周期耗时）
  recordActivity({ agentId: 'gm', agentName: ceo.name, task: `【CEO】${text.slice(0, 100)}`, result: String(ceoSummary || ceoReply || '').slice(0, 300), ms: Date.now() - tStart })

  return { ok: true, round, ceoReply, workerReplies, ceoSummary, workers }
}

// 给某 Agent 布置任务
export async function assignTask(agentId, task) {
  const agent = getAgentConfig(agentId)
  if (!agent) throw new Error(`未知 Agent: ${agentId}`)
  const taskText = String(task || '').trim()
  if (!taskText) throw new Error('任务不能为空')
  push({ role: 'boss', content: `【布置任务给 ${agent.name}】${taskText}`, ts: new Date().toISOString() })
  const t0 = Date.now()
  const reply = await runAgentEngine(agentId, getRoomHistory(MAX_HISTORY), taskText, true)
  push({ role: 'agent', agentId, agentName: agent.name, avatar: agent.avatar, content: reply, ts: new Date().toISOString() })
  if (agent.voice?.enabled) emitEvent('agent_tts', { agentId, text: reply.slice(0, 300), voiceId: agent.voice?.voiceId || '' })
  recordActivity({ agentId, agentName: agent.name, task: taskText, result: reply.slice(0, 300), ms: Date.now() - t0 })   // B
  return { agentId, agentName: agent.name, avatar: agent.avatar, role: agent.role, reply }
}

load()
