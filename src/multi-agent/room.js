// 多 Agent 军机处室 —— 共享会话 + 点名响应
// 皇上在军机处室发言 → 所有 Agent 在场；点名某位（名字/角色）→ 该 Agent 响应。
// 未点名时按话题/能力推断最相关的一位响应；都不确定则无人响应（皇上可再点名）。
import fs from 'fs'
import path from 'path'
import { getAgentConfig, getAllAgentConfigs } from './config.js'
import { runAgentEngine } from './engines.js'
import { remember, setSummary } from './memory.js'
import { recordActivity } from './ledger.js'
import { paths } from '../paths.js'
import { emitEvent } from '../events.js'
import { StateGraph } from './state-graph.js'

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
  } catch (e) { console.warn('[src/multi-agent/room.js] op failed:', e?.message || e) }
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
  try { fs.mkdirSync(path.dirname(ROOM_FILE), { recursive: true }); fs.writeFileSync(ROOM_FILE, JSON.stringify({ messages: history, round }), 'utf-8') } catch (e) { console.warn('[src/multi-agent/room.js] op failed:', e?.message || e) }
}
function push(msg) {
  // 长交付（worker 文档/报告可能到 8000 token）落历史时截断到 3000 字符，
  // 避免 12 条历史注入每个 agent 上下文时撑爆窗口；完整文档由文件/前端全文承载。
  history.push({ ...msg, content: String(msg.content || '').slice(0, 3000) })
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
// 关键词映射对齐当前办公室职能员工（agents.js），避免"财务→电脑操作"这类错位路由
function inferRelevantAgent(text) {
  const t = String(text || '')
  const roleMap = [
    // 技术实现 → 外部 Claude Code
    { re: /技术|开发|代码|架构|系统|接口|数据库|前端|后端|脚本|部署|机器人|设计|页面|界面|登录|网站|网页|app|软件|程序|编程|重构|测试|bug|修复|排查/g, id: 'claudecode', w: 1 },
    // 项目/排期/协调 → 外部 Hermes
    { re: /管理|协调|排期|进度|统筹|分工|资源|跨部门|组织|汇报|会议|教务|行政|文案|PPT|制度|招生|课程|项目/g, id: 'hermesagent', w: 1 },
    // 报表/财务/数据 → 报表统计（专属词加权，避免被"系统/电脑"等弱信号抢答）
    { re: /财务|预算|成本|报表|投资|经济|税|统计|数据|汇总|图表|口径|看板/g, id: 'libu', w: 2 },
    // 电脑/桌面/脚本 → 电脑操作
    { re: /电脑|操作|运行|桌面|本地|系统设置|安装|脚本|应用启动|进程/g, id: 'hubu', w: 1 },
    // 第三方/连接器/接口对接 → 应用调度
    { re: /第三方|连接|接口调用|对接|连接器|插件|app|集成/g, id: 'bingbu', w: 1 },
    // 检索/搜索/调研 → 检索专员（专属词加权）
    { re: /搜索|查找|检索|调研|查询|知识库|资料|核验|来源/g, id: 'xingbu', w: 2 },
    // 文件/归档/版本 → 文件管理
    { re: /文件|归档|文档|整理|版本|备份|目录|重命名|移动|复制/g, id: 'host', w: 1 },
    // 系统体检/诊断 → 系统体检员（专属词加权，避免被"系统/电脑"抢答）
    { re: /体检|诊断|磁盘|性能|电池|系统检查|大文件|垃圾|健康|cpu|内存占用|清理/g, id: 'tijian', w: 2 },
    // 全局决策/评审 → CEO
    { re: /统筹|协调|评审|复盘|分工|全局|决策|拍板|立项/g, id: 'gm', w: 1 },
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
export async function officeCommand(content, opts = {}) {
  const text = String(content || '').trim()
  if (!text) throw new Error('指令不能为空')
  // F2：图模式（opts.graph）→ 用状态图引擎跑办公室流程，支持 checkpoint/审批/回放
  if (opts.graph) return runOfficeGraph(text, opts)
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
  let ceoReply
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

  // 3. 分派工人执行 —— 并行（P2-22），并让外部全能顾问同场参与讨论。
  //    老板下任务时，Hermes/OpenHuman 参与讨论、制定方案、给意见（已被派为 worker 的顾问不重复发言）。
  const ADVISOR_IDS = ['hermesagent', 'openhuman']
  const advisors = ADVISOR_IDS.filter(id => getAgentConfig(id) && !workers.includes(id))
  const ceoPlan = String(ceoReply || '').replace(/\n?\s*\{\s*"workers"\s*:\s*\[[^\]]*\]\s*\}\s*$/, '').slice(0, 1500)

  const workerPromise = Promise.all(workers.map(async (wid) => {
    const worker = getAgentConfig(wid)
    if (!worker) return null
    emitEvent('office_progress', { agentId: wid, status: 'working', stage: 'executing', text, bubble: '⚙️ 收到任务，开始处理…' })
    const t0 = Date.now()
    try {
      const reply = await runAgentEngine(wid, getRoomHistory(MAX_HISTORY),
        `上级指令：「${text}」。CEO 已把属于你职责的部分交给你，请直接产出可执行交付。`, true)
      push({ role: 'agent', agentId: wid, agentName: worker.name, avatar: worker.avatar, content: reply, ts: new Date().toISOString() })
      if (worker.voice?.enabled) emitEvent('agent_tts', { agentId: wid, text: reply.slice(0, 300), voiceId: worker.voice?.voiceId || '' })
      emitEvent('office_progress', { agentId: wid, status: 'reporting', stage: 'done', text: '交付完成' })
      // B：台账记录（所有成功 worker 都记，含 host）
      recordActivity({ agentId: wid, agentName: worker.name, task: text, result: reply.slice(0, 300), ms: Date.now() - t0 })
      return { agentId: wid, agentName: worker.name, avatar: worker.avatar, role: worker.role, reply, worker }
    } catch (err) {
      recordActivity({ agentId: wid, agentName: worker.name, task: text, result: '（执行失败）' + err.message, ms: Date.now() - t0 })
      emitEvent('office_progress', { agentId: wid, status: 'idle', stage: 'idle', text: '—' })
      return { agentId: wid, agentName: worker.name, avatar: worker.avatar, role: worker.role, reply: '（执行失败：' + err.message + '）', error: true, verified: { verified: true, pass: false, verdict: '执行异常，无法验证交付' } }
    }
  }))

  // 外部全能顾问讨论：给出方案意见（与 worker 并行，不额外拖慢）
  const advisorPromise = Promise.all(advisors.map(async (aid) => {
    const adv = getAgentConfig(aid)
    if (!adv) return null
    emitEvent('office_progress', { agentId: aid, status: 'thinking', stage: 'advise', text: `讨论：${text}`, bubble: '🧭 参与讨论，制定方案…' })
    const t0 = Date.now()
    try {
      const reply = await runAgentEngine(aid, getRoomHistory(MAX_HISTORY),
        `老板下达任务：「${text}」。CEO 拆解的方案如下：\n${ceoPlan}\n请作为外部全能顾问参与讨论：给出你的方案意见、风险提示与补充建议（明确、可执行）。`, false)
      push({ role: 'agent', agentId: aid, agentName: adv.name, avatar: adv.avatar, content: reply, ts: new Date().toISOString() })
      if (adv.voice?.enabled) emitEvent('agent_tts', { agentId: aid, text: reply.slice(0, 300), voiceId: adv.voice?.voiceId || '' })
      emitEvent('office_progress', { agentId: aid, status: 'idle', stage: 'idle', text: '—' })
      recordActivity({ agentId: aid, agentName: adv.name, task: `【顾问】${text.slice(0, 80)}`, result: reply.slice(0, 300), ms: Date.now() - t0 })
      return { agentId: aid, agentName: adv.name, avatar: adv.avatar, role: adv.role, reply }
    } catch (err) {
      emitEvent('office_progress', { agentId: aid, status: 'idle', stage: 'idle', text: '—' })
      return { agentId: aid, agentName: adv.name, avatar: adv.avatar, role: adv.role, reply: '（顾问响应失败：' + err.message + '）', error: true }
    }
  }))

  const [workerResults, advisoryResults] = await Promise.all([workerPromise, advisorPromise])
  const workerReplies = workerResults.filter(Boolean)
  const advisoryReplies = advisoryResults.filter(Boolean)

  // 3.5 证据化验证（验货员核实产物）——并行执行，且验证本身已被 runInternal 的回合超时兜底，
  // 不再串行拖慢整条流水。文件管理(host) 验证自己的交付无意义，跳过。
  await Promise.all(workerReplies.map(async (r) => {
    if (r.error || r.agentId === 'host') return
    r.verified = await verifyDelivery(r.worker.name, text, r.reply)
  }))

  // 4. CEO 汇总（综合外部顾问意见 + 各成员交付）
  let ceoSummary
  try {
    emitEvent('office_progress', { agentId: 'gm', status: 'thinking', stage: 'summary', text: '汇总结果…' })
    const advisoryText = advisoryReplies.filter(r => r && !r.error && r.reply).map(r => `【${r.agentName}】${String(r.reply).slice(0, 3000)}`).join('\n')
    const workerText = workerReplies.map(r => `【${r.agentName}】${String(r.reply).slice(0, 4000)}`).join('\n')
    if (advisoryText || workerText) {
      ceoSummary = await runAgentEngine('gm', getRoomHistory(MAX_HISTORY),
        `上级指令：「${text}」。\n外部顾问意见：\n${advisoryText || '（无）'}\n\n各成员交付：\n${workerText || '（无）'}\n请综合顾问意见与交付结果，向用户汇报最终方案（总结要点、指出待确认事项）。`, true)
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

  return { ok: true, round, ceoReply, workerReplies, advisoryReplies, ceoSummary, workers }
}

// ── F2：办公室流程图模式 ───────────────────────────────────────────────
// 用状态图引擎（state-graph.js）跑「CEO 拆解 → 工人执行 → CEO 汇总」：
//   · checkpoint：每节点落盘 data/office-graph-checkpoints/<threadId>.json，可断点续跑
//   · approval：opts.approval 时，CEO 汇总前暂停等人工审批（resumeOfficeGraph 继续/驳回）
//   · audit：invoke 返回审计轨迹
// 说明：threadId 注册表在内存，跨进程重启后如需续跑需再传 threadId 重跑（图定义未持久化）。
const OFFICE_GRAPH_CP_DIR = () => path.join(paths.dataDir, 'office-graph-checkpoints')
const officeGraphs = new Map()   // threadId -> { app, text }

// ── 人工审批待办（借鉴 openhuman AttentionQueue：需要你处理的待审批）──
let pendingApprovals = []   // [{ threadId, node, text, ts }]
export function getPendingApprovals() {
  return pendingApprovals.slice()
}
function registerPendingApproval(threadId, node, text) {
  pendingApprovals = pendingApprovals.filter(a => a.threadId !== threadId)
  pendingApprovals.unshift({ threadId, node: String(node || ''), text: String(text || '').slice(0, 80), ts: new Date().toISOString() })
  try { emitEvent('office_approval', pendingApprovals[0]) } catch { /* event bus unavailable */ }
}
function clearPendingApproval(threadId) {
  pendingApprovals = pendingApprovals.filter(a => a.threadId !== threadId)
}

function finalizeOfficeGraph(text, state, threadId) {
  const ceoReply = state.ceoReply || ''
  const workerReplies = state.workerReplies || []
  const advisoryReplies = state.advisoryReplies || []
  const ceoSummary = state.ceoSummary || ceoReply || ''
  const workers = state.workers || []
  const workerName = state.workerName || ''
  if (ceoSummary && !/响应失败|失败/.test(ceoSummary)) {
    remember({ type: 'decision', agent: 'CEO', content: `指令「${text}」→ 分派 ${workerName} → 结论：${String(ceoSummary).slice(0, 500)}` }).catch(() => {})
  }
  recordActivity({ agentId: 'gm', agentName: getAgentConfig('gm')?.name || 'CEO', task: `【CEO】${text.slice(0, 100)}`, result: String(ceoSummary || ceoReply || '').slice(0, 300), ms: 0 })
  return { ok: true, graph: true, threadId, round: getMeetingRound(), ceoReply, workerReplies, advisoryReplies, ceoSummary, workers }
}

async function runOfficeGraph(text, opts = {}) {
  maybeNewSession()
  if (round >= MAX_ROUNDS) {
    return { ok: true, graph: true, forced_end: true, hint: `办公室已达 ${MAX_ROUNDS} 轮上限，本轮强制结束。可重置后重新派单。`, ceoReply: '', workerReplies: [], ceoSummary: '' }
  }
  round += 1
  push({ role: 'boss', content: `【上级指令】${text}`, ts: new Date().toISOString() })

  const g = new StateGraph({ checkpointDir: opts.checkpointDir || OFFICE_GRAPH_CP_DIR() })
  const ceo = getAgentConfig('gm')

  g.addNode('ceo_breakdown', async (_state) => {
    emitEvent('office_progress', { agentId: 'gm', status: 'thinking', stage: 'ceo', text: `拆解：${text}` })
    const ceoOptions = getAllAgentConfigs().filter(a => a.id !== 'gm').map(a => `${a.id}(${a.name})`).join('、')
    const reply = await runAgentEngine('gm', getRoomHistory(MAX_HISTORY),
      `收到上级指令：「${text}」。请你作为 CEO 决策者先拆解任务并点名参与的职能员工。
1) 用文字说明任务拆解与分工。
2) 在回复最末尾单独输出一行 JSON（只这一行，不要放进代码块）：{"workers":["员工id",...]}
   最多 3 个，只列真正需要的人；无需任何人可输出 {"workers":[]}。
可选员工 id：${ceoOptions}。`, false).catch(e => '（CEO 拆解失败：' + e.message + '）')
    push({ role: 'agent', agentId: 'gm', agentName: ceo.name, avatar: ceo.avatar, content: reply, ts: new Date().toISOString() })
    emitEvent('office_progress', { agentId: 'gm', status: 'reporting', stage: 'ceo_done', text: '拆解完成，分派中…' })
    let workers = extractCeoWorkers(reply)
    if (!workers.length) workers = inferOfficeWorkers(text)
    const workerName = workers.map(id => getAgentConfig(id)?.name || id).join('、')
    emitEvent('office_progress', { agentId: 'gm', status: 'reporting', stage: 'dispatch', text: `分派给：${workerName || '（无）'}` })
    return { ceoReply: reply, workers, workerName }
  })

  g.addNode('worker_execute', async (state) => {
    // P2-22：并行执行 worker，避免某个慢成员串行堵住整条流水（与 officeCommand 保持一致）。
    // 同时让外部全能顾问（Hermes/OpenHuman）参与讨论、给意见。
    const ADVISOR_IDS = ['hermesagent', 'openhuman']
    const advisors = ADVISOR_IDS.filter(id => getAgentConfig(id) && !(state.workers || []).includes(id))
    const ceoPlan = String(state.ceoReply || '').replace(/\n?\s*\{\s*"workers"\s*:\s*\[[^\]]*\]\s*\}\s*$/, '').slice(0, 1500)

    const workerPromise = Promise.all((state.workers || []).map(async (wid) => {
      const worker = getAgentConfig(wid)
      if (!worker) return null
      emitEvent('office_progress', { agentId: wid, status: 'working', stage: 'executing', text, bubble: '⚙️ 收到任务，开始处理…' })
      const t0 = Date.now()
      try {
        const reply = await runAgentEngine(wid, getRoomHistory(MAX_HISTORY),
          `上级指令：「${text}」。CEO 已把属于你职责的部分交给你，请直接产出可执行交付。`, true)
        push({ role: 'agent', agentId: wid, agentName: worker.name, avatar: worker.avatar, content: reply, ts: new Date().toISOString() })
        if (worker.voice?.enabled) emitEvent('agent_tts', { agentId: wid, text: reply.slice(0, 300), voiceId: worker.voice?.voiceId || '' })
        emitEvent('office_progress', { agentId: wid, status: 'reporting', stage: 'done', text: '交付完成' })
        recordActivity({ agentId: wid, agentName: worker.name, task: text, result: reply.slice(0, 300), ms: Date.now() - t0 })
        return { agentId: wid, agentName: worker.name, avatar: worker.avatar, role: worker.role, reply, worker }
      } catch (err) {
        recordActivity({ agentId: wid, agentName: worker.name, task: text, result: '（执行失败）' + err.message, ms: Date.now() - t0 })
        emitEvent('office_progress', { agentId: wid, status: 'idle', stage: 'idle', text: '—' })
        return { agentId: wid, agentName: worker.name, avatar: worker.avatar, role: worker.role, reply: '（执行失败：' + err.message + '）', error: true, verified: { verified: true, pass: false, verdict: '执行异常，无法验证交付' } }
      }
    }))

    const advisorPromise = Promise.all(advisors.map(async (aid) => {
      const adv = getAgentConfig(aid)
      if (!adv) return null
      emitEvent('office_progress', { agentId: aid, status: 'thinking', stage: 'advise', text: `讨论：${text}`, bubble: '🧭 参与讨论，制定方案…' })
      const t0 = Date.now()
      try {
        const reply = await runAgentEngine(aid, getRoomHistory(MAX_HISTORY),
          `老板下达任务：「${text}」。CEO 拆解的方案如下：\n${ceoPlan}\n请作为外部全能顾问参与讨论：给出你的方案意见、风险提示与补充建议（明确、可执行）。`, false)
        push({ role: 'agent', agentId: aid, agentName: adv.name, avatar: adv.avatar, content: reply, ts: new Date().toISOString() })
        if (adv.voice?.enabled) emitEvent('agent_tts', { agentId: aid, text: reply.slice(0, 300), voiceId: adv.voice?.voiceId || '' })
        emitEvent('office_progress', { agentId: aid, status: 'idle', stage: 'idle', text: '—' })
        recordActivity({ agentId: aid, agentName: adv.name, task: `【顾问】${text.slice(0, 80)}`, result: reply.slice(0, 300), ms: Date.now() - t0 })
        return { agentId: aid, agentName: adv.name, avatar: adv.avatar, role: adv.role, reply }
      } catch (err) {
        emitEvent('office_progress', { agentId: aid, status: 'idle', stage: 'idle', text: '—' })
        return { agentId: aid, agentName: adv.name, avatar: adv.avatar, role: adv.role, reply: '（顾问响应失败：' + err.message + '）', error: true }
      }
    }))

    const [workerResults, advisoryResults] = await Promise.all([workerPromise, advisorPromise])
    const workerReplies = workerResults.filter(Boolean)
    const advisoryReplies = advisoryResults.filter(Boolean)
    // 证据化验证：并行 + 文件管理(host) 不自验
    await Promise.all(workerReplies.map(async (r) => {
      if (r.error || r.agentId === 'host') return
      r.verified = await verifyDelivery(r.worker.name, text, r.reply)
    }))
    return { workerReplies, advisoryReplies }
  })

  g.addNode('ceo_summary', async (state) => {
    const workerReplies = state.workerReplies || []
    const advisoryReplies = state.advisoryReplies || []
    emitEvent('office_progress', { agentId: 'gm', status: 'thinking', stage: 'summary', text: '汇总结果…' })
    const advisoryText = advisoryReplies.filter(r => r && !r.error && r.reply).map(r => `【${r.agentName}】${String(r.reply).slice(0, 3000)}`).join('\n')
    const workerText = workerReplies.map(r => `【${r.agentName}】${String(r.reply).slice(0, 4000)}`).join('\n')
    let summary = state.ceoReply || ''
    if (advisoryText || workerText) {
      summary = await runAgentEngine('gm', getRoomHistory(MAX_HISTORY),
        `上级指令：「${text}」。\n外部顾问意见：\n${advisoryText || '（无）'}\n\n各成员交付：\n${workerText || '（无）'}\n请综合顾问意见与交付结果，向用户汇报最终方案（总结要点、指出待确认事项）。`, true).catch(e => '（CEO 汇总失败：' + e.message + '）')
    }
    push({ role: 'agent', agentId: 'gm', agentName: ceo.name, avatar: ceo.avatar, content: summary, ts: new Date().toISOString() })
    emitEvent('office_progress', { agentId: 'gm', status: 'idle', stage: 'complete', text: '—' })
    return { ceoSummary: summary }
  }, { approval: !!opts.approval })

  g.setEntry('ceo_breakdown')
  g.addEdge('ceo_breakdown', 'worker_execute')
  g.addEdge('worker_execute', 'ceo_summary')

  const app = g.compile()
  const threadId = opts.threadId || ('office-' + Date.now().toString(36))
  officeGraphs.set(threadId, { app, text })
  const r = await app.invoke({ content: text }, { threadId, onStep: opts.onStep })

  if (r.interrupted) {
    registerPendingApproval(threadId, r.waitingNode, text)
    return { ok: true, graph: true, interrupted: true, threadId, waitingNode: r.waitingNode, state: r.state || {} }
  }
  return finalizeOfficeGraph(text, r.state || {}, threadId)
}

// 人工审批 / 断点续跑：同意则继续跑完，驳回则停在该节点
export async function resumeOfficeGraph(threadId, { approved = true, note = '' } = {}) {
  const entry = officeGraphs.get(threadId)
  if (!entry) throw new Error(`未知办公室图线程: ${threadId}（请先以 graph:true 发起）`)
  clearPendingApproval(threadId)
  const r = await entry.app.resume(threadId, { approved, note })
  if (r.rejected) return { ok: true, graph: true, rejected: true, threadId, state: r.state || {}, note }
  if (r.resumed) return finalizeOfficeGraph(entry.text, r.state || {}, threadId)
  return { ok: true, graph: true, threadId, state: r.state || {}, note: '该线程无待审批任务' }
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

// ── 学 CrewAI：通用角色团队（runCrew）────────────────────────────────────
// 声明一个临时角色团队，复用现有 Agent，支持顺序（sequential）/ 层级（hierarchical）两种流程。
// spec:
//   roles: [{ agentId, prompt, expectedOutput? }]      团队角色与各自任务
//   process: 'sequential' | 'hierarchical'             顺序 / 层级
//   manager: 'gm'                                      层级流程的管理者（拆解+汇总）
//   inputs: { key: value }                             模板额外变量
// 模板占位：{objective}=总目标，{prev}=上一步输出，{...inputs}=自定义变量
function fillTemplate(tpl, vars) {
  let out = String(tpl || '')
  for (const [k, v] of Object.entries(vars || {})) out = out.replace(new RegExp('\\{' + k + '\\}', 'g'), String(v ?? ''))
  return out
}

export async function runCrew(spec = {}, content) {
  const objective = String(content || '').trim()
  if (!objective) throw new Error('objective 不能为空')
  const roles = Array.isArray(spec.roles) ? spec.roles : []
  if (!roles.length) throw new Error('roles 不能为空（至少一个角色）')
  const process = spec.process === 'hierarchical' ? 'hierarchical' : 'sequential'
  const managerId = String(spec.manager || 'gm')
  const ctx = getRoomHistory(MAX_HISTORY)
  const vars = { objective, prev: '', ...(spec.inputs || {}) }
  const results = []

  if (process === 'hierarchical') {
    // 1) 管理者拆解分工（要求输出 JSON assignments）
    const mgrCfg = getAgentConfig(managerId)
    const roster = roles.map(r => `${r.agentId}(${getAgentConfig(r.agentId)?.name || r.agentId})`).join('、')
    const decompose = await runAgentEngine(managerId, ctx,
      `你是团队管理者。针对目标「${objective}」，拆解任务并分派给团队成员（成员：${roster}）。` +
      '用文字说明分工，并在回复末尾单独输出一行 JSON：{"assignments":{"成员id":"给该成员的具体任务"}}，只列真正需要的成员；无需任何人则输出 {"assignments":{}}。', false)
    let assignments = {}
    try {
      const m = String(decompose).match(/\{[\s\S]*?"assignments"[\s\S]*?\}/)
      if (m) assignments = JSON.parse(m[0]).assignments || {}
    } catch (e) { console.warn('[src/multi-agent/room.js] op failed:', e?.message || e) }
    results.push({ agentId: managerId, agentName: mgrCfg?.name || managerId, role: '管理者·拆解', reply: decompose, assignments })
    // 2) 成员执行分派到的任务（没被点名的也按其 prompt 执行兜底）
    for (const r of roles) {
      const assigned = assignments[r.agentId]
      const taskText = assigned || fillTemplate(r.prompt || '完成：{objective}', vars)
      const t0 = Date.now()
      const reply = await runAgentEngine(r.agentId, ctx, taskText, true).catch(e => '（执行失败：' + e.message + '）')
      results.push({ agentId: r.agentId, agentName: getAgentConfig(r.agentId)?.name || r.agentId, role: r.expectedOutput || '成员', task: taskText, reply, ms: Date.now() - t0 })
      push({ role: 'agent', agentId: r.agentId, agentName: getAgentConfig(r.agentId)?.name || r.agentId, avatar: getAgentConfig(r.agentId)?.avatar || '', content: reply, ts: new Date().toISOString() })
      recordActivity({ agentId: r.agentId, agentName: getAgentConfig(r.agentId)?.name || r.agentId, task: taskText, result: reply.slice(0, 300), ms: Date.now() - t0 })
    }
    // 3) 管理者汇总
    const body = results.filter(x => x.reply && x.role !== '管理者·拆解').map(x => `【${x.agentName}】${x.reply}`).join('\n\n')
    const summary = await runAgentEngine(managerId, ctx, `汇总成员交付并汇报（要点+待确认项）：\n${body || '（无成员交付）'}`, true)
    results.push({ agentId: managerId, agentName: mgrCfg?.name || managerId, role: '管理者·汇总', reply: summary })
    push({ role: 'agent', agentId: managerId, agentName: mgrCfg?.name || managerId, avatar: mgrCfg?.avatar || '', content: summary, ts: new Date().toISOString() })
    recordActivity({ agentId: managerId, agentName: mgrCfg?.name || managerId, task: `【汇总】${objective.slice(0, 100)}`, result: summary.slice(0, 300), ms: 0 })
    return { ok: true, process, manager: managerId, objective, results }
  }

  // sequential：按序执行每个角色，前一步输出作为 {prev} 注入下一步
  for (const r of roles) {
    const cfg = getAgentConfig(r.agentId)
    if (!cfg) { results.push({ agentId: r.agentId, error: '未知 Agent', ok: false }); continue }
    vars.prev = results[results.length - 1]?.reply || ''
    const prompt = fillTemplate(r.prompt || '完成：{objective}', vars)
    const t0 = Date.now()
    const reply = await runAgentEngine(r.agentId, ctx, prompt, true).catch(e => '（执行失败：' + e.message + '）')
    results.push({ agentId: r.agentId, agentName: cfg.name, role: r.expectedOutput || cfg.role, prompt, reply, ms: Date.now() - t0, ok: true })
    push({ role: 'agent', agentId: r.agentId, agentName: cfg.name, avatar: cfg.avatar, content: reply, ts: new Date().toISOString() })
    recordActivity({ agentId: r.agentId, agentName: cfg.name, task: objective, result: reply.slice(0, 300), ms: Date.now() - t0 })
  }
  return { ok: true, process, objective, results }
}

load()

