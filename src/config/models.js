// models.js —— LLM Provider 模型目录与探测辅助（自 src/config.js 拆出）
//
// 纯数据 / 纯函数：Provider 常量、各厂商模型列表、参数构建、激活探测。
// 不依赖 config 运行时对象与 config.json 读写，可独立测试。
export const DEEPSEEK_PROVIDER = 'deepseek'
export const MINIMAX_PROVIDER = 'minimax'
export const OPENAI_PROVIDER = 'openai'
export const QWEN_PROVIDER = 'qwen'
export const MOONSHOT_PROVIDER = 'moonshot'
export const ZHIPU_PROVIDER = 'zhipu'
export const MIMO_PROVIDER = 'mimo'

export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-pro'
export const DEFAULT_MINIMAX_MODEL = 'MiniMax-M2.7'
export const DEFAULT_OPENAI_MODEL = 'gpt-5.5'
export const DEFAULT_QWEN_MODEL = 'qwen-turbo'
export const DEFAULT_MOONSHOT_MODEL = 'kimi-k2.6'
export const DEFAULT_ZHIPU_MODEL = 'glm-5.1'
export const DEFAULT_MIMO_MODEL = 'mimo-v2.5-pro'

export const DEEPSEEK_MODELS = [
  {
    id: 'deepseek-v4-flash',
    label: 'deepseek-v4-flash',
    deprecated: false,
  },
  {
    id: 'deepseek-v4-pro',
    label: 'deepseek-v4-pro',
    deprecated: false,
  },
  {
    id: 'deepseek-chat',
    label: 'deepseek-chat (deprecated 2026/07/24)',
    deprecated: true,
  },
  {
    id: 'deepseek-reasoner',
    label: 'deepseek-reasoner (deprecated 2026/07/24)',
    deprecated: true,
  },
]

export const MINIMAX_MODELS = [
  {
    id: 'MiniMax-M2.7',
    label: 'MiniMax-M2.7',
    deprecated: false,
  },
  {
    id: 'MiniMax-M1',
    label: 'MiniMax-M1',
    deprecated: false,
  },
]

export const OPENAI_MODELS = [
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    deprecated: false,
  },
  {
    id: 'gpt-5.5-2026-04-23',
    label: 'GPT-5.5 (2026-04-23)',
    deprecated: false,
  },
  {
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    deprecated: false,
  },
  {
    id: 'gpt-5.4-2026-03-05',
    label: 'GPT-5.4 (2026-03-05)',
    deprecated: false,
  },
  {
    id: 'gpt-5.4-mini',
    label: 'GPT-5.4 mini',
    deprecated: false,
  },
  {
    id: 'gpt-5.4-nano',
    label: 'GPT-5.4 nano',
    deprecated: false,
  },
  {
    id: 'gpt-5.3-chat-latest',
    label: 'GPT-5.3 Chat latest',
    deprecated: false,
  },
  {
    id: 'gpt-5.2',
    label: 'GPT-5.2',
    deprecated: false,
  },
  {
    id: 'gpt-5.2-chat-latest',
    label: 'GPT-5.2 Chat latest',
    deprecated: true,
  },
  {
    id: 'gpt-5.1',
    label: 'GPT-5.1',
    deprecated: false,
  },
  {
    id: 'gpt-5.1-chat-latest',
    label: 'GPT-5.1 Chat latest',
    deprecated: false,
  },
  {
    id: 'gpt-5',
    label: 'GPT-5',
    deprecated: false,
  },
  {
    id: 'gpt-5-chat-latest',
    label: 'GPT-5 Chat latest',
    deprecated: true,
  },
  {
    id: 'gpt-5-mini',
    label: 'GPT-5 mini',
    deprecated: false,
  },
  {
    id: 'gpt-5-nano',
    label: 'GPT-5 nano',
    deprecated: false,
  },
  {
    id: 'gpt-4.1',
    label: 'GPT-4.1',
    deprecated: false,
  },
  {
    id: 'gpt-4.1-mini',
    label: 'GPT-4.1 mini',
    deprecated: false,
  },
  {
    id: 'gpt-4.1-nano',
    label: 'GPT-4.1 nano',
    deprecated: false,
  },
  {
    id: 'gpt-4o',
    label: 'GPT-4o',
    deprecated: false,
  },
  {
    id: 'gpt-4o-mini',
    label: 'GPT-4o mini',
    deprecated: false,
  },
  {
    id: 'o3',
    label: 'o3',
    deprecated: false,
  },
  {
    id: 'o4-mini',
    label: 'o4-mini',
    deprecated: false,
  },
]

