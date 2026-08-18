// llm.js —— Agentic 工具循环主调用（callLLM）
// 拆分说明：流式调用层见 src/llm/stream.js；工具循环纯函数见 src/llm/tool-utils.js。
import { getToolCompressionConfig } from "./config.js"
import { executeTool } from "./capabilities/executor.js"
import { getToolSchemas } from "./capabilities/schemas.js"
import { validateToolArgs } from "./capabilities/tool-validator.js"
import { recordReflection, buildReflectionFromFailure } from "./memory/reflection.js"
import { insertActionLog } from "./db.js"
import { shouldThrottle } from "./quota.js"
import { isTerminalInternalToolRound } from "./runtime/tool-protocol.js"
import { beginTurn } from "./runtime/turn-trace.js"
import { createMergedAbortSignal, throwIfAborted } from "./capabilities/abort-utils.js"
import { filterStrictEvaluationTools, isToolForbiddenInStrictEvaluation, makeStrictForbiddenToolResult } from "./runtime/strict-evaluation.js"
import { actionContractToolSucceeded, containsUnsupportedCompletionClaim } from "./runtime/action-contract.js"
import { compressToolResultForModel, cleanupOldToolOutputs } from "./runtime/tool-result-compressor.js"
import { paths } from "./paths.js"
import { streamOnceWithModelFallback, buildChatCompletionRequestParams } from "./llm/stream.js"
import {
  injectFoundToolSchemas, normalizeArgs, parseXmlToolCalls, summarizeToolCall,
  buildToolLogDetail, makeDeferredOutboundResult, toolAddsTickEvidence, buildTickRoundContext,
  makeSameTickNoEvidenceResult, buildPostSendNudge, shouldPersistActionLog, stripProtocolMarkersForDelivery,
  isToolFailure, createToolLoopState, getToolLoopStopReason, makeToolLoopStoppedResult, recordToolLoopOutcome,
  buildToolLoopStopNudge, buildUncertaintyCheckpointNudge, INTERNAL_NUDGE_SUFFIX, isCloserPattern,
  isMediaCloser, slowAckText, isSlowAckTool, isParallelSafeTool, buildToolFingerprint, TOOL_LOOP_LIMITS,
} from "./llm/tool-utils.js"

// re-export：保持既有消费方（spawn.js / multi-agent/engines.js / test-complex-task.js 等）兼容
export { runSimpleCompletion } from "./llm/stream.js"
export { buildToolLoopStopNudge, buildUncertaintyCheckpointNudge } from "./llm/tool-utils.js"
export const __internals = { buildChatCompletionRequestParams }
// 设计决策（2026-06，第一性原理重构）：此处曾有三支"猜测模型在假装干活"的检测，现已全部删除：
//   1. detectFakeToolCall：扫模型正文、匹配工具名子串 → 判"嘴上说调了实际没调"
//   2. 假记忆检测：扫正文匹配"记住了/完成"关键词且没调 upsert_memory → 判假承诺
//   3. missingToolNudge：扫**用户**消息（requiresToolForRequest 的文件/命令/联网关键词）∧ !sawToolCall
//      → 判"用户要求了动作但模型没真正执行"，于是 allContent='' 抹掉答案 + 以 role:'user' 逼调工具
// 三者是同一个错的层：自由文本（无论模型的还是用户的）本身欠定"是否在断言/要求一次动作"。
// 第 3 支看似只读"真相信号 sawToolCall"，但它的另一半 requiresToolForRequest 仍是关键词扫描——
// "你有几个执行命令的工具""你会联网搜索吗"这类**关于工具的元问题**必然含"执行命令/搜索"等词，
// 于是被误判成动作请求。后果与前两支完全一致、且更隐蔽：它会 allContent='' 抹掉已成形（语音轮
// 甚至已经念出口）的正确答案，再以 role:'user' 追问，模型误以为被质疑，吐出"你说得对…"重答一遍
// ——用户那边就是"同一个问题被回答两遍、第二遍像重启"。详见 test-no-fake-tool-detection.js 场景 3。
//
// 真相源是运行时的工具日志（sawToolCall / toolCallLog），不是任何一方的散文。"该调没调"这件事

