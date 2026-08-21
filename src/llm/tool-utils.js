// tool-utils.js —— 工具循环纯函数（自 src/llm.js 拆出）
//
// 职责：工具参数归一化 / XML 工具调用解析 / 调用摘要 / 工具循环熔断判定 /
// nudge 文案构建 / closer 与媒体收尾识别 / TICK 去重证据等。全部为无状态纯函数，
// 不依赖 callLLM 的闭包状态，便于单独测试与复用。
import { getToolSchemas } from '../capabilities/schemas.js'
import { isToolForbiddenInStrictEvaluation } from '../runtime/strict-evaluation.js'
import { sanitizeAssistantReplyForDelivery } from '../runtime/markers.js'

// find_tool 命中后，把它返回的 loaded 工具 schema 原地追加进本轮 toolSchemas。
// 已在列表里的跳过；schema 取不到的跳过。数组原地 mutate —— 调用方传的是 callLLM 的 toolSchemas
// 引用，push 后下一轮 streamOnceWithRetry 自动带上这些新工具，模型即可直接调用。
export function injectFoundToolSchemas(result, toolSchemas, strictEvaluation = null, toolPromptHints = null) {
  try {
    const parsed = JSON.parse(result)
    const loaded = parsed?.loaded
    if (!Array.isArray(loaded) || loaded.length === 0) return
    const present = new Set(toolSchemas.map(s => s?.function?.name).filter(Boolean))
    for (const name of loaded) {
      if (typeof name !== 'string' || present.has(name)) continue
      if (isToolForbiddenInStrictEvaluation(strictEvaluation, name)) {
        console.log(`[find_tool] strict evaluation skipped forbidden tool → ${name}`)
        continue
      }
      const schema = getToolSchemas([name], { toolPromptHints })[0]
      if (schema) {
        toolSchemas.push(schema)
        present.add(name)
        console.log(`[find_tool] 装载工具 → ${name}`)
      }
    }
  } catch { /* 非 JSON 结果（如错误串）忽略 */ }
}

const PARAM_ALIASES = {
  send_message: { to: 'target_id', message: 'content', text: 'content', recipient: 'target_id' },
  read_file: { file: 'path', filename: 'path', filepath: 'path' },
  write_file: { file: 'path', filename: 'path', filepath: 'path', text: 'content', data: 'content' },
  list_dir: { directory: 'path', dir: 'path', folder: 'path' },
  make_dir: { directory: 'path', dir: 'path', folder: 'path' },
  delete_file: { file: 'path', filename: 'path' },
  exec_command: { cmd: 'command', shell: 'command', bg: 'background' },
  web_search: { q: 'query', keyword: 'query', keywords: 'query', search: 'query' },
  fetch_url: { link: 'url', href: 'url', uri: 'url' },
  browser_read: { link: 'url', href: 'url', uri: 'url' },
  search_memory: { q: 'keyword', query: 'keyword', term: 'keyword' },
}

export function normalizeArgs(toolName, args) {
  const aliases = PARAM_ALIASES[toolName]
  if (!aliases) return args
  const normalized = { ...args }
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (alias in normalized && !(canonical in normalized)) {
      normalized[canonical] = normalized[alias]
      delete normalized[alias]
    }
  }
  return normalized
}

// 从文本内容中解析 XML 格式的工具调用（MiniMax 有时输出 XML 而非 JSON tool_calls）
export function parseXmlToolCalls(content) {
  const calls = []
  const invokeRegex = /<invoke\s+name="([^"]+)">([\s\S]*?)<\/invoke>/g
  let match
  while ((match = invokeRegex.exec(content)) !== null) {
    const name = match[1]
    const body = match[2]
    const xmlArgs = {}
    const paramRegex = /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/g
    let param
    while ((param = paramRegex.exec(body)) !== null) {
      xmlArgs[param[1]] = param[2].trim()
    }
    calls.push({ id: `xml_${calls.length}`, name, arguments: JSON.stringify(xmlArgs), xmlArgs })
  }
  return calls
}

export function formatToolArgPreview(args = {}) {
  return Object.entries(args)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .slice(0, 3)
    .map(([key, value]) => `${key}=${String(value).slice(0, 80)}`)
    .join(', ')
}