export const QWEN_MODELS = [
  {
    id: 'qwen-turbo',
    label: 'qwen-turbo',
    deprecated: false,
  },
  {
    id: 'qwen-plus',
    label: 'qwen-plus',
    deprecated: false,
  },
]

export const MOONSHOT_MODELS = [
  {
    id: 'kimi-k2.7-code',
    label: 'kimi-k2.7-code',
    deprecated: false,
  },
  {
    id: 'kimi-k2.7-code-highspeed',
    label: 'kimi-k2.7-code-highspeed',
    deprecated: false,
  },
  {
    id: 'kimi-k2.6',
    label: 'kimi-k2.6',
    deprecated: false,
  },
  {
    id: 'kimi-k2.5',
    label: 'kimi-k2.5',
    deprecated: false,
  },
  {
    id: 'moonshot-v1-32k',
    label: 'moonshot-v1-32k',
    deprecated: false,
  },
  {
    id: 'moonshot-v1-128k',
    label: 'moonshot-v1-128k',
    deprecated: false,
  },
  {
    id: 'moonshot-v1-8k',
    label: 'moonshot-v1-8k',
    deprecated: false,
  },
  {
    id: 'moonshot-v1-8k-vision-preview',
    label: 'moonshot-v1-8k-vision-preview',
    deprecated: false,
  },
  {
    id: 'moonshot-v1-32k-vision-preview',
    label: 'moonshot-v1-32k-vision-preview',
    deprecated: false,
  },
  {
    id: 'moonshot-v1-128k-vision-preview',
    label: 'moonshot-v1-128k-vision-preview',
    deprecated: false,
  },
  {
    id: 'kimi-k2-thinking',
    label: 'kimi-k2-thinking (deprecated)',
    deprecated: true,
  },
]

export const ZHIPU_MODELS = [
  {
    id: 'glm-5.1',
    label: 'glm-5.1',
    deprecated: false,
  },
  {
    id: 'glm-5-turbo',
    label: 'glm-5-turbo',
    deprecated: false,
  },
  {
    id: 'glm-5',
    label: 'glm-5',
    deprecated: false,
  },
  {
    id: 'glm-4.7',
    label: 'glm-4.7',
    deprecated: false,
  },
  {
    id: 'glm-4.7-flash',
    label: 'glm-4.7-flash',
    deprecated: false,
  },
  {
    id: 'glm-4.7-flashx',
    label: 'glm-4.7-flashx',
    deprecated: false,
  },
  {
    id: 'glm-4.6',
    label: 'glm-4.6',
    deprecated: false,
  },
  {
    id: 'glm-4.5-air',
    label: 'glm-4.5-air',
    deprecated: false,
  },
  {
    id: 'glm-4.5-airx',
    label: 'glm-4.5-airx',
    deprecated: false,
  },
  {
    id: 'glm-4.5-flash',
    label: 'glm-4.5-flash',
    deprecated: false,
  },
  {
    id: 'glm-5.1-highspeed',
    label: 'glm-5.1-highspeed (limited access)',
    deprecated: false,
  },
  {
    id: 'glm-4-flash-250414',
    label: 'glm-4-flash-250414',
    deprecated: false,
  },
  {
    id: 'glm-4-flashx-250414',
    label: 'glm-4-flashx-250414',
    deprecated: false,
  },
]

