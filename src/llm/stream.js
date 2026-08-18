// stream.js —— LLM 流式调用层（自 src/llm.js 拆出）
//
// 职责：OpenAI 兼容客户端的延迟建连、请求参数构建、单轮流式调用、
// 瞬时错误退避重试、MiMo 模型回退。供 src/llm.js 的 callLLM 主循环使用。
import OpenAI from 'openai'
import {
  config, MIMO_PROVIDER, ZHIPU_PROVIDER, getProviderModelFallbacks,
  shouldOmitSamplingForProviderModel, shouldSendThinkingDisabledForProviderModel,
  shouldUseMaxCompletionTokensForProviderModel, switchModel,
} from '../config.js'
import { recordUsage } from '../quota.js'
import { recordUsageEvent } from '../runtime/insights.js'
import { getFastModel } from '../providers/model-router.js'
import { sanitizeAssistantReplyForDelivery, createAssistantReplyStreamSanitizer } from '../runtime/markers.js'
import { streamWriteFileArgumentPreview, streamXmlFileWriteArgumentPreview } from '../write-file-preview.js'

// 单轮流式调用的「空闲超时」：从开始到第一个 token、以及每两个 token 之间，
// 若超过这个时长没有任何增量到达，判定为 provider 连接卡死（连接开着却不吐字节）。
// 每收到一个 chunk 就重置，所以正常的长流式生成不受影响，只掐真正的停摆。
// 必须显著小于 index.js 的 RUN_TURN_WATCHDOG_MS(180s)，且留够 streamOnceWithRetry 重试的余量
// （最坏 3 次 × 该值 + 退避 仍要 < 180s）。
export const STREAM_IDLE_TIMEOUT_MS = 45_000

// 延迟创建 OpenAI 客户端：激活流程把 key 写入 config 后再调用这里，
// 避免模块加载阶段就锁死尚未填入的 apiKey/baseURL。
let client = null
let clientKey = null
function getClient() {
  const signature = `${config.provider}|${config.baseURL}|${config.apiKey}`
  if (client && clientKey === signature) return client
  if (!config.apiKey) {
    throw new Error('LLM 尚未激活，请先通过激活页填入 API Key')
  }
  client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL })
  clientKey = signature
  return client
}

function shouldEnableDeepSeekThinking(thinking) {
  if (!thinking) return false
  if (config.model === 'deepseek-chat') return false
  return true
}

// 简单文本完成（供 spawn_subagents 等并行子代理复用）。
// 不做工具调用、不流式，只做一次 chat completion 返回文本。用同一 OpenAI 客户端，
// 保证子代理与主 Agent 用同一 provider/model。
export async function runSimpleCompletion({ messages, temperature = 0.3, maxTokens = 1500, fast = false } = {}) {
  if (!Array.isArray(messages) || !messages.length) throw new Error('messages 必填')
  const client = getClient()
  // fast=true 时用快模型（flash）做低风险子调用（见 model-router），省成本
  const fastModel = fast ? getFastModel() : null
  const model = fastModel || config.model
  const params = {
    model,
    messages,
    stream: false,
  }
  const providerTemperature = normalizeTemperatureForProvider(temperature, model)
  if (typeof providerTemperature === 'number') params.temperature = providerTemperature
  if (maxTokens) params.max_tokens = maxTokens
  const res = await client.chat.completions.create(params)
  return res?.choices?.[0]?.message?.content?.trim?.() || ''
}

function normalizeTemperatureForProvider(temperature, model = config.model) {
  if (typeof temperature !== 'number') return temperature
  if (shouldOmitSamplingForProviderModel(config.provider, model)) return undefined
  if (config.provider !== ZHIPU_PROVIDER) return temperature
  return Math.max(0, Math.min(1, Number(temperature.toFixed(2))))
}

export function buildChatCompletionRequestParams({ messages, toolSchemas = [], temperature, topP, maxTokens, thinking = true, model = config.model }) {
  const providerTemperature = normalizeTemperatureForProvider(temperature, model)
  const requestParams = {
    model,
    messages,
    stream: true,
  }
  if (typeof providerTemperature === 'number') {
    requestParams.temperature = providerTemperature
  }
  if (config.provider !== ZHIPU_PROVIDER) {
    requestParams.stream_options = { include_usage: true }
  }

  if (
    typeof topP === 'number'
    && topP > 0
    && config.provider !== ZHIPU_PROVIDER
    && !shouldOmitSamplingForProviderModel(config.provider, model)
  ) {
    requestParams.top_p = topP
  }
  if (config.provider === 'deepseek') {
    const thinkingEnabled = shouldEnableDeepSeekThinking(thinking)
    if (thinkingEnabled) {
      requestParams.reasoning_effort = 'high'
      requestParams.thinking = { type: 'enabled' }
    } else {
      requestParams.thinking = { type: 'disabled' }
    }
  } else if (!thinking && shouldSendThinkingDisabledForProviderModel(config.provider, model)) {
    requestParams.thinking = { type: 'disabled' }
  }
  if (maxTokens) {
    if (shouldUseMaxCompletionTokensForProviderModel(config.provider, model)) {
      requestParams.max_completion_tokens = maxTokens
    } else {
      requestParams.max_tokens = maxTokens
    }
  }
  if (toolSchemas.length > 0) {
    requestParams.tools = toolSchemas
    requestParams.tool_choice = 'auto'
    if (config.provider === ZHIPU_PROVIDER) requestParams.tool_stream = true
  }
  return requestParams
}