// 主调用：agentic 循环，连续执行工具直到模型停止
// 返回 { content: string, toolResult: { name, args, result } | null, aborted: bool }
//
// silentSignal: 本轮是否是 silent 系统信号（如 APP_SIGNAL: confirm_security_change /
//   cancel_security_change / app:saveState 等）。silent turn 本质是"系统在悄悄
//   refresh agent 的上下文"，**不**期望模型回复用户。当 silentSignal=true 时，
//   runtime 直接拦截 send_message 调用（不让它真投递），并在工具结果里告知
//   "本轮是 silent 系统信号，不要 send_message"，让模型从这次拒绝里学到边界。
export async function callLLM({ systemPrompt, message, messages: inputMessages = null, temperature = 0.5, topP = 0.9, tools = [], maxTokens, thinking = true, signal, onToolCall, onToolExecute, onStream, onRetry, toolContext = {}, mustReply = false, silentSignal = false, localReply = false, _streamOnceForTest = null, _executeToolForTest = null }) {
  const strictEvaluation = toolContext?.strictEvaluation || null
  const toolPromptHints = toolContext?.toolPromptHints || null
  const actionContract = toolContext?.actionContract || null
  const toolSchemas = getToolSchemas(filterStrictEvaluationTools(tools, strictEvaluation), { toolPromptHints })

  // 本地渠道（语音 / TUI）下纯文本即回复：模型直接产出 text 就算回复，runtime 协议兜底会替它
  // 真正投递（含语音 TTS）。社交渠道（微信/Discord/飞书/企微）必须显式 send_message 才能送达外部平台。
  // 这条 deliverInstruction 决定各处催补 nudge 该让模型"写纯文本"还是"调 send_message"——
  // 本地走纯文本能省掉 send_message 那一整轮额外 LLM 调用（send_message 后还要再跑一轮才收尾），
  // 这正是语音响应慢的主因。
  const deliverInstruction = localReply
    ? 'give the user your final reply now as plain text — in this local channel your message text reaches the user directly (and is spoken aloud on voice), you do NOT need to call send_message'
    : 'call send_message now to deliver your final reply to the user'

  // Only a user-authored turn has a plain-text reply body by protocol. During a
  // heartbeat, ordinary text is private working output; the model must call
  // send_message when it independently decides to communicate. Do not infer
  // external intent from heartbeat prose or manufacture a fallback send.
  const allowPlainTextFallback = Boolean(mustReply && toolContext?.outputContract !== 'explicit_send_only')
  const runTool = _executeToolForTest || executeTool
  const tickState = toolContext?.tickContext
    ? {
        id: String(toolContext.tickContext.id || 'tick'),
        number: Number(toolContext.tickContext.number) || 0,
        startedAtMs: Number(toolContext.tickContext.startedAtMs) || Date.now(),
        evidenceVersion: 0,
        outboundByTarget: new Map(),
      }
    : null

  const messages = Array.isArray(inputMessages) && inputMessages.length > 0
    ? inputMessages.map(item => ({ ...item }))
    : [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message }
      ]

  if (shouldThrottle()) {
    console.log('[配额] 用量超过 95%，跳过本次调用')
    return { content: '（配额接近上限，等待窗口滚动）', toolResult: null, aborted: false, delivered: false }
  }

  // 回合上下文追踪：把本 turn 每一轮模型看到的 messages[] 与思考/输出原样记下，供 /turn-trace
  // 后台逐回合回放（专为排查"agent 把自己的话和用户的话搞混"这类生成层问题）。永不影响主流程。
  const trace = beginTurn({
    label: toolContext?.currentChannel || (silentSignal ? 'silent' : (mustReply ? 'turn' : 'background')),
    channel: toolContext?.currentChannel,
    fromId: toolContext?.currentExternalPartyId || toolContext?.currentTargetId,
    targetId: toolContext?.currentTargetId,
    userMessage: toolContext?.currentUserMessage || (typeof message === 'string' ? message : ''),
    silentSignal,
    localReply,
    mustReply,
    outputContract: toolContext?.outputContract || (mustReply ? 'user_reply' : 'internal'),
    tools,
  })

  let allContent = ''
  // 可挽救草稿：社交渠道第一轮已写出一条完整回复、但还没 send_message 投递时，nudge 会把它从 allContent
  // 挪进 messages 并清空 allContent（期望下一轮包 send_message 重发）。一旦下一轮 provider 卡死/被 watchdog
  // 掐断，allContent 已空、草稿就丢了——「你有意识吗」事故正是如此。这里把草稿原文留一份，
  // 作为协议兜底投递的内容来源（仅在 !delivered 时使用，不会和正常投递双发）。
  let salvageableReply = ''
  let lastToolResult = null
  let sawToolCall = false
  let sentMessage = false
  let toolDeliveredFinalReply = false
  // delivered 语义：本次 callLLM 调用中是否**真正投递过**至少一条回复给用户。
  //   = 「≥1 次未被 silent / closer 拦截、且未熔断的 send_message 执行过」。
  //   这是"用户到底有没有收到实质回复"的**单一权威信号**，调用方不准再从 toolCallLog 二次推导。
  //   注意与 sentMessage 区分：sentMessage 是"最后一个动作是不是 send_message"（用于内部补刀 nudge），
  //   delivered 是"整轮有没有发出去过"（用于决定要不要兜底）。closer 被拦时主回复通常已把 delivered 置 true。
  let delivered = false
  let finalNudgeUsed = false
  let plainTextReplyNudgeUsed = false
  let emptyReplyNudgeUsed = false
  // `delivered` only means the reply reached a person. These two flags carry
  // the separate question: did a real tool produce evidence for the requested
  // external effect?
  let actionContractSatisfied = false
  let actionContractAttempted = false
  let actionContractNudgeCount = 0
  let actionClaimNudgeUsed = false
  // 层 3：本 turn 是否已发过"不确定回退"软检查点（一 turn 一次，见 buildUncertaintyCheckpointNudge）。
  let uncertaintyNudgeUsed = false
  const toolLoopState = createToolLoopState()
  // Turn-level send_message 历史：target_id → [{ length, isCloser }]。
  // 用于 closer dedup 安全网：当 LLM 在已经发过实质消息后又试图补一条短客套尾巴
  // ("有需要随时叫我"/"希望对你有帮助"/...) 时，运行时直接拦截这次 send_message 调用，
  // 返回 ok:false 让 LLM 在下一轮看到"你刚才那次 send_message 是 closer，已被合并丢弃"，
  // 强制它学会一次说完。误判风险通过 isCloserPattern 的保守判定（必须长度<=30 + 匹配明确尾巴
  // 模式）+ "已发实质消息"前置条件（length>=15 且非 closer）控制——纯短回复"好的"/"已开"
  // 不命中 pattern，不会被误拦。
  const turnSendHistory = new Map()
  // Facts about messages that were actually delivered in this callLLM run. These
  // are injected after every tool round so the next model decision starts from
  // reality rather than from an intention to send.
  const outboundMessages = []
  // 本 turn 是否已替模型"应过一声"（耗时工具即时回应）——保证一个 turn 只发一次。
  let ackSent = false
  // 本 turn 是否播放过音乐/视频——之后模型补的播放确认短收尾会被改成单个表情（"放好不用说"，
  // 但发送本身允许，避免 UI 显示"失败"；语音模式下纯表情不会被念出来）。
  let mediaPlayed = false
  let mediaPlayedKind = null   // 'music' | 'video'，决定用哪个表情
  let mediaEmojiSent = false   // 本 turn 已用表情代替过一次播放确认（一个 turn 只发一个表情）

  try {
  for (let round = 0; round < TOOL_LOOP_LIMITS.maxRounds; round++) {
    throwIfAborted(signal)

    if (tickState) {
      messages.push({ role: 'user', content: buildTickRoundContext(tickState, round) })
    }
    // 本轮开始时 messages 的长度 = 本轮模型看到的上下文边界。messages 在一个 turn 内严格
    // append-only，所以前端用 final messages.slice(0, inputOffset) 即可精确还原"本轮看到了什么"。
    const roundInputOffset = messages.length

    let roundResult
    try {
      roundResult = _streamOnceForTest
        ? await _streamOnceForTest({
            messages,
            toolSchemas,
            temperature,
            topP,
            maxTokens,
            thinking,
            signal,
            onRetry,
            onStream,
            round,
          })
        : await streamOnceWithModelFallback({
            messages,
            toolSchemas,
            temperature,
            topP,
            maxTokens,
            thinking,
            signal,
            onRetry,
            onStream,  // 所有轮次均流式推送，让 UI 实时反映工具链执行过程中的模型输出
          })
    } catch (err) {
      // 只要**前面的轮次已攒到可投递的回复**（典型：社交渠道第一轮已出答案、第二轮包 send_message 时
      // provider 卡死/报错，甚至重试退避期间被 watchdog 掐），就不能让这个错误/中止把已生成的答案一起
      // 带走——跳出循环走下方协议兜底投递（aborted 时它会用全新 signal 投递）。allContent 此刻可能已被
      // nudge 清空，故同时认 salvageableReply。两者皆空才无可挽救，照旧上抛（含真正的 AbortError）。
      if (allContent.trim() || salvageableReply.trim()) {
        console.warn(`[LLM] 轮内请求中断/失败(${(err?.message || String(err)).slice(0, 80)})，已有可投递回复 —— 跳出走兜底投递`)
        break
      }
      throw err
    }
    const { content, reasoningContent, toolCalls, aborted } = roundResult

    trace.recordRound({ round, inputOffset: roundInputOffset, content, reasoningContent, toolCalls, aborted })

    // 跨轮累积 content 时的去重保护：如果新段已经是 allContent 末尾的字面重复，
    // 跳过追加，避免 [Round N: "X"] + [Round N+1: "X"] 拼成 "X\nX"。
    // 这是模型在 nudge 后重复生成时的最后一道防线（主要修复见 finalNudge 分支）。
    const appendContent = (next) => {
      if (!next) return
      const trimmed = String(next).trim()
      if (!trimmed) return
      if (allContent && allContent.trim().endsWith(trimmed)) return
      allContent += (allContent ? '\n' : '') + next
    }

    if (aborted) {
      appendContent(content)
      break
    }

    appendContent(content)

    // 若无 JSON 工具调用，尝试从内容中解析 XML 格式工具调用（MiniMax 备用格式）
    let effectiveToolCalls = toolCalls
    if (toolCalls.length === 0 && content) {
      const xmlCalls = parseXmlToolCalls(content)
      if (xmlCalls.length > 0) {
        console.log(`[工具调用] 检测到 XML 格式工具调用，共 ${xmlCalls.length} 个`)
        effectiveToolCalls = xmlCalls
        // 从 allContent 中去掉 XML 调用块，避免污染 response
        allContent = allContent.replace(/<invoke[\s\S]*?<\/invoke>/g, '').trim()
      }
    }

    // 无工具调用：本轮结束；若工具后空回复，再补一轮明确的最终回复指令。
    if (effectiveToolCalls.length === 0) {
      // Do not infer an action from prose.  A clear action request carries a
      // narrow contract from runTurn, and it is satisfied only by a successful
      // matching tool result.  This deliberately runs before the normal local
      // plain-text fast path so TUI/voice cannot turn “我已经做好了” into the
      // only observable outcome.
      if (mustReply && actionContract && !actionContractSatisfied && !actionContractAttempted) {
        if (actionContractNudgeCount < 2) {
          if (content) messages.push({ role: 'assistant', content })
          allContent = ''
          actionContractNudgeCount += 1
          messages.push({
            role: 'user',
            content: `This user explicitly asked you to ${actionContract.label}. No matching action has actually run. Text, plans, promises, and send_message do NOT satisfy this request. Call one appropriate real action tool now: ${actionContract.requiredTools.join(', ')}. Only after a successful tool result may you say the action is complete. If the action truly cannot be performed, make one relevant attempt and then explain the concrete blocker. Do not repeat this instruction or quote the draft to the user.${INTERNAL_NUDGE_SUFFIX}`,
          })
          continue
        }

        // The provider kept declining to issue an action call. Do not release
        // its completion-sounding draft as if it were a result.
        allContent = `我还没有完成「${actionContract.label}」：本轮没有发起所需的实际操作。`
        break
      }

      // A matching tool was attempted but failed. A model is allowed to report
      // that failure, but it must not turn the error into a success claim.
      if (mustReply && actionContract && actionContractAttempted && !actionContractSatisfied
          && containsUnsupportedCompletionClaim(allContent) && !actionClaimNudgeUsed) {
        if (content) messages.push({ role: 'assistant', content })
        allContent = ''
        actionClaimNudgeUsed = true
        messages.push({
          role: 'user',
          content: `The requested action (${actionContract.label}) has no successful tool evidence. Your previous wording sounded like completion. Reply truthfully from the tool result: state the failure or limitation, and do not say it is done/created/saved/opened/installed/executed.${INTERNAL_NUDGE_SUFFIX}`,
        })
        continue
      }

      // 用户消息回复但只产出了 plain text，完全没调任何工具（包括 send_message）。
      //
      // 与 finalNudge 的区别：finalNudge 处理"调过工具但最后没补 send_message"（sawToolCall=true），
      // 本 nudge 处理"完全不经过工具就直接输出 text content 当作回复"（sawToolCall=false）。
      //
      // 不修复也能跑（主循环的 deliverFallbackReply 会把 content 投递出去），但 LLM 会逐渐
      // 失去"回复 = 调 send_message 工具"的反射，越来越依赖 fallback。这条 nudge 引导它回到
      // 正确的工具范式，同时保留 fallback 作最后一道兜底。
      // localReply 守卫：本地渠道下纯文本就是回复（兜底会真正投递），不能再催它补 send_message——
      // 那会逼出一整轮多余的 LLM 调用，正是要消除的延迟来源。只有社交渠道才需要这条 nudge。
      if (!localReply && mustReply && !sawToolCall && !sentMessage && allContent.trim() && !plainTextReplyNudgeUsed) {
        const draft = allContent.trim()
        salvageableReply = draft   // 清空 allContent 前留一份，供下一轮失败时兜底投递
        if (content) messages.push({ role: 'assistant', content })
        allContent = ''
        messages.push({
          role: 'user',
          content: `You produced reply text but did NOT call the send_message tool. Plain assistant text in this runtime is only debug exhaust — it does not reach the user through the normal channel. To actually deliver the reply you must wrap it in a send_message tool call.\n\nYour draft was:\n"""\n${draft.slice(0, 1000)}\n"""\n\nCall send_message now with target_id = the user who sent the previous message and content = the same text (or a tightened version). Do not write more prose this turn — only invoke the tool.${INTERNAL_NUDGE_SUFFIX}`,
        })
        plainTextReplyNudgeUsed = true
        continue
      }
      // 注：原"伪工具调用检测""假记忆声称检测""missingToolNudge"三支已全部删除——它们都靠扫
      // 模型正文或用户输入的关键词来猜动作，必然误伤"列出你的工具""你有几个执行命令的工具"这类
      // 正确回答/元问题（详见文件上方 INTERNAL_NUDGE_SUFFIX 前的设计决策注释）。
      // 安全网：工具已结束、最近一次工具不是 send_message、且模型本轮也没继续动作。
      // 不再用 !allContent.trim() 做守卫——跨轮累积的旁白会让这个守卫错误地静默 break，
      // 真正可靠的信号是 sentMessage（line 691 在每个工具后维护）。
      // mediaPlayed：本 turn 播放了音乐/视频时，不催模型补"最终回复"——播放类操作放好就结束，
      // 开场已替它 ack 过；催补尾只会逼出多余的"好了"。
      // localReply 且已有可投递正文：纯文本就是回复，直接收尾走兜底投递，不再多催一轮。
      if (localReply && mustReply && sawToolCall && !sentMessage && allContent.trim()) {
        break
      }
      if (mustReply && sawToolCall && !sentMessage && !finalNudgeUsed && !mediaPlayed) {
        // 关键修复：把上一轮的 assistant text 推入 messages，让模型在下一轮知道"自己刚才说过 X"。
        // 否则模型被 nudge 后会重新生成一段近似内容，叠加进 allContent 导致 fallback 投递出双段重复。
        // 同时清空 allContent，避免本轮的旁白和下一轮的回复被拼起来当一条消息发出。
        if (content) messages.push({ role: 'assistant', content })
        allContent = ''
        messages.push({
          role: 'user',
          content: `Tool results have returned, but you have not given the user a final reply yet. Based on the available tool results, ${deliverInstruction}. If information is insufficient, explain what was found, the failure source, and the limitations; do not end silently.${localReply ? '' : ' Do NOT repeat what you just wrote in plain text — wrap your reply in a send_message call.'}${INTERNAL_NUDGE_SUFFIX}`,
        })
        finalNudgeUsed = true
        continue
      }
      if (mustReply && !sentMessage && !allContent.trim() && !emptyReplyNudgeUsed) {
        messages.push({
          role: 'user',
          content: `You ended this user-message turn without producing any reply. You must now ${deliverInstruction}, with a brief, useful response. If no tools are needed, answer directly. Do not end silently.${INTERNAL_NUDGE_SUFFIX}`,
        })
        emptyReplyNudgeUsed = true
        continue
      }
      break
    }
    sawToolCall = true

    // 为没有 id 的工具调用分配 id（保证 assistant 消息与 tool 消息 id 一致）
    effectiveToolCalls.forEach((tc, i) => { if (!tc.id) tc.id = `tool_${round}_${i}` })

    // 执行所有工具调用，收集结果。
    // 同一轮中连续的只读/查询类工具互不依赖，可以并发跑；有副作用的工具仍保持顺序。
    const toolResults = []
    let toolLoopStopReason = null
    const prepareToolCall = (tc) => {
      throwIfAborted(signal)
      let args
      try { args = JSON.parse(tc.arguments || '{}') } catch { args = {} }
      const hadEmptyArguments = !tc.arguments || tc.arguments === '{}'
      const normalizedArgs = normalizeArgs(tc.name, args)
      const fingerprint = buildToolFingerprint(tc.name, normalizedArgs)
      const stopReason = getToolLoopStopReason(toolLoopState, tc.name, fingerprint)
      // 运行时参数校验（必需参数缺失/类型错误）——见 tool-validator.js
      const validation = validateToolArgs(tc.name, normalizedArgs)
      return { tc, normalizedArgs, fingerprint, stopReason, hadEmptyArguments, validation }
    }

    const runPreparedToolCall = async ({ tc, normalizedArgs, fingerprint, stopReason, hadEmptyArguments, validation }) => {
      console.log(`[工具调用] ${tc.name}`)
      if (hadEmptyArguments) {
        console.log(`[工具警告] ${tc.name} 参数为空`)
      }
      let result
      let outboundSent = false
      let closerSuppressed = false
      let silentSignalSuppressed = false
      let mediaCloserSuppressed = false
      let strictSuppressed = false
      let actionContractSendSuppressed = false
      if (stopReason) {
        result = makeToolLoopStoppedResult(tc.name, stopReason)
        console.log(`[工具熔断] ${tc.name}: ${stopReason}`)
        // 熔断信号已经回传给模型，重置跨工具的全局连续失败计数，让 agent 有机会切换到完全不同的工具
        // （比如换 read_file 查日志、search_memory 找历史经验）。同指纹反复失败仍由 sameFailureCounts
        // 拦截，跨工具死循环仍由 recentFingerprints 的 unique threshold 拦截——安全网未失效。
        toolLoopState.consecutiveFailures = 0
        // Reflexion：工具熔断是真实失败模式，沉淀反思（fire-and-forget，不阻塞工具循环）
        try {
          const reflection = buildReflectionFromFailure({
            tool: tc.name,
            reason: stopReason,
            lesson: '不要重复同一失败方法；换工具/换思路，或向用户说明阻塞',
          })
          const taskText = typeof toolContext.getTaskState === 'function'
            ? String(toolContext.getTaskState()?.task || '')
            : ''
          recordReflection({ content: reflection, task: taskText, tags: [`tool:${tc.name}`] })
        } catch {}
      } else if (validation && !validation.ok) {
        // P2：工具参数运行时校验失败——返回结构化错误引导模型修正（计入熔断计数防死循环）
        result = JSON.stringify({
          ok: false,
          tool: tc.name,
          skipped: 'invalid_arguments',
          errors: validation.errors,
          hint: '工具参数不合法：请根据 schema 修正后重试。若某项确实无法提供，向用户说明缺失项，而不是硬造参数。',
        })
        recordToolLoopOutcome(toolLoopState, tc.name, fingerprint, result)
        console.log(`[tool-validator] ${tc.name} 参数校验失败: ${validation.errors.join('; ')}`)
      } else if (isToolForbiddenInStrictEvaluation(strictEvaluation, tc.name)) {
        strictSuppressed = true
        result = makeStrictForbiddenToolResult(tc.name, strictEvaluation)
        recordToolLoopOutcome(toolLoopState, tc.name, fingerprint, result)
        console.log(`[strict evaluation] 拦截 forbidden tool ${tc.name}`)
      } else {
        const priorTickOutbound = tc.name === 'send_message'
          ? tickState?.outboundByTarget.get(normalizedArgs.target_id)
          : null
        if (priorTickOutbound && priorTickOutbound.evidenceVersion === tickState.evidenceVersion) {
          result = makeSameTickNoEvidenceResult(normalizedArgs, priorTickOutbound, tickState)
          recordToolLoopOutcome(toolLoopState, tc.name, fingerprint, result)
          console.log(`[same TICK outbound] blocked repeat to ${normalizedArgs.target_id} without new evidence`)
        } else {
        // Silent system signal 拦截：本轮是 silent APP_SIGNAL（如 confirm_security_change /
        //   cancel_security_change / app:saveState 等），系统只是在悄悄 refresh agent 上下文，
        //   不期望模型回复用户。模型如果违反这个约束调 send_message → 直接拒绝，让它从工具
        //   结果里学到"silent 信号 = 不需要 send_message"。
        //   优先于 closer dedup —— silent 拦截范围更广，连实质性消息也拦。
        if (silentSignal && tc.name === 'send_message') {
          silentSignalSuppressed = true
        }

        // Closer dedup 安全网：本 turn 内对同一 target 已发过实质消息（length>=15 且非 closer）
        // 后，再发"客套尾巴"短消息（命中 CLOSER_PATTERNS）直接拦截，不真正投递。LLM 在下一轮
        // 看到 ok:false + reason 学到不能这么干，且不累加 consecutiveFailures（这是 by design
        // 拒绝，不算失败）。判定保守 —— "好的"/"已开"/"下午3点" 都不匹配 CLOSER_PATTERNS。
        if (!silentSignalSuppressed && tc.name === 'send_message') {
          const target = normalizedArgs.target_id
          const content = String(normalizedArgs.content || '')
          if (target && isCloserPattern(content)) {
            const history = turnSendHistory.get(target) || []
            if (history.some(h => !h.isCloser && h.length >= 15)) {
              closerSuppressed = true
            }
          }
        }

        // 播放收尾：本 turn 已经播放过音乐/视频（开场也已替它 ack 过），模型若再补一句播放确认
        // 短消息（"好了"/"在放了"/"播放中"…）——不直接拦成"失败"，而是把内容换成一个表情照常发出：
        // 既不啰嗦、UI 显示成功，语音模式下纯表情也不会被 TTS 念出来。一个 turn 只发一个表情，
        // 多余的才真正拦掉。判定保守见 isMediaCloser。
        if (!silentSignalSuppressed && !closerSuppressed && tc.name === 'send_message'
            && mediaPlayed && isMediaCloser(String(normalizedArgs.content || ''))) {
          if (mediaEmojiSent) {
            mediaCloserSuppressed = true
          } else {
            normalizedArgs.content = mediaPlayedKind === 'video' ? '🎬' : '🎵'
            mediaEmojiSent = true
          }
        }

        // On external channels send_message is itself a side effect, and used
        // to let a premature “done” message terminate the whole agent loop.
        // Suppress it until the requested action has evidence; after a failed
        // attempt, allow only an honest failure report.
        const actionContractBlocksSend = tc.name === 'send_message'
          && actionContract
          && !actionContractSatisfied
          && (!actionContractAttempted || containsUnsupportedCompletionClaim(normalizedArgs.content))
        if (actionContractBlocksSend) {
          actionContractSendSuppressed = true
          result = JSON.stringify({
            ok: false,
            tool: 'send_message',
            skipped: 'action_contract_unmet',
            reason: `The requested action (${actionContract.label}) has no successful matching tool result. Do the action first; do not send a completion claim as a substitute.`,
          })
          console.log(`[action contract] suppressed premature send_message for ${actionContract.id}`)
        } else if (silentSignalSuppressed) {
          result = JSON.stringify({
            ok: false,
            tool: 'send_message',
            skipped: 'silent_system_signal',
            reason: 'This turn was triggered by a silent system signal (e.g. a confirm/cancel from a UI card, or an internal context refresh) — the user is NOT waiting for a reply. The runtime suppressed this send_message. Do not call send_message in silent signal turns; use this turn only to update internal state (memory, focus, task). The user already sees the result through the UI / next time you reply.',
          })
          console.log(`[silent signal] 拦截 send_message → ${normalizedArgs.target_id}: ${String(normalizedArgs.content || '').slice(0, 30)}`)
        } else if (closerSuppressed) {
          result = JSON.stringify({
            ok: false,
            tool: 'send_message',
            skipped: 'closer_dedup',
            reason: 'You already sent the main reply to this user in this turn. This second message is a closing pleasantry (e.g. "有需要随时叫我", "希望对你有帮助") with no new information — the runtime suppressed it. Do not split a closer into a second send_message; merge it into the main reply or omit entirely, and end the round.',
          })
          console.log(`[closer dedup] 拦截 send_message → ${normalizedArgs.target_id}: ${String(normalizedArgs.content || '').slice(0, 30)}`)
        } else if (mediaCloserSuppressed) {
          result = JSON.stringify({
            ok: false,
            tool: 'send_message',
            skipped: 'media_play_closer',
            reason: 'You already acknowledged the playback with a single emoji this turn (and the system told the user when you started looking for it). This further play-confirmation is redundant — the player is visibly running. The runtime suppressed it. For music/video playback: one emoji at most after a successful play, then just end the round.',
          })
          console.log(`[media closer] 拦截 send_message → ${normalizedArgs.target_id}: ${String(normalizedArgs.content || '').slice(0, 30)}`)
        } else {
          // 耗时工具即时回应：用户消息触发了一个会让人干等的工具（下载/搜索/生成/跑命令）时，
          // 本 turn 第一次就先替模型"应一声"。系统直接投递，不依赖模型在工具链中途主动开口
          // （实测它不会）。一个 turn 只发一次；模型已先回过话（delivered）则跳过，不重复。
          //
          // 本地渠道（localReply）的去重承重墙：本地/语音轮的回复是"流式纯文本"，不走 send_message，
          // 因此整个工具循环里 delivered 恒为 false（真正投递发生在文末兜底）。如果模型在调耗时工具前
          // 已经流出过可见正文（allContent 非空，用户已经在气泡里看到了），再补一次 ack 就会和模型自己
          // 那句话撞车——尤其 ack 文案本就模仿自然口吻（exec_command 的 ack 恰好就是"我跑一下～"），
          // 撞出两条一模一样的消息。所以本地渠道下"已流出可见正文"等价于 delivered，同样跳过 ack。
          const localAlreadySpoke = localReply && !!allContent.trim()
          if (!ackSent && !delivered && !localAlreadySpoke && mustReply && !silentSignal
              && toolContext?.currentTargetId && isSlowAckTool(tc.name, normalizedArgs)) {
            ackSent = true
            try {
              const ackArgs = { target_id: toolContext.currentTargetId, content: slowAckText(tc.name, normalizedArgs) }
              const ackResult = await runTool('send_message', ackArgs, { ...toolContext, signal, source: 'ack' })
              // 关键：ack 不置 delivered。ack 是"承诺稍后汇报"，不是汇报本身——
              // 把它当投递会让文末兜底（!delivered 守卫）跳过，模型生成的最终汇报被静默丢弃。
              // 实测（2026-06-10 排障四连静默）：r19 已生成完整收尾汇报，因 ack 置了 delivered
              // 而从未送达用户。重复 ack 由 ackSent 防住，不需要 delivered 参与。
              // ack 也要回调 onToolCall：语音自动 TTS 只挂在 onToolCall 里（index.js），ack 走直投通道
              // 会绕过它——结果 ack 只在 UI 显示成文字、却不被念出来（语音轮用户听不到"我查一下…"）。
              // 镜像协议兜底的做法（见文末 __fallback 分支）：补一次带 __ack 标记的 onToolCall 触发 TTS，
              // 标记供遥测分类，executeTool 收到的是干净的 ackArgs。
              if (onToolCall) onToolCall('send_message', { ...ackArgs, __ack: true }, ackResult)
            } catch { /* ack 投递失败不影响主流程 */ }
          }
          // 真正开始执行前通知 UI —— 让用户知道当前停留在哪一步的工具上
          onToolExecute?.(tc.name, normalizedArgs)
          result = await runTool(tc.name, normalizedArgs, { ...toolContext, signal })
          if (actionContract?.requiredTools?.includes(tc.name)) {
            actionContractAttempted = true
            if (actionContractToolSucceeded(actionContract, tc.name, result)) {
              actionContractSatisfied = true
            }
          }
          let deliveredByToolResult = false
          try {
            const parsedResult = JSON.parse(String(result || '{}'))
            deliveredByToolResult = parsedResult?.delivered === true && parsedResult?.message_sent === true
          } catch {}
          recordToolLoopOutcome(toolLoopState, tc.name, fingerprint, result)
          if (tickState && toolAddsTickEvidence(tc.name, result)) {
            tickState.evidenceVersion += 1
          }
          // 单一权威：一次未被 silent/closer 拦截、未熔断的 send_message 真正执行过 →
          //   用户确实收到了回复。这是 delivered 唯一被置 true 的地方（除文末协议兜底外）。
          if (tc.name === 'send_message' && !strictSuppressed && !isToolFailure(result)) delivered = true
          outboundSent = tc.name === 'send_message'
            && !strictSuppressed
            && !silentSignalSuppressed
            && !closerSuppressed
          && !mediaCloserSuppressed
          && !isToolFailure(result)
          if (outboundSent) {
            const outbound = {
              targetId: String(normalizedArgs.target_id || ''),
              content: String(normalizedArgs.content || ''),
              sentAt: new Date().toISOString(),
              toolRound: round,
              evidenceVersion: tickState?.evidenceVersion ?? 0,
            }
            outboundMessages.push(outbound)
            if (tickState && outbound.targetId) tickState.outboundByTarget.set(outbound.targetId, outbound)
          }
          if (deliveredByToolResult && !strictSuppressed) {
            delivered = true
            toolDeliveredFinalReply = true
          }
          // find_tool 动态装载：把搜到的工具 schema 当场注入本轮 toolSchemas（数组原地 push，
          // 下一轮 streamOnceWithRetry 即带上），模型下一步就能直接调用搜出来的工具。
          if (tc.name === 'find_tool') injectFoundToolSchemas(result, toolSchemas, strictEvaluation, toolPromptHints)
        }
        }
      }
      throwIfAborted(signal)
      // sentMessage 语义：最近一次工具动作是否就是 send_message。
      // 任何非 send_message 工具都把它清掉——意味着模型在 send_message 之后又做了新工作，
      // 那之前那次 send_message 只是过场（"好，我去看看…"），还欠用户一次最终回复。
      // 这样 line ~641 的"沉默退出 nudge"才能在该补刀时正确触发。
      // 被 closer dedup 拦截的 send_message 也算 sentMessage=true（最后一个动作意图是
      // 发消息，主回复已经发过——下一轮注入 "默认结束本轮" nudge 是合适的）。
      let deliveredByToolResultForTurn = false
      try {
        const parsedResult = JSON.parse(String(result || '{}'))
        deliveredByToolResultForTurn = parsedResult?.delivered === true && parsedResult?.message_sent === true
      } catch {}
      if ((tc.name === 'send_message' || deliveredByToolResultForTurn) && !strictSuppressed && !actionContractSendSuppressed) {
        sentMessage = true
        // 仅对真实发出的（未被 dedup 拦截的）send_message 记录到 turn 历史，避免被拦截的
        // closer / silent signal / media-closer 反过来污染后续判断（已经被拦截的就当没发生）。
        if (!closerSuppressed && !silentSignalSuppressed && !mediaCloserSuppressed
            && (deliveredByToolResultForTurn || (tc.name === 'send_message' && !isToolFailure(result)))) {
          const target = normalizedArgs.target_id
          const content = String(normalizedArgs.content || '')
          if (target) {
            const history = turnSendHistory.get(target) || []
            history.push({ length: content.length, isCloser: isCloserPattern(content) })
            turnSendHistory.set(target, history)
          }
        }
      } else {
        sentMessage = false
      }
      // 标记本 turn 播放过音乐/视频——之后模型补的播放确认短收尾会被静音（见上面 mediaCloser 判定）。
      if (tc.name === 'media_mode') {
        const m = String(normalizedArgs.mode || '')
        const a = String(normalizedArgs.action || 'show')
        if ((m === 'music' || m === 'video') && (a === 'show' || a === 'play')) {
          mediaPlayed = true
          mediaPlayedKind = m
        }
      }
      if (!strictSuppressed && shouldPersistActionLog(tc.name)) {
        insertActionLog({
          timestamp: new Date().toISOString(),
          tool: tc.name,
          summary: summarizeToolCall(tc.name, normalizedArgs),
          detail: buildToolLogDetail(normalizedArgs, result),
        })
      }
      console.log(`[工具结果] ${tc.name}: ${result.slice(0, 100)}`)
      if (onToolCall) onToolCall(tc.name, normalizedArgs, result)
      lastToolResult = { name: tc.name, args: normalizedArgs, result }
      return { id: tc.id, name: tc.name, args: normalizedArgs, result, stopReason, outboundSent }
    }

    const deferredOutboundTargets = new Set()
    for (let callIndex = 0; callIndex < effectiveToolCalls.length;) {
      const firstPrepared = prepareToolCall(effectiveToolCalls[callIndex])
      if (firstPrepared.tc.name === 'send_message' && deferredOutboundTargets.has(firstPrepared.normalizedArgs.target_id)) {
        const result = makeDeferredOutboundResult(firstPrepared.normalizedArgs, outboundMessages.at(-1))
        toolResults.push({ id: firstPrepared.tc.id, name: firstPrepared.tc.name, args: firstPrepared.normalizedArgs, result })
        if (onToolCall) onToolCall(firstPrepared.tc.name, firstPrepared.normalizedArgs, result)
        callIndex += 1
        continue
      }
      const canParallelize = isParallelSafeTool(firstPrepared.tc.name, firstPrepared.normalizedArgs)
      const remainingBudget = TOOL_LOOP_LIMITS.maxTotalCalls - toolLoopState.totalCalls

      if (canParallelize && !firstPrepared.stopReason && remainingBudget > 1) {
        const preparedBatch = [firstPrepared]
        let nextIndex = callIndex + 1
        while (nextIndex < effectiveToolCalls.length && preparedBatch.length < remainingBudget) {
          const prepared = prepareToolCall(effectiveToolCalls[nextIndex])
          if (!isParallelSafeTool(prepared.tc.name, prepared.normalizedArgs)) break
          preparedBatch.push(prepared)
          nextIndex += 1
        }

        if (preparedBatch.length > 1) {
          console.log(`[工具并行] ${preparedBatch.map(item => item.tc.name).join(', ')}`)
          const batchResults = await Promise.all(preparedBatch.map(item => runPreparedToolCall(item)))
          toolResults.push(...batchResults.map(({ id, name, args, result }) => ({ id, name, args, result })))
          const lastBatchResult = batchResults[batchResults.length - 1]
          if (lastBatchResult) {
            lastToolResult = {
              name: lastBatchResult.name,
              args: lastBatchResult.args,
              result: lastBatchResult.result,
            }
          }
          toolLoopStopReason = batchResults.find(item => item.stopReason)?.stopReason || null
          callIndex += preparedBatch.length
        } else {
          const result = await runPreparedToolCall(firstPrepared)
          toolResults.push({ id: result.id, name: result.name, args: result.args, result: result.result })
          if (result.outboundSent) deferredOutboundTargets.add(result.args.target_id)
          toolLoopStopReason = result.stopReason
          callIndex += 1
        }
      } else {
        const result = await runPreparedToolCall(firstPrepared)
        toolResults.push({ id: result.id, name: result.name, args: result.args, result: result.result })
        if (result.outboundSent) deferredOutboundTargets.add(result.args.target_id)
        toolLoopStopReason = result.stopReason
        callIndex += 1
      }

      if (toolLoopStopReason) {
        for (const skipped of effectiveToolCalls.slice(callIndex)) {
          toolResults.push({
            id: skipped.id,
            name: skipped.name,
            args: {},
            result: makeToolLoopStoppedResult(skipped.name, `skipped because previous tool call stopped the loop: ${toolLoopStopReason}`),
          })
        }
        break
      }
    }
    throwIfAborted(signal)
    if (toolDeliveredFinalReply) {
      return {
        content: '',
        toolResult: lastToolResult,
        aborted: signal?.aborted ?? false,
        delivered: true,
      }
    }

    // 将本轮 assistant 消息（含工具调用）加入对话
    // 若是 XML 解析的工具调用，assistant 消息用文本形式（避免 MiniMax 不支持 tool_calls 格式回放）
    const terminalInternalRound = isTerminalInternalToolRound(effectiveToolCalls, { mustReply })
    const isXmlRound = toolCalls.length === 0 && effectiveToolCalls.length > 0
    // 工具结果压缩配置：每轮取一次（config 读取带缓存，且不影响性能）。
    // 大工具结果（read_file / exec / web_search…）压成一行摘要 + 全文路径，模型需要细节时 read_file 按需取回。
    const compressionCfg = getToolCompressionConfig()
    const compressForModel = (tr) => compressToolResultForModel(tr.name, tr.args || {}, tr.result, {
      enabled: compressionCfg.enabled,
      threshold: compressionCfg.threshold,
      maxSaved: compressionCfg.maxSaved,
      dataDir: paths?.dataDir ?? null,
    })
    if (isXmlRound) {
      // XML 工具调用：assistant 消息为纯文本，工具结果作为 user 消息注入
      if (content) messages.push({ role: 'assistant', content })
      const resultSummary = toolResults.map(tr => {
        const c = compressForModel(tr)
        const body = c.summarized ? c.content : tr.result.slice(0, 300)
        return `[Tool result] ${tr.name}: ${body}`
      }).join('\n')
      // 同主路径：以 sentMessage（本轮最后一个动作是否是 send_message）为收尾依据，
      // 而不是只看本轮有没有出现过 send_message。
      if (!terminalInternalRound) {
        messages.push({
          role: 'user',
          content: sentMessage
            ? `Tool execution results:\n${resultSummary}\n\n${buildPostSendNudge(outboundMessages, tickState)}`
            : toolLoopStopReason
              ? buildToolLoopStopNudge(toolLoopStopReason, lastToolResult)
              : `Tool execution results:\n${resultSummary}\n\nContinue completing the task. If this is a user message and the information is sufficient, ${deliverInstruction}. If a tool failed, explain the failure and available clues; do not end silently.`,
        })
      }
    } else {
      const assistantMsg = {
        role: 'assistant',
        tool_calls: effectiveToolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments || '{}' }
        }))
      }
      if (content) assistantMsg.content = content
      if (reasoningContent) assistantMsg.reasoning_content = reasoningContent
      messages.push(assistantMsg)

      // 将工具结果加入对话（大工具结果经 TokenJuice 压缩成摘要 + 全文路径；细节可按需 read_file 取回）
      cleanupOldToolOutputs({ dataDir: paths?.dataDir ?? null })
      for (const tr of toolResults) {
        const compressed = compressForModel(tr)
        messages.push({
          role: 'tool',
          tool_call_id: tr.id,
          content: compressed.content
        })
      }
      if (terminalInternalRound) break
      // "send_message 是不是本轮最后一个动作"才是判断"能不能收尾"的正确信号。
      // 旧逻辑只看 hasSendMessage（本轮任意位置出现过 send_message），
      // 会让 [send_message("我查一下..."), exec_command, exec_command] 这种"先说一句再去查"的链条
      // 在 exec_command 出结果后被错误地告知"可以结束了"，导致模型静默退场、用户拿不到最终答复。
      if (toolLoopStopReason) {
        messages.push({
          role: 'user',
          content: buildToolLoopStopNudge(toolLoopStopReason, lastToolResult),
        })
      } else if (sentMessage) {
        // 历史措辞 "If you still need to send additional separate messages" 被中文 LLM 解读成
        // "鼓励多发"，叠加它们训练里的客套尾巴反射（"有需要随时叫我"/"希望对你有帮助"），
        // 一次 Q&A 经常变成双发。新措辞默认收尾，明确把 closer/followup/复述列为禁止，
        // 仅保留"工具结果回来后补刀"和"不同收件人"的合法口子。
        messages.push({
          role: 'user',
          content: buildPostSendNudge(outboundMessages, tickState),
        })
      } else if (mustReply) {
        // 层 3：步数跨过阈值仍未投递 → 先插一次"不确定回退"软检查点，引导退一步重审计划，
        // 而不是继续往前撞。一 turn 只发一次；之后回到普通"继续"nudge。
        if (toolLoopState.totalCalls >= TOOL_LOOP_LIMITS.uncertaintyCheckpointCalls && !uncertaintyNudgeUsed) {
          uncertaintyNudgeUsed = true
          console.log(`[不确定回退] 已执行 ${toolLoopState.totalCalls} 次工具仍未投递，注入重审检查点`)
          messages.push({
            role: 'user',
            content: buildUncertaintyCheckpointNudge(toolLoopState.totalCalls),
          })
        } else {
          messages.push({
            role: 'user',
            content: `Tool results have returned. Continue completing the user request based on the available results. If the information is sufficient, ${deliverInstruction}. For files, directories, commands, or network requests, state only facts verified by tool results, such as ok/verified/path/bytes/exit_code/status. Do not claim completion of any action without tool evidence. If a tool failed or the data is insufficient, explain the limitation and next suggested step; do not end silently.`,
          })
        }
      }
    }
    if (terminalInternalRound) break
  }

  const aborted = signal?.aborted ?? false

  // ── 单一权威的协议兜底 ──────────────────────────────────────────────
  // 模型产出了可投递的回复文本，但整轮从未真正执行过 send_message（delivered=false），
  // 且本轮要求回复用户（mustReply 且非 silent 信号）。此时由 runtime 代为投递——
  // 关键：走**真正的 send_message 执行器**（executeTool），从而复用 executor 里的
  //   open_question 检测 / dispatchSocialMessage 社交派发，
  //   不再像旧的 index.js fallback 那样手工重做副作用却漏掉这些通道逻辑。
  // 硬不变量：
  //   #1 silent 轮绝不投递 —— !silentSignal 守卫。
  //   #4 不双发 —— 仅 !delivered 时触发；一旦投出立刻 delivered=true，index.js 不会再补。
  //   #5 投递前剥离 <think>/[RECALL:] 等协议标记。
  //   #8 source:'fallback' 由 executeTool→tool-audit 自动写入 action_log，区分协议兜底与显式调用。
  //
  // 中断恢复（去掉了旧的 !aborted 守卫）：watchdog 超时/高优先级抢占会把本 turn 的 signal abort。
  // 但若模型在被掐断前**已经生成好了一条可投递的答案**（典型：社交渠道第一轮出了纯文本、第二轮包
  // send_message 时卡死被 watchdog 掐），这条答案不应凭空丢掉——「你有意识吗」事故就是这么蒸发的。
  // 此时原 signal 已废，复用它会让 send_message 立刻 AbortError 失败，所以中断兜底改走一条全新的、
  // 带 30s 超时的干净 signal，确保已生成的答案仍能送达。
  if (allowPlainTextFallback && !silentSignal && !delivered) {
    // 内容来源：优先本轮累积的 allContent；若它已被 nudge 清空（草稿挪进了 messages），
    // 退回 salvageableReply —— 这正是中断/卡死时把"已生成但没发出"的答案救回来的关键。
    let fallbackContent = stripProtocolMarkersForDelivery(allContent.trim() ? allContent : salvageableReply)
    const fallbackTarget = toolContext?.currentTargetId
    // 播放收尾一致性：视频流程里模型常不调 send_message 而是留 body 走兜底（音乐则习惯调
    // send_message 被 isMediaCloser 替换）。这里对兜底 body 做同样处理——本 turn 播放过媒体、
    // 且 body 正是一句播放确认时换成单个表情，确保"播放中"之类文字不会原样发出/被语音念。
    if (fallbackContent && fallbackTarget && mediaPlayed && !mediaEmojiSent && isMediaCloser(fallbackContent)) {
      fallbackContent = mediaPlayedKind === 'video' ? '🎬' : '🎵'
      mediaEmojiSent = true
    }
    if (fallbackContent && fallbackTarget) {
      // 中断恢复路径：原 signal 已 abort，另起一条带超时的干净 signal 兜底投递。
      let fbSignal = signal
      let fbCleanup = null
      if (aborted) {
        const fresh = createMergedAbortSignal(null, 30_000)
        fbSignal = fresh?.signal
        fbCleanup = fresh?.cleanup
        console.warn(`[protocol fallback] 本轮被中断但已生成回复 —— 用独立 signal 兜底投递给 ${fallbackTarget}`)
      } else if (localReply) {
        // localReply 渠道：纯文本直投是设计内的快路径（省掉 send_message 那一轮），不是协议违规。
        console.log(`[local reply] 纯文本直投给 ${fallbackTarget}（本地渠道无需 send_message）`)
      } else {
        // 社交渠道未中断却走到这里 = 模型漏调 send_message 的常规兜底。
        console.warn(`[protocol fallback] 模型未调 send_message —— callLLM 代为投递给 ${fallbackTarget}`)
      }
      try {
        const fbArgs = { target_id: fallbackTarget, content: fallbackContent }
        // source:'fallback' 让 tool-audit 把这条 action_log 标记为协议兜底（不变量 #8）。
        const fbResult = await runTool('send_message', fbArgs, { ...toolContext, signal: fbSignal, source: 'fallback' })
        // 兜底也是"真正执行过的 send_message"：置 delivered，并触发与正常路径同样的
        //   onToolCall 回调（语音渠道自动 TTS、UI tool_call 事件、toolCallLog 登记都在那里）。
        //   __fallback 标记仅给 onToolCall 用于遥测分类；executeTool 收到的是干净的 fbArgs。
        delivered = !isToolFailure(fbResult)
        lastToolResult = { name: 'send_message', args: fbArgs, result: fbResult }
        if (onToolCall) onToolCall('send_message', { ...fbArgs, __fallback: true }, fbResult)
      } catch (err) {
        // 中断恢复用的是独立 signal，其超时/中止不应再往上抛（本 turn 本就在收尾）。
        // 仅在正常路径(非 aborted)下保留原语义：调用方 signal 的 AbortError 继续上抛。
        if (err?.name === 'AbortError' && !aborted) throw err
        console.warn('[protocol fallback] callLLM 兜底投递失败:', err?.message || err)
      } finally {
        fbCleanup?.()
      }
    }
  }

  trace.end({ messages, delivered, aborted })
  return { content: allContent, toolResult: lastToolResult, aborted, delivered }
  } finally {
    // 异常 / abort / 任何提前退出路径的兜底收尾（end 内部幂等，正常路径已 end 过则无副作用）。
    trace.end({ messages, delivered, aborted: signal?.aborted })
  }
}