export const MIMO_MODELS = [
  {
    id: 'mimo-v2.5-pro',
    label: 'MiMo-V2.5-Pro',
    deprecated: false,
  },
  {
    id: 'mimo-v2.5',
    label: 'MiMo-V2.5',
    deprecated: false,
  },
  {
    id: 'mimo-v2-pro',
    label: 'MiMo-V2-Pro',
    deprecated: false,
  },
  {
    id: 'mimo-v2-flash',
    label: 'MiMo-V2-Flash',
    deprecated: false,
  },
  {
    // 极速版：保留为可选项，非默认首选（小米平台暂无此官方 ID，调用失败会自动降级到上面的真实模型）
    id: 'MiMo-V2.5-Pro-UltraSpeed',
    label: 'MiMo-V2.5-Pro-UltraSpeed（极速版）',
    deprecated: false,
  },
]

export const PROVIDER_CONFIG = {
  [DEEPSEEK_PROVIDER]: {
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com',
    envVar: 'DEEPSEEK_API_KEY',
    models: DEEPSEEK_MODELS,
    defaultModel: DEFAULT_DEEPSEEK_MODEL,
  },
  [MINIMAX_PROVIDER]: {
    label: 'MiniMax',
    baseURL: 'https://api.minimax.chat/v1',
    envVar: 'MINIMAX_API_KEY',
    models: MINIMAX_MODELS,
    defaultModel: DEFAULT_MINIMAX_MODEL,
  },
  [OPENAI_PROVIDER]: {
    label: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    envVar: 'OPENAI_API_KEY',
    models: OPENAI_MODELS,
    defaultModel: DEFAULT_OPENAI_MODEL,
  },
  [QWEN_PROVIDER]: {
    label: 'Qwen',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    envVar: 'DASHSCOPE_API_KEY',
    models: QWEN_MODELS,
    defaultModel: DEFAULT_QWEN_MODEL,
  },
  [MOONSHOT_PROVIDER]: {
    label: 'Moonshot',
    baseURL: 'https://api.moonshot.cn/v1',
    envVar: 'MOONSHOT_API_KEY',
    models: MOONSHOT_MODELS,
    defaultModel: DEFAULT_MOONSHOT_MODEL,
  },
  [ZHIPU_PROVIDER]: {
    label: '智谱 GLM',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    envVar: 'ZHIPU_API_KEY',
    models: ZHIPU_MODELS,
    defaultModel: DEFAULT_ZHIPU_MODEL,
  },
  [MIMO_PROVIDER]: {
    label: '小米 MiMo',
    baseURL: 'https://api.xiaomimimo.com/v1',
    envVar: 'MIMO_API_KEY',
    models: MIMO_MODELS,
    defaultModel: DEFAULT_MIMO_MODEL,
  },
}

export const AUTO_PROVIDER = 'auto'
export const PROBE_TIMEOUT_MS = 12000

export function normalizeModel(model, provider = DEEPSEEK_PROVIDER) {
  const pConfig = PROVIDER_CONFIG[provider] || PROVIDER_CONFIG[DEEPSEEK_PROVIDER]
  const value = String(model || '').trim()
  if (value) return value
  return pConfig.defaultModel
}

export function withCurrentModel(models, model) {
  const value = String(model || '').trim()
  if (!value || models.some(m => m?.id === value)) return models
  return [{ id: value, label: `${value} (custom)`, deprecated: false, custom: true }, ...models]
}

function isMoonshotKimiModel(model) {
  return String(model || '').trim().toLowerCase().startsWith('kimi-')
}

function isMoonshotThinkingAlwaysOnModel(model) {
  const value = String(model || '').trim().toLowerCase()
  return value === 'kimi-k2.7-code' || value === 'kimi-k2.7-code-highspeed'
}

function isMoonshotThinkingToggleSupportedModel(model) {
  const value = String(model || '').trim().toLowerCase()
  return value === 'kimi-k2.6' || value === 'kimi-k2.5'
}

export function shouldOmitSamplingForProviderModel(provider, model) {
  if (provider === OPENAI_PROVIDER && isOpenAIDefaultSamplingModel(model)) return true
  return provider === MOONSHOT_PROVIDER && isMoonshotKimiModel(model)
}

function isOpenAIDefaultSamplingModel(model) {
  const value = String(model || '').trim().toLowerCase()
  return value.startsWith('gpt-5') || /^o\d/.test(value)
}