// 单次流式调用，返回 { content, toolCalls, aborted }
async function streamOnce({ messages, toolSchemas, temperature, topP, maxTokens, thinking = true, signal, onStream, model = config.model }) {
  const requestParams = buildChatCompletionRequestParams({
    model,
    messages,
    toolSchemas,
    temperature,
    topP,
    maxTokens,
    thinking,
  })
  // ── 空闲超时（连接卡死保护）──
  // provider 连接开着却长时间不吐任何增量 = 停摆。每收到一个 chunk 就重置计时；超时则中止本轮，
  // 交给 streamOnceWithRetry 重试，避免把整个 turn 干耗到 index.js 的 180s watchdog 才被发现。
  // 正是这次「你有意识吗」事故的成因：第二轮请求卡死 180s，已生成的答案被一并丢弃。
  const idleController = new AbortController()
  let idleFired = false
  let idleTimer = null
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleFired = true
      try { idleController.abort('stream idle timeout') } catch {}
    }, STREAM_IDLE_TIMEOUT_MS)
  }
  // 合并「调用方 signal（watchdog/抢占）」与「空闲超时 signal」：任一触发都中止底层请求。
  const reqController = new AbortController()
  const onCallerAbort = () => { try { reqController.abort(signal?.reason || 'Aborted') } catch {} }
  const onIdleAbort = () => { try { reqController.abort('stream idle timeout') } catch {} }
  if (signal) {
    if (signal.aborted) reqController.abort(signal.reason || 'Aborted')
    else signal.addEventListener('abort', onCallerAbort, { once: true })
  }
  idleController.signal.addEventListener('abort', onIdleAbort, { once: true })
  const cleanupIdle = () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
    try { signal?.removeEventListener('abort', onCallerAbort) } catch {}
  }

  armIdle()

  let fullContent = ''
  let fullReasoningContent = ''
  let toolCallsMap = {}
  const writeFilePreviewStates = new Map()
  const writeFilePreviewSession = { cleared: false }
  const xmlWriteFilePreviewState = { session: writeFilePreviewSession }
  let inThink = false
  let thinkDone = false
  let streamStarted = false
  let usageTokens = 0
  let usageInputTokens = 0
  let usageOutputTokens = 0
  let cacheHitTokens = 0
  let cacheMissTokens = 0
  const textStreamSanitizer = createAssistantReplyStreamSanitizer()
  const emitTextChunk = (rawText) => {
    const cleanText = textStreamSanitizer.push(rawText)
    if (!cleanText) return
    if (!streamStarted) { onStream?.({ event: 'start', mode: 'text' }); streamStarted = true }
    onStream?.({ event: 'chunk', text: cleanText })
  }
  const flushTextStream = () => {
    const cleanText = textStreamSanitizer.flush()
    if (!cleanText) return
    if (!streamStarted) { onStream?.({ event: 'start', mode: 'text' }); streamStarted = true }
    onStream?.({ event: 'chunk', text: cleanText })
  }

  try {
  // create() 也放进 try：连接建立阶段就卡死时，idle 触发 → 这里抛 AbortError → 下方 catch 转成可重试的瞬时错误。
  const stream = await getClient().chat.completions.create(requestParams, { signal: reqController.signal })
  for await (const chunk of stream) {
    armIdle()  // 收到增量，重置空闲计时（正常长流式生成因此不受影响）
    if (signal?.aborted) break
    if (chunk.usage?.total_tokens) {
      usageTokens = chunk.usage.total_tokens
      usageInputTokens = chunk.usage.prompt_tokens || chunk.usage.input_tokens || 0
      usageOutputTokens = chunk.usage.completion_tokens || chunk.usage.output_tokens || 0
      cacheHitTokens = chunk.usage.prompt_cache_hit_tokens || 0
      cacheMissTokens = chunk.usage.prompt_cache_miss_tokens || 0
    }
    const choice = chunk.choices?.[0]
    if (!choice) continue

    const delta = choice.delta

    // 工具调用增量
    if (delta?.tool_calls) {
      flushTextStream()
      if (streamStarted) {
        onStream?.({ event: 'end' })
        streamStarted = false
      }
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0
        if (!toolCallsMap[idx]) {
          toolCallsMap[idx] = { id: tc.id || '', name: '', arguments: '' }
        }
        if (tc.id) toolCallsMap[idx].id = tc.id
        if (tc.function?.name) {
          const wasEmpty = toolCallsMap[idx].name === ''
          toolCallsMap[idx].name += tc.function.name
          // 第一次拿到完整 name 时通知上层 —— 此时流文本已 end，但工具尚未执行，
          // 没有这个信号 UI 会出现"思考动画停止 → 工具行出现"之间的死寂。
          if (wasEmpty && toolCallsMap[idx].name) {
            onStream?.({ event: 'tool_preparing', name: toolCallsMap[idx].name })
          }
        }
        if (tc.function?.arguments) toolCallsMap[idx].arguments += tc.function.arguments
        const previewState = writeFilePreviewStates.get(idx) || {}
        previewState.session ||= writeFilePreviewSession
        writeFilePreviewStates.set(idx, streamWriteFileArgumentPreview(toolCallsMap[idx], previewState))
      }
      continue
    }

    // DeepSeek reasoner 思考内容（独立字段，不在 content 里）
    const reasoningText = delta?.reasoning_content || delta?.reasoningContent || delta?.reasoning
    if (reasoningText) {
      fullReasoningContent += reasoningText
      if (!thinkDone) {
        inThink = true
        if (!streamStarted) { onStream?.({ event: 'start', mode: 'think' }); streamStarted = true }
        onStream?.({ event: 'chunk', text: reasoningText })
      }
      continue
    }

    // 文本增量
    const text = delta?.content
    if (!text) continue

    // DeepSeek：思考流结束、进入正式回答时，先关闭 think 流
    if (inThink && !thinkDone) {
      inThink = false
      thinkDone = true
      if (streamStarted) { onStream?.({ event: 'end' }); streamStarted = false }
    }

    fullContent += text
    streamXmlFileWriteArgumentPreview(fullContent, xmlWriteFilePreviewState)

    // 解析 <think> 标签流式推送
    if (!thinkDone) {
      if (!inThink && fullContent.includes('<think>')) {
        inThink = true
        const after = fullContent.split('<think>').slice(1).join('<think>')
        if (after.length > 0) {
          if (!streamStarted) { onStream?.({ event: 'start', mode: 'think' }); streamStarted = true }
          onStream?.({ event: 'chunk', text: after })
        }
        continue
      }
      if (inThink) {
        if (fullContent.includes('</think>')) {
          inThink = false
          thinkDone = true
          const chunkBeforeEnd = text.split('</think>')[0]
          if (chunkBeforeEnd) onStream?.({ event: 'chunk', text: chunkBeforeEnd })
          onStream?.({ event: 'end' })
          streamStarted = false
          const afterThink = fullContent.split('</think>').slice(1).join('</think>').trimStart()
          if (afterThink) {
            emitTextChunk(afterThink)
          }
        } else {
          if (!streamStarted) { onStream?.({ event: 'start', mode: 'think' }); streamStarted = true }
          onStream?.({ event: 'chunk', text })
        }
        continue
      }
    }

    emitTextChunk(text)
  }

  } catch (err) {
    // 空闲超时（我们自己的看门狗触发）且调用方并未中止 —— 当作瞬时错误上抛，由 streamOnceWithRetry 重试，
    // 而不是误判成"用户中止"(aborted:true) 把本轮静默放弃。
    if (idleFired && !signal?.aborted) {
      flushTextStream()
      if (streamStarted) onStream?.({ event: 'end' })
      const e = new Error(`stream idle timeout after ${STREAM_IDLE_TIMEOUT_MS / 1000}s`)
      e.code = 'ETIMEDOUT'
      e.hadContent = fullContent.length > 0
      throw e
    }
    if (err.name === 'AbortError' || signal?.aborted) {
      flushTextStream()
      if (streamStarted) onStream?.({ event: 'end' })
      return {
        content: sanitizeAssistantReplyForDelivery(fullContent),
        reasoningContent: fullReasoningContent,
        toolCalls: Object.values(toolCallsMap),
        aborted: true
      }
    }
    err.hadContent = fullContent.length > 0
    flushTextStream()
    if (streamStarted) onStream?.({ event: 'end' })
    throw err
  } finally {
    cleanupIdle()
  }

  flushTextStream()
  if (streamStarted) onStream?.({ event: 'end' })
  if (usageTokens > 0) {
    recordUsage(usageTokens)
    // 用量洞察：持久化本轮 token 消耗（供每日/每周报告）。best-effort。
    try {
      recordUsageEvent({
        provider: config.provider,
        model: config.model || model,
        inputTokens: usageInputTokens || usageTokens,
        outputTokens: usageOutputTokens,
        source: 'llm',
      })
    } catch { /* 用量记录失败不影响调用链 */ }
    const promptTotal = cacheHitTokens + cacheMissTokens
    const cacheStr = promptTotal > 0
      ? ` (prompt cache: ${cacheHitTokens}/${promptTotal} = ${(cacheHitTokens/promptTotal*100).toFixed(1)}%)`
      : ''
    console.log(`[配额] 本轮 tokens: ${usageTokens}${cacheStr}`)
  }

  return {
    content: sanitizeAssistantReplyForDelivery(fullContent),
    reasoningContent: fullReasoningContent,
    toolCalls: Object.values(toolCallsMap),
    aborted: false
  }
}