export function summarizeToolCall(name, args = {}) {
  switch (name) {
    case 'send_message':
      return `send_message -> ${args.target_id || '(unknown)'}`
    case 'read_file':
      return `read_file(${args.path || args.filename || args.file_path || '?'})`
    case 'list_dir':
      return `list_dir(${args.path || args.dir || args.directory || '.'})`
    case 'web_search':
      return `web_search(${String(args.query || args.q || args.keyword || '?').slice(0, 80)})`
    case 'fetch_url':
      return `fetch_url(${String(args.url || args.link || args.href || '?').slice(0, 80)})`
    case 'browser_read':
      return `browser_read(${String(args.url || args.link || args.href || '?').slice(0, 80)})`
    case 'search_memory': {
      if (Array.isArray(args.keywords)) {
        return `search_memory([${args.keywords.slice(0, 4).map(k => String(k).slice(0, 20)).join(', ')}])`
      }
      return `search_memory(${String(args.keyword || args.query || args.q || '?').slice(0, 60)})`
    }
    case 'upsert_memory': {
      const n = Array.isArray(args.memories) ? args.memories.length : 0
      const ids = (args.memories || []).slice(0, 3).map(m => m?.mem_id || '?').join(', ')
      return `upsert_memory(${n} 条: ${ids}${n > 3 ? '…' : ''})`
    }
    case 'skip_recognition':
      return `skip_recognition(${String(args.reason || '').slice(0, 40)})`
    case 'manage_reminder':
    case 'schedule_reminder': {
      const action = args.action || 'create'
      if (action === 'list') return 'manage_reminder(list)'
      if (action === 'cancel') return `manage_reminder(cancel #${args.id || '?'})`
      const kind = args.kind || 'once'
      const when = kind === 'once' ? (args.due_at || '?') : `${kind} ${args.time || '?'}`
      return `manage_reminder(create ${when}: ${String(args.task || '?').slice(0, 30)})`
    }
    case 'manage_todo': {
      const action = args.action || 'list'
      if (action === 'list') return 'manage_todo(list)'
      if (action === 'complete') return `manage_todo(complete #${args.id || '?'})`
      if (action === 'delete') return `manage_todo(delete #${args.id || '?'})`
      if (action === 'update') return `manage_todo(update #${args.id || '?'})`
      return `manage_todo(add: ${String(args.title || '?').slice(0, 30)})`
    }
    case 'weekly_review': {
      const action = args.action || 'show'
      if (action === 'write') return `weekly_review(write ${args.week_key || '本周'})`
      if (action === 'list') return 'weekly_review(list)'
      return `weekly_review(show ${args.week_key || '本周'})`
    }
    case 'write_file':
      return `write_file(${args.path || args.filename || args.file_path || '?'})`
    case 'delete_file':
      return `delete_file(${args.path || args.filename || args.file_path || '?'})`
    case 'make_dir':
      return `make_dir(${args.path || args.dir || args.directory || '?'})`
    case 'exec_command':
      return `exec_command(${String(args.command || args.cmd || '?').slice(0, 80)})`
    default: {
      const preview = formatToolArgPreview(args)
      return preview ? `${name}(${preview})` : name
    }
  }
}

export function buildToolLogDetail(args = {}, result = '') {
  const argPreview = formatToolArgPreview(args)
  const resultPreview = String(result || '').replace(/\s+/g, ' ').trim().slice(0, 180)
  if (argPreview && resultPreview) return `${argPreview} | ${resultPreview}`
  return argPreview || resultPreview
}

export function makeDeferredOutboundResult(args = {}, latestOutbound = null) {
  const target = String(args.target_id || '')
  const sent = latestOutbound
    ? `The immediately preceding message to ${latestOutbound.targetId} was delivered at ${latestOutbound.sentAt}: “${latestOutbound.content.slice(0, 240)}”`
    : 'A preceding outbound message in this same model response was delivered.'
  return JSON.stringify({
    ok: false,
    tool: 'send_message',
    skipped: 'outbound_reconsideration_required',
    target_id: target,
    reason: `${sent} This additional message was planned before that delivery result existed, so it was not sent. Read the delivered-message fact and make a fresh, context-based decision in the next step; silence is the correct choice when nothing materially changed.`,
  })
}

const TICK_EVIDENCE_EXCLUDED_TOOLS = new Set([
  'send_message', 'express', 'set_tick_interval', 'set_task', 'complete_task',
  'recall_memory', 'search_memory', 'probe_memory', 'find_tool',
  'upsert_memory', 'skip_recognition', 'skip_consolidation', 'ui_set', 'voice_retire',
])