export function shouldUseMaxCompletionTokensForProviderModel(provider, model) {
  if (provider !== OPENAI_PROVIDER) return false
  return isOpenAIDefaultSamplingModel(model)
}

export function shouldSendThinkingDisabledForProviderModel(provider, model) {
  if (provider === ZHIPU_PROVIDER) return true
  if (provider !== MOONSHOT_PROVIDER) return false
  return isMoonshotThinkingToggleSupportedModel(model) && !isMoonshotThinkingAlwaysOnModel(model)
}

export function getProviderModelFallbacks(provider, model) {
  const pConfig = PROVIDER_CONFIG[provider]
  if (!pConfig) return String(model || '').trim() ? [String(model).trim()] : []
  const primary = normalizeModel(model, provider)
  if (provider !== MIMO_PROVIDER) return [primary]

  const chain = [primary]
  for (const item of pConfig.models) {
    if (!item?.id || item.deprecated || chain.includes(item.id)) continue
    chain.push(item.id)
  }
  return chain
}

export function isThinkingEnabledForModel(model) {
  return normalizeModel(model) !== 'deepseek-chat'
}

export function getProvidersForAutoDetect() {
  return Object.entries(PROVIDER_CONFIG)
}

export function getProviderErrorMessage(err) {
  const status = err?.status ?? err?.response?.status
  const message = err?.message || String(err)
  return status ? `${status} ${message}` : message
}

export function isProviderAuthError(err) {
  const status = err?.status ?? err?.response?.status
  const message = err?.message || String(err)
  return status === 401 || /unauthoriz|invalid.*api.*key|authentication/i.test(message)
}

export function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export function buildPingParams(provider, model) {
  const pingParams = {
    model,
    messages: [{ role: 'user', content: 'Reply with exactly: hello' }],
    stream: false,
  }
  if (shouldUseMaxCompletionTokensForProviderModel(provider, model)) {
    pingParams.max_completion_tokens = 32
  } else {
    pingParams.max_tokens = 8
  }
  if (!shouldOmitSamplingForProviderModel(provider, model)) {
    pingParams.temperature = 0
  }
  if (provider === DEEPSEEK_PROVIDER) {
    pingParams.reasoning_effort = 'high'
    pingParams.thinking = { type: isThinkingEnabledForModel(model) ? 'enabled' : 'disabled' }
  } else if (provider === ZHIPU_PROVIDER) {
    pingParams.thinking = { type: 'disabled' }
  }
  return pingParams
}

export async function probeProvider(OpenAI, provider, apiKey, requestedModel) {
  const pConfig = PROVIDER_CONFIG[provider]
  const models = getProviderModelFallbacks(provider, requestedModel)
  const client = new OpenAI({
    apiKey,
    baseURL: pConfig.baseURL,
    timeout: PROBE_TIMEOUT_MS,
  })
  const errors = []
  for (const model of models) {
    try {
      await withTimeout(
        client.chat.completions.create(buildPingParams(provider, model)),
        PROBE_TIMEOUT_MS,
        provider,
      )
      return { provider, model, pConfig }
    } catch (err) {
      if (isProviderAuthError(err)) throw err
      errors.push(`${model}: ${getProviderErrorMessage(err)}`)
    }
  }
  throw new Error(`${provider} validation failed for models ${models.join(', ')}: ${errors.join(' | ')}`)
}

export async function detectProvider(OpenAI, apiKey, requestedModel) {
  const providers = getProvidersForAutoDetect()
  const errors = []

  return await new Promise((resolve, reject) => {
    let pending = providers.length
    for (const [provider] of providers) {
      probeProvider(OpenAI, provider, apiKey, requestedModel)
        .then(resolve)
        .catch((err) => {
          errors.push(`${provider}: ${getProviderErrorMessage(err)}`)
          pending -= 1
          if (pending === 0) {
            reject(new Error(`Could not identify the provider for this API key. Tried: ${providers.map(([name]) => name).join(', ')}. Last errors: ${errors.slice(-3).join(' | ')}`))
          }
        })
    }
  })
}