export const __internals = {
  buildChatCompletionRequestParams,
}

// 判断是否为瞬时错误（5xx / 网络抖动 / 超时），429 交给外层 setRateLimited
function isTransientError(err) {
  const status = err.status ?? err.response?.status
  if (status && status >= 500 && status < 600) return true
  if (status === 408) return true
  const code = err.code || err.cause?.code
  if (code && ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE'].includes(code)) return true
  const msg = err.message || ''
  return /timeout|timed out|socket hang up|fetch failed|network error|upstream/i.test(msg)
}

function isAuthenticationError(err) {
  const status = err.status ?? err.response?.status
  const msg = err.message || ''
  return status === 401 || /unauthoriz|invalid.*api.*key|authentication/i.test(msg)
}

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
    const timer = setTimeout(resolve, ms)
    const onAbort = () => { clearTimeout(timer); reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// 包装 streamOnce：对瞬时错误做有限次退避重试；已流出内容时不重试避免 UI 重复
async function streamOnceWithRetry(args) {
  const BACKOFFS_MS = [800, 2500]
  const MAX_ATTEMPTS = BACKOFFS_MS.length + 1
  let lastErr
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (args.signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' })
    try {
      return await streamOnce(args)
    } catch (err) {
      if (err.name === 'AbortError' || args.signal?.aborted) throw err
      if (err.hadContent) throw err
      if (!isTransientError(err)) throw err
      lastErr = err
      if (attempt < MAX_ATTEMPTS - 1) {
        const delay = BACKOFFS_MS[attempt]
        args.onRetry?.({
          attempt: attempt + 1,
          nextAttempt: attempt + 2,
          maxAttempts: MAX_ATTEMPTS,
          delayMs: delay,
          error: err.message || String(err),
        })
        console.warn(`[LLM] 瞬时错误 "${(err.message || '').slice(0, 80)}"，${delay}ms 后第 ${attempt + 2} 次尝试`)
        await abortableSleep(delay, args.signal)
      }
    }
  }
  throw lastErr
}

// XML 格式工具调用的参数名别名映射（某些模型使用不同参数名）
export async function streamOnceWithModelFallback(args) {
  if (config.provider !== MIMO_PROVIDER) return await streamOnceWithRetry(args)

  const models = getProviderModelFallbacks(config.provider, args.model || config.model)
  if (models.length <= 1) return await streamOnceWithRetry({ ...args, model: models[0] || config.model })

  let lastErr
  for (let idx = 0; idx < models.length; idx++) {
    const model = models[idx]
    try {
      const result = await streamOnceWithRetry({ ...args, model })
      if (model !== config.model) {
        try {
          switchModel(model)
        } catch (persistErr) {
          console.warn(`[LLM] MiMo fallback model "${model}" worked but could not be saved: ${persistErr.message || persistErr}`)
        }
        console.warn(`[LLM] MiMo model fallback selected "${model}"`)
      }
      return result
    } catch (err) {
      if (err.name === 'AbortError' || args.signal?.aborted) throw err
      if (err.hadContent || isAuthenticationError(err)) throw err
      lastErr = err
      const nextModel = models[idx + 1]
      if (!nextModel) break
      args.onRetry?.({
        attempt: idx + 1,
        nextAttempt: idx + 2,
        maxAttempts: models.length,
        delayMs: 0,
        error: err.message || String(err),
        modelFallback: true,
        model,
        nextModel,
      })
      console.warn(`[LLM] MiMo model "${model}" failed before content; falling back to "${nextModel}": ${(err.message || String(err)).slice(0, 120)}`)
    }
  }
  throw lastErr
}