export function toolAddsTickEvidence(name, result) {
  return !TICK_EVIDENCE_EXCLUDED_TOOLS.has(name) && !isToolFailure(result)
}

export function buildTickRoundContext(tickState, toolRound) {
  if (!tickState) return ''
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - tickState.startedAtMs) / 1000))
  const lines = [
    `[outer heartbeat] TICK #${tickState.number} (${tickState.id}) is still active.`,
    `This is internal tool-loop round ${toolRound}, not heartbeat #${toolRound}. No new scheduler heartbeat has occurred; ${elapsedSeconds}s have elapsed continuously inside this one TICK.`,
    `Evidence revision in this TICK: ${tickState.evidenceVersion}. Tool results can be evidence, but they never create another heartbeat or make 10 seconds pass.`,
  ]
  if (tickState.outboundByTarget.size) {
    lines.push('Messages already delivered in this same TICK:')
    for (const item of tickState.outboundByTarget.values()) {
      lines.push(`- to ${item.targetId}, tool-loop round ${item.toolRound}, evidence revision ${item.evidenceVersion}: "${item.content.slice(0, 260)}"`)
    }
    lines.push('Do not relabel a tool-loop round as the next heartbeat. Another message to the same recipient requires concrete new evidence after the earlier delivery; otherwise conclude silently.')
  }
  return lines.join('\n')
}

export function makeSameTickNoEvidenceResult(args = {}, previousOutbound = null, tickState = null) {
  const previous = previousOutbound
    ? `A message to ${previousOutbound.targetId} was already delivered in tool-loop round ${previousOutbound.toolRound}: "${previousOutbound.content.slice(0, 240)}".`
    : 'A message to this recipient was already delivered in the current TICK.'
  return JSON.stringify({
    ok: false,
    tool: 'send_message',
    skipped: 'same_tick_no_new_evidence',
    target_id: String(args.target_id || ''),
    tick_id: tickState?.id || '',
    reason: `${previous} This is still the same outer TICK, not a later heartbeat. No qualifying new tool evidence has appeared since that delivery, so this message was not sent. End silently or first obtain and assess new evidence.`,
  })
}

export function buildPostSendNudge(outboundMessages = [], tickState = null) {
  const latest = outboundMessages.at(-1)
  if (!latest) {
    return 'Message sent. Default action: end the round now. Do not send another message unless genuinely new substantive information appears.'
  }
  return [
    'Communication reality check:',
    `You have already delivered this message to ${latest.targetId} at ${latest.sentAt}:`,
    `“${latest.content.slice(0, 500)}”`,
    tickState ? `This is still outer TICK #${tickState.number}; the send happened in tool-loop round ${latest.toolRound}.` : '',
    'The successful tool result means the message was received and shown to the user. If the user has not replied, that is only a pause; do not reinterpret silence as a missed or failed delivery, and do not retry the message for that reason.',
    'Treat that delivery as a completed fact, not an unfinished task. Compare the current evidence with what the recipient already knows before considering another message.',
    'Default action: end the round silently. Only send again if new external evidence, task progress, risk, or a new user message makes another message useful to the recipient.',
  ].filter(Boolean).join('\n')
}

export function shouldPersistActionLog(_toolName) {
  return false
}

// 仅剥离运行时协议标记（runtime 解析锚点，不是给用户看的内容）。与 index.js 的 fallback
// 剥离保持一致：去掉 <think>/<thinking> 块和 [RECALL:]/[SET_TASK:]/[CLEAR_TASK]/[UPDATE_PERSONA:]
// 文本标记后返回正文。内容本身不做客套裁剪 / 行去重 / 改写。
export function stripProtocolMarkersForDelivery(text) {
  // 单一真相源：src/runtime/markers.js。剥离语义（含末尾 trim）与原正则完全一致。
  return sanitizeAssistantReplyForDelivery(text)
}

export const TOOL_LOOP_LIMITS = {
  maxRounds: 100,
  maxTotalCalls: 30,
  maxConsecutiveFailures: 3,
  maxSameFailures: 2,
  loopWindowSize: 8,
  loopUniqueThreshold: 2,
  // 不确定回退（层 3，对应论文 ReAct→CoT-SC 的"在限定步数内没给出答案就退回推理"）：
  // 不是失败计数触发，而是"做了很多步还没给用户结果"这个非收敛信号触发。模型可能每步都
  // 成功却方向全错（论文实证 ReAct 推理错误率反而高于 CoT）——失败熔断永远抓不到这种。
  // 跨过这个步数还没投递，就软插一次"退一步重审计划/验证假设/如实汇报"的检查点（一 turn 一次）。
  // 阈值要避开健康任务：实测一个健康的 6 步 set_task 任务约用 14-16 次调用（含 update_task_step
  // 等记账），所以设 18——既不误伤正常多步任务，又在 maxTotalCalls(30) 硬上限前留出抓"真不收敛"的余量。
  uncertaintyCheckpointCalls: 18,
}

const HIGH_RISK_TOOLS = new Set([
  'delete_file',
  'exec_command',
  'kill_process',
  'web_search',
  'fetch_url',
  'browser_read',
  'speak',
  'generate_lyrics',
  'generate_music',
  'generate_image',
])

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function buildToolFingerprint(name, args = {}) {
  return `${name}:${stableStringify(args || {})}`
}

export function isHighRiskTool(name) {
  return HIGH_RISK_TOOLS.has(name)
}

const PARALLEL_SAFE_TOOLS = new Set([
  'read_file',
  'list_dir',
  'web_search',
  'fetch_url',
  'browser_read',
  'search_memory',
  'list_processes',
])

export function isParallelSafeTool(name, args = {}) {
  if (PARALLEL_SAFE_TOOLS.has(name)) return true
  if (name === 'manage_reminder') return args.action === 'list'
  if (name === 'manage_prefetch_task') return args.action === 'list'
  if (name === 'manage_todo') return args.action === 'list'
  if (name === 'weekly_review') return args.action === 'show' || args.action === 'list'
  return false
}

export function isToolFailure(result) {
  const text = String(result || '').trim()
  if (!text) return false
  try {
    const parsed = JSON.parse(text)
    if (parsed?.ok === false) return true
    if (parsed?.error && parsed.ok !== true) return true
    return false
  } catch (e) { console.warn('[src/llm/tool-utils.js] op failed:', e?.message || e) }
  return /^(错误|请求失败|执行失败|命令超时|命令执行失败|閿欒|璇锋眰澶辫触|鎵ц澶辫触|鍛戒护瓒呮椂|鍛戒护鎵ц澶辫触)/.test(text)
}

export function createToolLoopState() {
  return {
    totalCalls: 0,
    consecutiveFailures: 0,
    sameFailureCounts: new Map(),
    recentFingerprints: [],
  }
}

// send_message/express 是 agent 向用户"汇报 blocker"的唯一通道，必须绕开跨工具的全局熔断计数。
// 否则当 exec_command/fetch_url 等连续失败触发熔断后，agent 想 send_message 解释失败也会被一并挡掉，
// 出现"工具调不动 + 嘴也被堵住"的死锁（lessons-bailongma-silent-exit 的镜像问题）。
// 同指纹反复失败仍由 sameFailureCounts / recentFingerprints 拦截，安全网完好。
const REPORT_CHANNEL_TOOLS = new Set(['send_message', 'express'])

// ── 耗时工具即时回应 ──────────────────────────────────────────────────────────
// 模型执行任务型工具链时遵循"先把活干完再汇报"的惯性，在最慢的那步（下载/搜索/生成/
// 跑命令）之前不会主动 send_message，用户因此对着静默以为卡死（action_logs 实测坐实）。
// 这些工具一旦被调用，就由运行时在执行前替它"应一声"——一个 turn 只发一次（见 callLLM 的
// ackSent）。只覆盖真正会让人等的工具；秒回的普通问答不在此列，避免把简单对话变啰嗦。
const SLOW_ACK_TOOLS = new Set([
  'generate_image', 'generate_music', 'generate_lyrics',
  'web_search', 'fetch_url', 'browser_read', 'deep_research', 'exec_command',
])
export function isSlowAckTool(name, args) {
  if (name === 'music') return String(args?.action || '').trim() === 'download'  // 仅下载慢；search/list 秒回
  return SLOW_ACK_TOOLS.has(name)
}
export function slowAckText(name, args) {
  if (name === 'music') {
    const s = String(args?.title || args?.query || '').trim()
    return s ? `在找《${s}》了，稍等一下～` : '在找了，稍等一下～'
  }
  if (name === 'generate_image') return '在画了，稍等一下～'
  if (name === 'generate_music' || name === 'generate_lyrics') return '在创作了，稍等一下～'
  if (name === 'web_search' || name === 'fetch_url' || name === 'browser_read' || name === 'deep_research') {
    const q = String(args?.query || args?.q || args?.url || '').trim()
    return q ? `我查一下「${q.length > 30 ? q.slice(0, 30) + '…' : q}」～` : '我查一下～'
  }
  if (name === 'exec_command') return '我跑一下～'
  return '收到，我处理一下～'
}

// ── 播放收尾静音 ──────────────────────────────────────────────────────────────
// 音乐/视频播放是"开始时应一声（ack），放好之后不用再说"。但模型习惯在 media_mode 播放后
// 补一句"好了/在放了/播放中"——多余。本 turn 播放过媒体后，这类播放确认短消息会被运行时拦掉。
// 判定保守：只抓明确的播放确认词或极短回复，避免误伤"放歌顺便回答的实质信息"。
// 播放确认词：可能单独成句（"在播了。"），也可能带歌名前缀（"浮誇，在播了。"）。
// 用"包含匹配"而非整句锚定，并配合长度上限，既抓住带歌名的确认、又不误伤放歌后真正的实质回复。
// 只认明确的"正在播放"动词。泛化的"好的/好了"不放进来——纯"好了"已被 ≤6 字规则覆盖，
// 而"好的，帮你查一下…"这类带实质内容的回复不能被误吞成表情。
const MEDIA_CLOSER_RE = /(在播了?|在放了?|放好了?|放上了?|播放中|播放了|开始播放?|这就放|给你放|now playing|playing now)/i
export function isMediaCloser(content) {
  const s = String(content || '').trim()
  if (!s) return true
  if (s.length <= 6) return true                       // 极短回复（"在播了""好了"）
  return s.length <= 16 && MEDIA_CLOSER_RE.test(s)     // 带歌名的短确认（"浮誇，在播了。"）
}

export function getToolLoopStopReason(state, name, fingerprint) {
  const isReportChannel = REPORT_CHANNEL_TOOLS.has(name)
  if (!isReportChannel && state.consecutiveFailures >= TOOL_LOOP_LIMITS.maxConsecutiveFailures) {
    return `too many consecutive tool failures (${TOOL_LOOP_LIMITS.maxConsecutiveFailures})`
  }
  const sameFailures = state.sameFailureCounts.get(fingerprint) || 0
  if (sameFailures >= TOOL_LOOP_LIMITS.maxSameFailures) {
    return `same failing action repeated ${sameFailures} times`
  }
  const window = state.recentFingerprints.slice(-TOOL_LOOP_LIMITS.loopWindowSize)
  if (!isReportChannel && window.length >= TOOL_LOOP_LIMITS.loopWindowSize) {
    const unique = new Set(window).size
    if (unique <= TOOL_LOOP_LIMITS.loopUniqueThreshold) {
      return `stuck in a loop (only ${unique} unique action(s) in last ${TOOL_LOOP_LIMITS.loopWindowSize} calls)`
    }
  }
  return null
}

export function makeToolLoopStoppedResult(name, reason) {
  return JSON.stringify({
    ok: false,
    tool: name,
    error: 'tool loop stopped',
    reason,
    hint: 'Stop retrying this action. Explain the blocker, ask for confirmation, or choose a materially different approach.',
  }, null, 2)
}

export function recordToolLoopOutcome(state, name, fingerprint, result) {
  state.totalCalls += 1
  state.recentFingerprints.push(fingerprint)

  if (isToolFailure(result)) {
    state.consecutiveFailures += 1
    state.sameFailureCounts.set(fingerprint, (state.sameFailureCounts.get(fingerprint) || 0) + 1)
  } else {
    state.consecutiveFailures = 0
    state.sameFailureCounts.delete(fingerprint)
  }
}

export function buildToolLoopStopNudge(reason, lastToolResult) {
  const lastSummary = lastToolResult
    ? `${lastToolResult.name}(${formatToolArgPreview(lastToolResult.args || {})}) -> ${String(lastToolResult.result || '').slice(0, 300)}`
    : 'No successful tool result is available.'
  return `Tool loop safety stop: ${reason}.\nLast tool result:\n${lastSummary}\n\nStop repeating this action — and step back: the problem may be the plan, not just this one call. Do NOT retry the same approach. Choose one, in this order:\n1. Switch to a materially different approach — a different tool, a different angle, or different input.\n2. If you are unsure your assumption even holds, verify it with one read-only tool before acting again.\n3. If you set a task with set_task, re-read current_task and adjust the steps to match reality.\n4. If you are genuinely blocked, deliver your reply now (send_message on a social channel, or plain text on a local turn) and tell the user what you tried, what failed, and what you need — clearly, do not end silently.`
}

// 不确定回退的软检查点（层 3）：步数跨过阈值仍未投递时，一 turn 注入一次。
// 与 buildToolLoopStopNudge 的区别：后者是"反复失败/死循环"硬触发后才发，这条是在还没失败、
// 但"做了很多步没收敛"时就提前发——抓的是论文里"看似成功却方向错"的不确定态。措辞是引导反思
// （在 <think> 里诚实自问是否在收敛），不是命令停手。
export function buildUncertaintyCheckpointNudge(totalCalls) {
  return `You have run ${totalCalls} tool calls this turn and still have not delivered a result to the user. Pause for one beat — this many steps without converging is itself a signal. The issue may not be the current action; it may be the plan.\n\nIn <think>, ask yourself honestly: am I actually converging on the goal, or am I unsure and pushing forward anyway? Then pick one:\n- If the plan is off, re-read the goal (and current_task if you set one) and re-plan instead of adding more steps.\n- If you are not sure a previous step actually worked, verify it with one read-only tool rather than stacking more actions on an unverified assumption.\n- If you are genuinely stuck, tell the user what you have done, what is blocking you, and what you need — do not keep silently grinding.\nThis is a one-time internal checkpoint; do not narrate it to the user, just course-correct.`
}

// 中途纠正 nudge 是以 role:'user' 注入的，模型容易误当成"用户在说话"而生成一句面向用户的
// 反应（如"你说得对…"），把它当成回复发出去。所有这类内部纠正都追加这句，明确它是运行时内部
// 指令、不要向用户复述/道歉/引用——只管纠正动作。对齐 buildUncertaintyCheckpointNudge 的做法。
export const INTERNAL_NUDGE_SUFFIX = '\n\n(This is an internal runtime instruction, not a message from the user. Do not quote it, apologize for it, or mention it to the user — just produce the corrected action/reply.)'

// Closer pattern：短客套尾巴的语义指纹。专门用来识别"主回复发完后又补一条客套话"
// 这种反 pattern。NUDGE 措辞已经在告诉 LLM 不要这么干（[schemas.js One action, one message]
// + [llm.js sentMessage nudge]），但中文 LLM 训练里的尾巴反射太强，需要运行时安全网兜底。
//
// 判定要保守：宁可漏拦也不要误伤合法短回复（"好的"/"已开"/"下午3点"）。所以同时要求：
//   1. 长度 <= 30（closer 通常很短）
//   2. 命中以下任一 pattern（语义明确是客套尾巴，不是实质内容）
const CLOSER_PATTERNS = [
  /有(任何|什么)?(需要|问题|事|帮助).{0,8}(叫|找|说|呼|联系|来找|告诉)/,
  /随时(叫|找|说|呼|联系|来找|问).{0,5}我/,
  /(希望|但愿).{0,5}(对你|对您|能).{0,5}(帮助|有用|有所帮助)/,
  /(还有|其他).{0,3}(需要|问题|事|想知道|想了解|要补充|地方需要)/,
  /为(您|你).{0,5}(效劳|服务)/,
  /(祝|愿)(你|您|大家|各位).{1,15}/,
  /(明白|理解|清楚|懂)了?吗[!?！？。\s]*$/,
  /欢迎.{0,5}(随时|继续).{0,5}(问|交流|沟通|联系)/,
  /(如|若|要是).{0,3}(还|有|需要).{0,10}(可以|尽管|随时).{0,5}(问|告诉|找|叫)/,
  /^(feel free|let me know|happy to help|hope.{0,15}help)/i,
]

export function isCloserPattern(content) {
  const s = String(content || '').trim()
  if (!s) return false
  if (s.length > 30) return false
  return CLOSER_PATTERNS.some(re => re.test(s))
}
