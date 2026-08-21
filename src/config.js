import './network-proxy.js'
import fs from 'fs'
import path from 'path'
import { paths } from './paths.js'
import { nowTimestamp } from './time.js'
// P0-2：Provider 密钥加密存储（secret-store：Electron safeStorage / AES-GCM 兜底）
import { getSecret, setSecret } from './capabilities/secret-store.js'

// secret-store 引用键
export const SECRET_REF_LLM_KEY = 'llm.api_key'
export const SECRET_REF_MINIMAX_KEY = 'llm.minimax_key'

import {
  DEEPSEEK_PROVIDER, MINIMAX_PROVIDER, OPENAI_PROVIDER, MOONSHOT_PROVIDER, ZHIPU_PROVIDER, MIMO_PROVIDER,
  DEFAULT_DEEPSEEK_MODEL,
  DEEPSEEK_MODELS, MINIMAX_MODELS, OPENAI_MODELS, QWEN_MODELS, MOONSHOT_MODELS, ZHIPU_MODELS, MIMO_MODELS,
  PROVIDER_CONFIG, AUTO_PROVIDER, PROBE_TIMEOUT_MS,
  normalizeModel, withCurrentModel, isThinkingEnabledForModel,
  withTimeout, buildPingParams, probeProvider, detectProvider,
  shouldOmitSamplingForProviderModel, shouldUseMaxCompletionTokensForProviderModel,
  shouldSendThinkingDisabledForProviderModel, getProviderModelFallbacks, isLocalProvider,
} from "./config/models.js"

// 模型目录 / Provider 常量已拆分到 src/config/models.js；re-export 保持既有消费方兼容。
export {
  DEEPSEEK_PROVIDER, MINIMAX_PROVIDER, OPENAI_PROVIDER, QWEN_PROVIDER, MOONSHOT_PROVIDER, ZHIPU_PROVIDER, MIMO_PROVIDER, OLLAMA_PROVIDER,
  DEFAULT_DEEPSEEK_MODEL, DEFAULT_MINIMAX_MODEL, DEFAULT_OPENAI_MODEL, DEFAULT_QWEN_MODEL,
  DEFAULT_MOONSHOT_MODEL, DEFAULT_ZHIPU_MODEL, DEFAULT_MIMO_MODEL, DEFAULT_OLLAMA_MODEL,
  DEEPSEEK_MODELS, MINIMAX_MODELS, OPENAI_MODELS, QWEN_MODELS, MOONSHOT_MODELS, ZHIPU_MODELS, MIMO_MODELS, OLLAMA_MODELS,
  shouldOmitSamplingForProviderModel, shouldUseMaxCompletionTokensForProviderModel,
  shouldSendThinkingDisabledForProviderModel, getProviderModelFallbacks, isLocalProvider,
} from "./config/models.js"
// 旧版本用过、之后被改名/合并的 provider id → 现行 id。
// 作用：升级后老 config.json 里的旧 provider 名不会再让整份 LLM 配置作废（见下方分块容错加载），
// 而是平滑映射到新名。目前无已知改名，留作扩展点——以后任何 provider 改名都往这里加一行。
const LEGACY_PROVIDER_ALIASES = {
  // 'oldName': MOONSHOT_PROVIDER,
}

function resolveProviderId(provider) {
  const p = String(provider || '').trim()
  if (p === 'custom' || PROVIDER_CONFIG[p]) return p
  return LEGACY_PROVIDER_ALIASES[p] || p
}

function getLlmConfigFile(provider) {
  const p = resolveProviderId(provider)
  if (p !== 'custom' && !PROVIDER_CONFIG[p]) return null
  return path.join(paths.llmConfigDir, `${p}.json`)
}

function readLlmProviderConfig(provider) {
  const file = getLlmConfigFile(provider)
  if (!file) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
    return (parsed && typeof parsed === 'object') ? parsed : null
  } catch {
    return null
  }
}

function writeLlmProviderConfig(provider, record) {
  const file = getLlmConfigFile(provider)
  if (!file) throw new Error(`Unsupported provider: "${provider}"`)
  const tmp = `${file}.tmp`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf-8')
  fs.renameSync(tmp, file)
}

function resolveLlmRecord(raw, fallbackProvider) {
  if (!raw || typeof raw !== 'object') return null
  const provider = resolveProviderId(raw.provider || fallbackProvider)
  if (provider === 'custom') {
    if (typeof raw.baseURL !== 'string' || !raw.baseURL) return null
    if (typeof raw.model !== 'string' || !raw.model) return null
    return {
      provider,
      apiKey: typeof raw.apiKey === 'string' && raw.apiKey ? raw.apiKey : 'none',
      model: raw.model,
      baseURL: raw.baseURL,
    }
  }
  if (!PROVIDER_CONFIG[provider]) return null
  if (typeof raw.apiKey !== 'string' || !raw.apiKey) return null
  return { provider, apiKey: raw.apiKey, model: raw.model, baseURL: raw.baseURL }
}

// 只负责把 config.json 解析成对象；文件缺失或损坏才返回 null。
// 不在这里判断 LLM 块是否可用——那是加载逻辑的事，避免"一个字段不合法就丢掉整份文件、
// 连带把 voice/tts/security 等兄弟字段一起重置"（升级后最常见的"配置全没了"根因）。
function readParsedConfig() {
  try {
    if (!fs.existsSync(paths.configFile)) return null
    const parsed = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8'))
    return (parsed && typeof parsed === 'object') ? parsed : null
  } catch {
    return null
  }
}

// 判断旧版 config.json 里的 LLM 块能否直接激活（provider/apiKey/custom 三件套齐全）。
// 返回规整后的 { provider, apiKey, model, baseURL }（provider 已过别名映射）；不可用则返回 null。
function resolveLegacyStoredLlm(parsed) {
  if (!parsed || !parsed.provider) return null
  return resolveLlmRecord(parsed, parsed.provider)
}

function resolveStoredLlmForProvider(provider) {
  const p = resolveProviderId(provider)
  return resolveLlmRecord(readLlmProviderConfig(p), p)
}

function resolveStoredLlm(parsed) {
  if (!parsed || !parsed.provider) return null
  const provider = resolveProviderId(parsed.provider)
  return resolveStoredLlmForProvider(provider) || resolveLegacyStoredLlm(parsed)
}

function writeStoredConfig(obj) {
  const tmp = paths.configFile + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8')
  fs.renameSync(tmp, paths.configFile)
}

// 读出 config.json 现有内容（失败返回空对象）。
// activate() 等写操作必须基于它合并，否则会抹掉 voice/tts/security 等其它字段。
function readExistingStoredConfig() {
  try { return JSON.parse(fs.readFileSync(paths.configFile, 'utf-8')) || {} }
  catch { return {} }
}

// 顶级字段的"读-浅合并-写"一把梭。所有 setter 都该走它（或 readExistingStoredConfig），
// 把"写时必合并、绝不全量覆盖"变成不可绕过的约束，杜绝再次出现"改一个字段抹掉其它块"。
// 注意：浅合并无法删除键；需要删字段的 setter 仍自行 readExistingStoredConfig + 解构剔除后 writeStoredConfig。
function patchConfig(partial) {
  const merged = { ...readExistingStoredConfig(), ...partial }
  writeStoredConfig(merged)
  return merged
}

function withoutLegacyLlmFields(obj) {
  const {
    apiKey: _apiKey,
    model: _model,
    baseURL: _baseURL,
    activatedAt: _activatedAt,
    ...rest
  } = obj || {}
  return rest
}

function writeActiveLlmProvider(provider) {
  const base = withoutLegacyLlmFields(readExistingStoredConfig())
  writeStoredConfig({
    ...base,
    schemaVersion: CONFIG_SCHEMA_VERSION,
    provider,
  })
}

function persistLlmProviderConfig(record) {
  const provider = resolveProviderId(record?.provider)
  if (provider === 'custom') {
    writeLlmProviderConfig('custom', {
      provider: 'custom',
      apiKey: String(record.apiKey || '').trim() || 'none',
      model: String(record.model || '').trim(),
      baseURL: String(record.baseURL || '').trim(),
      activatedAt: record.activatedAt || new Date().toISOString(),
    })
    return
  }

  const pConfig = PROVIDER_CONFIG[provider]
  if (!pConfig) throw new Error(`Unsupported provider: "${provider}"`)
  writeLlmProviderConfig(provider, {
    provider,
    apiKey: String(record.apiKey || '').trim(),
    model: normalizeModel(record.model, provider),
    baseURL: undefined,
    activatedAt: record.activatedAt || new Date().toISOString(),
  })
}

const VOICE_PROVIDER_ALIASES = {
  macos: 'local',
  'macos-local': 'local',
  'local-macos': 'local',
  mac: 'local',
  native: 'local',
  cloud: 'aliyun',
  dashscope: 'aliyun',
  bailian: 'aliyun',
  paraformer: 'aliyun',
  volcano: 'volcengine',
  volc: 'volcengine',
  doubao: 'volcengine',
  bytedance: 'volcengine',
  iflytek: 'xunfei',
}
const VOICE_PROVIDERS = new Set(['local', 'aliyun', 'volcengine', 'tencent', 'xunfei'])
const VOICE_PROVIDER_KEYS = {
  local: ['lang', 'macosRecognitionMode'],
  aliyun: ['aliyunApiKey', 'aliyunAsrModel'],
  tencent: ['tencentSecretId', 'tencentSecretKey', 'tencentAppId'],
  xunfei: ['xunfeiAppId', 'xunfeiApiKey', 'xunfeiApiSecret'],
  volcengine: ['volcAsrApiKey', 'volcAsrAppKey', 'volcAsrAccessKey', 'volcAsrResourceId'],
}
const VOICE_CONFIG_KEYS = [
  'voiceProvider',
  ...Object.values(VOICE_PROVIDER_KEYS).flat(),
]
const VOICE_KEY_PROVIDER = new Map(
  Object.entries(VOICE_PROVIDER_KEYS).flatMap(([provider, keys]) => keys.map((key) => [key, provider]))
)

export function normalizeVoiceProvider(provider, fallback = 'aliyun') {
  const raw = String(provider || '').trim().toLowerCase()
  const normalized = VOICE_PROVIDER_ALIASES[raw] || raw
  return VOICE_PROVIDERS.has(normalized) ? normalized : fallback
}

function getVoiceActiveFile() {
  return path.join(paths.voiceConfigDir, 'active.json')
}

function getVoiceProviderConfigFile(provider) {
  const p = normalizeVoiceProvider(provider, null)
  if (!p) return null
  return path.join(paths.voiceConfigDir, `${p}.json`)
}

function readJsonObjectFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
    return (parsed && typeof parsed === 'object') ? parsed : null
  } catch {
    return null
  }
}

function writeJsonObjectFile(file, record) {
  const tmp = `${file}.tmp`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf-8')
  fs.renameSync(tmp, file)
}

function readVoiceProviderConfig(provider) {
  const file = getVoiceProviderConfigFile(provider)
  if (!file) return {}
  const parsed = readJsonObjectFile(file)
  return parsed || {}
}

function writeVoiceProviderConfig(provider, record) {
  const p = normalizeVoiceProvider(provider, null)
  const file = getVoiceProviderConfigFile(p)
  if (!p || !file) throw new Error(`Unsupported voice provider: "${provider}"`)
  writeJsonObjectFile(file, {
    ...record,
    provider: p,
    updatedAt: new Date().toISOString(),
  })
}

function writeActiveVoiceProvider(provider) {
  const p = normalizeVoiceProvider(provider, 'aliyun')
  writeJsonObjectFile(getVoiceActiveFile(), {
    provider: p,
    updatedAt: new Date().toISOString(),
  })
  return p
}

function readLegacyVoiceBlock(cfg = readExistingStoredConfig()) {
  return (cfg?.voice && typeof cfg.voice === 'object') ? cfg.voice : {}
}

function readActiveVoiceProvider(fallback = 'aliyun') {
  const active = readJsonObjectFile(getVoiceActiveFile())
  if (active?.provider) return normalizeVoiceProvider(active.provider, fallback)
  const legacy = readLegacyVoiceBlock()
  return normalizeVoiceProvider(legacy.voiceProvider || legacy.provider || fallback, fallback)
}

function stripLegacyVoiceBlock(cfg) {
  const { voice: _voice, ...rest } = cfg || {}
  return rest
}

function persistLegacyVoiceBlock(legacy) {
  if (!legacy || typeof legacy !== 'object') return
  const activeProvider = writeActiveVoiceProvider(legacy.voiceProvider || legacy.provider || 'aliyun')
  const buckets = new Map()
  for (const [key, value] of Object.entries(legacy)) {
    if (key === 'voiceProvider' || key === 'provider') continue
    if (!VOICE_CONFIG_KEYS.includes(key)) continue
    const trimmed = String(value || '').trim()
    if (!trimmed) continue
    const provider = VOICE_KEY_PROVIDER.get(key) || activeProvider
    const bucket = buckets.get(provider) || { ...readVoiceProviderConfig(provider), provider }
    bucket[key] = trimmed
    buckets.set(provider, bucket)
  }
  if (!buckets.has(activeProvider)) {
    buckets.set(activeProvider, { ...readVoiceProviderConfig(activeProvider), provider: activeProvider })
  }
  for (const [provider, record] of buckets) {
    writeVoiceProviderConfig(provider, record)
  }
}

function migrateLegacyVoiceConfig(cfg) {
  const legacy = readLegacyVoiceBlock(cfg)
  if (Object.keys(legacy).length) persistLegacyVoiceBlock(legacy)
  return stripLegacyVoiceBlock(cfg)
}

function shouldAllowEnvFallback() {
  return !process.versions?.electron
}

function loadFromEnv() {
  const deepseekKey = process.env['DEEPSEEK_API_KEY']
  if (deepseekKey) {
    return {
      provider: DEEPSEEK_PROVIDER,
      apiKey: deepseekKey,
      model: normalizeModel(process.env.DEEPSEEK_MODEL, DEEPSEEK_PROVIDER),
    }
  }
  const minimaxKey = process.env['MINIMAX_API_KEY']
  if (minimaxKey) {
    return {
      provider: MINIMAX_PROVIDER,
      apiKey: minimaxKey,
      model: normalizeModel(process.env.MINIMAX_MODEL, MINIMAX_PROVIDER),
    }
  }
  for (const [provider, pConfig] of Object.entries(PROVIDER_CONFIG)) {
    if (provider === DEEPSEEK_PROVIDER || provider === MINIMAX_PROVIDER) continue
    const key = process.env[pConfig.envVar]
    if (key) {
      return {
        provider,
        apiKey: key,
        model: normalizeModel(process.env[`${pConfig.envVar.replace(/_API_KEY$/, '')}_MODEL`], provider),
      }
    }
  }
  return null
}

function applyConfig(provider, apiKey, model, customBaseURL) {
  // P0-2：真实 key 同步写入 secret-store（加密），config.json 只留占位，明文不落地。
  if (typeof apiKey === 'string' && apiKey && apiKey !== 'none' && apiKey.length > 4) {
    try { setSecret(SECRET_REF_LLM_KEY, apiKey) } catch (e) { console.warn('[config] store llm key failed:', e?.message || e) }
  }
  if (provider === 'custom') {
    config.provider = 'custom'
    config.model = String(model || '').trim()
    config.apiKey = apiKey || 'none'
    config.baseURL = String(customBaseURL || '').trim()
    config.needsActivation = false
    return
  }
  const pConfig = PROVIDER_CONFIG[provider]
  config.provider = provider
  config.model = normalizeModel(model, provider)
  config.apiKey = apiKey
  config.baseURL = pConfig.baseURL
  config.needsActivation = false
}

// ── config.json schema 版本与迁移 ──
// 仿 db.js 的迁移规范：config.json 带一个 schemaVersion 字段，启动时按版本号顺序跑迁移、
// 跑完写回新版本号。把历史上零散、惰性触发的"一次性迁移"（如 seedance 拆分）收编到这里，
// 让升级路径确定、可测、可追溯，而不是散落在各 getter 里。
// 加新迁移：CONFIG_SCHEMA_VERSION 加 1，并在 CONFIG_MIGRATIONS 里补上对应版本号的函数。
const CONFIG_SCHEMA_VERSION = 3

// 每个迁移把传入的 config 对象升一级，返回新对象。允许带幂等副作用（如写独立文件）。
const CONFIG_MIGRATIONS = {
  // v0 → v1：把旧版塞在 config.json 里的 seedance 块拆到独立的 seedance.json，
  // 并从主配置移除该字段。等价于 migrateLegacySeedance，收编为正式、确定性的启动迁移。
  1(cfg) {
    const legacy = cfg?.seedance
    if (legacy && typeof legacy === 'object' && !fs.existsSync(paths.seedanceConfigFile)) {
      // 失败则抛出 → runConfigMigrations 中止且不写回版本号，下次启动重试（原子语义）。
      // 已存在 seedance.json 时跳过写入即可（幂等），剥离字段照常进行。
      writeSeedanceFile(legacy)
    }
    const { seedance: _drop, ...rest } = cfg
    return rest
  },
  // v1 → v2：LLM 凭据按 provider 拆到 userData/llm/<provider>.json。
  // config.json 只保留当前 provider 指针和 temperature/security/voice 等通用块。
  2(cfg) {
    const legacyLlm = resolveLegacyStoredLlm(cfg)
    if (legacyLlm) {
      const targetFile = getLlmConfigFile(legacyLlm.provider)
      if (targetFile && !fs.existsSync(targetFile)) {
        persistLlmProviderConfig({
          ...legacyLlm,
          activatedAt: cfg.activatedAt,
        })
      }
    }
    return withoutLegacyLlmFields(cfg)
  },
  // v2 → v3：ASR 语音识别凭据按厂商拆到 userData/voice/<provider>.json，
  // config.json 不再承载云端 ASR 密钥，只保留其它通用配置。
  3(cfg) {
    return migrateLegacyVoiceConfig(cfg)
  },
}

// 启动时执行一次。文件缺失/损坏则跳过（无可迁移）；任一迁移抛错则中止且不写回，
// 保留原文件，下次启动重试——宁可不迁，不可写坏。
function runConfigMigrations() {
  const parsed = readParsedConfig()
  if (!parsed) return
  const from = Number.isInteger(parsed.schemaVersion) ? parsed.schemaVersion : 0
  if (from >= CONFIG_SCHEMA_VERSION) return
  let cfg = parsed
  for (let v = from + 1; v <= CONFIG_SCHEMA_VERSION; v++) {
    const fn = CONFIG_MIGRATIONS[v]
    if (!fn) continue
    try { cfg = fn(cfg) || cfg }
    catch (e) { console.warn(`[config] schema 迁移 v${v} 失败，已中止并保留原文件:`, e.message); return }
  }
  cfg.schemaVersion = CONFIG_SCHEMA_VERSION
  try {
    writeStoredConfig(cfg)
    console.log(`[config] config.json schema 已从 v${from} 迁移到 v${CONFIG_SCHEMA_VERSION}`)
  } catch (e) {
    console.warn('[config] 写回迁移后的 config.json 失败:', e.message)
  }
}

export const config = {
  tickInterval: 20 * 60 * 1000, // default idle heartbeat: 20 minutes
  provider: null,
  model: null,
  apiKey: null,
  baseURL: null,
  needsActivation: true,
  temperature: 0.5,
  // ZeroClaw provider fallback chain 移植：当前 provider 在流出内容前失败（瞬时错误/超时）
  // 时，按此数组顺序尝试后备 provider（如 ['minimax', 'ollama']）。仅在明确配置时生效。
  llmFallbackChain: [],
  // 思考模式开关：true=向 provider 传 thinking enabled（深度由模型自控），false=thinking disabled。
  // 默认关闭——只有用户在设置里显式开启才思考。这是「用户显式选择」的开关，
  // 不是 runtime 按难度替模型决定开关 reasoning（那条路 index.js 已注释外掉）。
  thinking: false,
  security: {
    fileSandbox: true,
    execSandbox: true,
    blockedTools: [],
    // QwenPaw 安全四件套移植（security-guards.js）：
    //   shellGuard:  Shell 命令拦截等级 off/auto/smart/strict（默认 smart）
    //   fileGuard:   敏感文件路径拦截等级 off/auto/smart/strict（默认 smart）
    //   skillScan:   技能包内容扫描模式 off/warn/block（默认 warn）
    //   skillScanWhitelist: 跳过扫描的技能 id/名称白名单
    shellGuard: 'smart',
    fileGuard: 'smart',
    skillScan: 'warn',
    skillScanWhitelist: [],
    // ZeroClaw 工具回执：每条 action_log 附带 HMAC 签名回执（默认开启）
    toolReceipts: true,
    updatedAt: null,
  },
  network: {
    allowLanAccess: false,
    updatedAt: null,
  },
  // 工具结果压缩（TokenJuice）：超过阈值的「只读/信息型」工具结果进入模型前压成一行摘要，
  // 全文写 data/tool-outputs/<id>.txt 供模型按需 read_file 取回。省 token 且不丢细节。
  toolCompression: {
    enabled: true,
    threshold: 6000,   // 字符数；结果超过该值才压缩
    maxSaved: 100000,  // 落盘文件体上限（超出截断并标注）
  },
  // 通用长文压缩（text-compressor.js）：给任意长文本生成信息量足够、体量可控的浓缩版，
  // 当前用于工具结果摘要行的"内容预览"（大结果不只报字符数，还附一段摘要）。
  textCompression: {
    enabled: true,
    maxChars: 1200,    // 压缩后最大字符数（被工具结果摘要行进一步限制在 400 以内）
  },
}

// 迁移必须在下面读取/加载 config.json 之前跑完，确保后续逻辑看到的是已升级的结构。
runConfigMigrations()

// 加载顺序刻意分块容错：先无条件吃下 temperature / security 等"兄弟字段"，
// 再单独判断 LLM 块能否激活。这样即便 LLM 块因 provider 改名/缺字段而不可用，
// 也不会连带把沙盒开关、温度等其它配置一起重置——升级后最常见的"配置全没了"根因。
const parsedConfig = readParsedConfig()
if (parsedConfig) {
  if (typeof parsedConfig.temperature === 'number' && parsedConfig.temperature >= 0 && parsedConfig.temperature <= 2) {
    config.temperature = parsedConfig.temperature
  }
  // 缺字段（旧版升级 / 未开启过）按默认 false 处理 —— 无需 schema 迁移。
  if (typeof parsedConfig.thinking === 'boolean') {
    config.thinking = parsedConfig.thinking
  }
  if (Array.isArray(parsedConfig.llmFallbackChain)) {
    config.llmFallbackChain = parsedConfig.llmFallbackChain.filter(t => typeof t === 'string')
  }
  if (parsedConfig.security && typeof parsedConfig.security === 'object') {
    const s = parsedConfig.security
    if (typeof s.fileSandbox === 'boolean') config.security.fileSandbox = s.fileSandbox
    if (typeof s.execSandbox === 'boolean') config.security.execSandbox = s.execSandbox
    if (Array.isArray(s.blockedTools)) config.security.blockedTools = s.blockedTools
    if (typeof s.shellGuard === 'string') config.security.shellGuard = s.shellGuard
    if (typeof s.fileGuard === 'string') config.security.fileGuard = s.fileGuard
    if (typeof s.skillScan === 'string') config.security.skillScan = s.skillScan
    if (Array.isArray(s.skillScanWhitelist)) config.security.skillScanWhitelist = s.skillScanWhitelist
    if (typeof s.toolReceipts === 'boolean') config.security.toolReceipts = s.toolReceipts
    if (typeof s.updatedAt === 'string') config.security.updatedAt = s.updatedAt
  }
  if (parsedConfig.network && typeof parsedConfig.network === 'object') {
    const n = parsedConfig.network
    if (typeof n.allowLanAccess === 'boolean') config.network.allowLanAccess = n.allowLanAccess
    if (typeof n.updatedAt === 'string') config.network.updatedAt = n.updatedAt
  }
  if (parsedConfig.toolCompression && typeof parsedConfig.toolCompression === 'object') {
    const tc = parsedConfig.toolCompression
    if (typeof tc.enabled === 'boolean') config.toolCompression.enabled = tc.enabled
    if (Number.isFinite(Number(tc.threshold)) && Number(tc.threshold) >= 0) config.toolCompression.threshold = Number(tc.threshold)
    if (Number.isFinite(Number(tc.maxSaved)) && Number(tc.maxSaved) >= 0) config.toolCompression.maxSaved = Number(tc.maxSaved)
  }
  if (parsedConfig.textCompression && typeof parsedConfig.textCompression === 'object') {
    const txc = parsedConfig.textCompression
    if (typeof txc.enabled === 'boolean') config.textCompression.enabled = txc.enabled
    if (Number.isFinite(Number(txc.maxChars)) && Number(txc.maxChars) > 0) config.textCompression.maxChars = Number(txc.maxChars)
  }
}

const storedLlm = resolveStoredLlm(parsedConfig)
if (storedLlm) {
  // P0-2：config.json 里 apiKey 是占位（'none'）时，从 secret-store 取真实 key
  let effectiveKey = storedLlm.apiKey
  if (!effectiveKey || effectiveKey === 'none') {
    const secretKey = getSecret(SECRET_REF_LLM_KEY)
    if (secretKey) effectiveKey = secretKey
  }
  applyConfig(storedLlm.provider, effectiveKey, storedLlm.model, storedLlm.baseURL)
  if (storedLlm.provider !== 'custom' && storedLlm.model) {
    const normalized = normalizeModel(storedLlm.model, storedLlm.provider)
    if (normalized !== storedLlm.model) {
      console.warn(`[config] 已存模型 "${storedLlm.model}" 不在 ${storedLlm.provider} 当前列表，已回退到默认 "${normalized}"`)
    }
  }
} else if (shouldAllowEnvFallback()) {
  const fromEnv = loadFromEnv()
  if (fromEnv) applyConfig(fromEnv.provider, fromEnv.apiKey, fromEnv.model)
}

// P0-2：把 config.json 里的明文 Provider 密钥迁移到 secret-store（加密）。
// 复制 → 验证 round-trip → 才把 config.json 置占位，保证不丢 key。
function migrateConfigSecretsToStore() {
  try {
    const parsed = readParsedConfig()
    if (!parsed) return
    let changed = false
    const moves = [
      { ref: SECRET_REF_LLM_KEY, plainKey: 'apiKey' },
      { ref: SECRET_REF_MINIMAX_KEY, plainKey: 'minimax_api_key' },
    ]
    for (const { ref, plainKey } of moves) {
      const plain = typeof parsed[plainKey] === 'string' ? parsed[plainKey].trim() : ''
      if (!plain || plain === 'none') continue
      const stored = getSecret(ref)
      if (stored && stored !== plain) continue   // secret-store 有不同 key：不动 config.json（防误清）
      if (!stored) {
        setSecret(ref, plain)
        if (getSecret(ref) !== plain) continue   // 加密不可回读：不清明文，保住 key
      }
      parsed[plainKey] = 'none'                  // secret-store 已有同值或刚写入成功 → 清明文
      changed = true
    }
    if (changed) {
      try { fs.writeFileSync(paths.configFile, JSON.stringify(parsed, null, 2), 'utf-8') } catch (e) { console.warn('[config] migrate secrets write failed:', e?.message || e) }
      console.log('[config] Provider 密钥已迁移到加密 secret-store，config.json 明文已清除')
    }
  } catch (e) { console.warn('[config] migrate secrets failed:', e?.message || e) }
}
migrateConfigSecretsToStore()

// At startup, copy social credentials from the config file into process.env so connectors can read them
;(function loadSocialEnv() {
  try {
    const raw = fs.readFileSync(paths.configFile, 'utf-8')
    const social = JSON.parse(raw)?.social || {}
    for (const [key, val] of Object.entries(social)) {
      if (typeof val === 'string' && val && globalThis.process?.env) {
        globalThis.process.env[key] = val
      }
    }
  } catch (err) {
    // 配置损坏/不可读：社交凭据静默丢失会表现为"连接器连不上"，值得提示
    console.warn('[config] 读取社交配置失败（社交连接器可能不可用）:', err?.message || err)
  }
})()

export async function prepareActivation({ provider = AUTO_PROVIDER, apiKey, model, baseURL }) {
  const p = String(provider || AUTO_PROVIDER).toLowerCase()

  if (p === 'custom') {
    const normalizedBaseURL = String(baseURL || '').trim()
    if (!normalizedBaseURL) throw new Error('Custom endpoint requires a Base URL')
    const normalizedModel = String(model || '').trim()
    if (!normalizedModel) throw new Error('Custom endpoint requires a model name')
    const normalizedKey = String(apiKey || '').trim() || 'none'

    const { default: OpenAI } = await import('openai')
    const client = new OpenAI({ apiKey: normalizedKey, baseURL: normalizedBaseURL, timeout: PROBE_TIMEOUT_MS })
    try {
      await withTimeout(
        client.chat.completions.create({
          model: normalizedModel,
          messages: [{ role: 'user', content: 'Reply with exactly: hello' }],
          max_tokens: 16,
          temperature: 0,
          stream: false,
        }),
        PROBE_TIMEOUT_MS,
        'custom',
      )
    } catch (err) {
      const message = err?.message || String(err)
      throw new Error(`Custom endpoint connection failed: ${message}`, { cause: err })
    }

    return {
      provider: 'custom',
      apiKey: normalizedKey,
      model: normalizedModel,
      baseURL: normalizedBaseURL,
      models: [{ id: normalizedModel, label: normalizedModel, deprecated: false }],
    }
  }

  const pConfig = PROVIDER_CONFIG[p]
  if (p !== AUTO_PROVIDER && !pConfig) {
    throw new Error(`Unsupported provider: "${p}". Available: ${Object.keys(PROVIDER_CONFIG).join(', ')}`)
  }

  const normalizedKey = String(apiKey || '').trim()
  const normalizedModel = normalizeModel(model, p)
  // 本地 Provider（Ollama 等）无需 API Key：占位 key 即可，跳过长度校验。
  const local = isLocalProvider(p)
  if (!local && normalizedKey.length < 8) {
    throw new Error(`${p} key is invalid`)
  }
  const effectiveKey = local && !normalizedKey ? 'ollama' : normalizedKey

  const { default: OpenAI } = await import('openai')
  if (p === AUTO_PROVIDER) {
    const detected = await detectProvider(OpenAI, normalizedKey, model)
    return {
      provider: detected.provider,
      apiKey: normalizedKey,
      model: detected.model,
      baseURL: undefined,
      models: withCurrentModel(detected.pConfig.models, detected.model),
    }
  }

  let detected
  try {
    detected = await probeProvider(OpenAI, p, effectiveKey, normalizedModel)
  } catch (err) {
    const message = err?.message || String(err)
    if (/401|unauthoriz|invalid.*api.*key|authentication/i.test(message)) {
      throw new Error(`${p} key validation failed — please check that the key is correct`, { cause: err })
    }
    // 本地 Provider 连接失败给更友好的提示（通常就是 Ollama 没启动 / 模型没 pull）
    if (local) {
      throw new Error(`${p} 连接失败：请确认本地服务已启动（${PROVIDER_CONFIG[p].baseURL}）且已拉取模型。详情：${message}`, { cause: err })
    }
    throw new Error(`${p} validation failed: ${message}`, { cause: err })
  }

  return {
    provider: p,
    apiKey: effectiveKey,
    model: detected.model,
    baseURL: undefined,
    models: withCurrentModel(pConfig.models, detected.model),
  }
}

export function commitPreparedActivation(prepared) {
  const p = String(prepared?.provider || '').toLowerCase()

  if (p === 'custom') {
    const normalizedBaseURL = String(prepared.baseURL || '').trim()
    const normalizedModel = String(prepared.model || '').trim()
    const normalizedKey = String(prepared.apiKey || '').trim() || 'none'
    if (!normalizedBaseURL) throw new Error('Custom endpoint requires a Base URL')
    if (!normalizedModel) throw new Error('Custom endpoint requires a model name')

    applyConfig('custom', normalizedKey, normalizedModel, normalizedBaseURL)
    persistLlmProviderConfig({
      provider: 'custom',
      apiKey: normalizedKey,
      model: normalizedModel,
      baseURL: normalizedBaseURL,
      activatedAt: new Date().toISOString(),
    })
    writeActiveLlmProvider('custom')
    return {
      provider: 'custom',
      model: normalizedModel,
      models: [{ id: normalizedModel, label: normalizedModel, deprecated: false }],
    }
  }

  const pConfig = PROVIDER_CONFIG[p]
  if (!pConfig) {
    throw new Error(`Unsupported provider: "${p}". Available: ${Object.keys(PROVIDER_CONFIG).join(', ')}`)
  }

  const normalizedKey = String(prepared.apiKey || '').trim()
  const normalizedModel = normalizeModel(prepared.model, p)
  if (normalizedKey.length < 8) {
    throw new Error(`${p} key is invalid`)
  }

  applyConfig(p, normalizedKey, normalizedModel)
  persistLlmProviderConfig({
    provider: p,
    apiKey: normalizedKey,
    model: normalizedModel,
    activatedAt: new Date().toISOString(),
  })
  writeActiveLlmProvider(p)

  return {
    provider: p,
    model: normalizedModel,
    models: withCurrentModel(pConfig.models, normalizedModel),
  }
}

export async function activate({ provider = AUTO_PROVIDER, apiKey, model, baseURL }) {
  const prepared = await prepareActivation({ provider, apiKey, model, baseURL })
  return commitPreparedActivation(prepared)
}

export function getActivationStatus() {
  const pConfig = config.provider && config.provider !== 'custom' ? PROVIDER_CONFIG[config.provider] : null
  const customModels = config.model ? [{ id: config.model, label: config.model, deprecated: false }] : DEEPSEEK_MODELS
  return {
    activated: !config.needsActivation,
    provider: config.provider,
    model: config.model,
    baseURL: config.provider === 'custom' ? config.baseURL : undefined,
    models: pConfig ? withCurrentModel(pConfig.models, config.model) : customModels,
    defaultModel: pConfig ? pConfig.defaultModel : (config.model || DEFAULT_DEEPSEEK_MODEL),
  }
}

// P0-2：密钥脱敏 —— 接口/日志只暴露"是否已配置 + 后 4 位"，不暴露明文。
export function maskSecret(value) {
  const s = String(value || '')
  if (!s) return ''
  if (s.length <= 8) return '••••'
  return '••••' + s.slice(-4)
}

export function getProviderSummaries() {
  const result = Object.fromEntries(Object.entries(PROVIDER_CONFIG).map(([name, pConfig]) => [
    name,
    (() => {
      const stored = resolveStoredLlmForProvider(name)
      const local = !!pConfig.local
      return {
        label: pConfig.label || name,
        models: withCurrentModel(pConfig.models, stored?.model),
        defaultModel: pConfig.defaultModel,
        configured: local || !!stored,
        apiKey: local ? '' : maskSecret(stored?.apiKey),
        model: stored?.model ? normalizeModel(stored.model, name) : pConfig.defaultModel,
        local: local || undefined,
      }
    })(),
  ]))
  const custom = resolveStoredLlmForProvider('custom')
  result.custom = {
    label: 'Custom Endpoint',
    models: [],
    defaultModel: '',
    configured: !!custom,
    apiKey: custom?.apiKey || '',
    model: custom?.model || '',
    baseURL: custom?.baseURL || '',
  }
  return result
}

export function deactivate() {
  try {
    if (fs.existsSync(paths.configFile)) fs.unlinkSync(paths.configFile)
  } catch (e) { console.warn('[src/config.js] op failed:', e?.message || e) }
  config.provider = null
  config.model = null
  config.apiKey = null
  config.baseURL = null
  config.needsActivation = true
}

export function switchModel(model) {
  if (!config.apiKey) throw new Error('Not activated — cannot switch model')
  if (config.provider === 'custom') {
    const trimmed = String(model || '').trim()
    if (!trimmed) throw new Error('Model name cannot be empty')
    config.model = trimmed
    persistLlmProviderConfig({
      provider: 'custom',
      apiKey: config.apiKey,
      model: trimmed,
      baseURL: config.baseURL,
      activatedAt: readLlmProviderConfig('custom')?.activatedAt,
    })
    return { provider: 'custom', model: trimmed }
  }
  const normalized = normalizeModel(model, config.provider)
  config.model = normalized
  persistLlmProviderConfig({
    provider: config.provider,
    apiKey: config.apiKey,
    model: normalized,
    activatedAt: readLlmProviderConfig(config.provider)?.activatedAt,
  })
  return { provider: config.provider, model: normalized }
}

export function switchProviderConfig({ provider, model } = {}) {
  const p = resolveProviderId(provider)
  if (p === AUTO_PROVIDER) throw new Error('Auto-detect requires an API key')
  // 本地 Provider（Ollama）无 Key：未保存配置时用占位记录即可，无需先激活。
  const local = !!PROVIDER_CONFIG[p]?.local
  const stored = resolveStoredLlmForProvider(p) || (local ? { apiKey: 'ollama', model: model || PROVIDER_CONFIG[p]?.defaultModel || null } : null)
  if (!stored) {
    throw new Error(`No saved ${p} configuration. Enter the API key once to save it.`)
  }

  if (p === 'custom') {
    const nextModel = String(model || stored.model || '').trim()
    if (!nextModel) throw new Error('Model name cannot be empty')
    applyConfig('custom', stored.apiKey || 'none', nextModel, stored.baseURL)
    persistLlmProviderConfig({
      provider: 'custom',
      apiKey: stored.apiKey || 'none',
      model: nextModel,
      baseURL: stored.baseURL,
      activatedAt: readLlmProviderConfig('custom')?.activatedAt,
    })
    writeActiveLlmProvider('custom')
    return {
      provider: 'custom',
      model: nextModel,
      models: [{ id: nextModel, label: nextModel, deprecated: false }],
    }
  }

  const nextModel = normalizeModel(model || stored.model, p)
  applyConfig(p, stored.apiKey, nextModel)
  persistLlmProviderConfig({
    provider: p,
    apiKey: stored.apiKey,
    model: nextModel,
    activatedAt: readLlmProviderConfig(p)?.activatedAt,
  })
  writeActiveLlmProvider(p)
  return {
    provider: p,
    model: nextModel,
    models: withCurrentModel(PROVIDER_CONFIG[p].models, nextModel),
  }
}

export async function saveLLMSettings({ provider = AUTO_PROVIDER, apiKey, model, baseURL } = {}) {
  const p = String(provider || AUTO_PROVIDER).toLowerCase()
  const trimmedKey = String(apiKey || '').trim()

  if (p === 'custom') {
    const stored = resolveStoredLlmForProvider('custom')
    const nextKey = trimmedKey || stored?.apiKey || 'none'
    const nextModel = String(model || stored?.model || '').trim()
    const nextBaseURL = String(baseURL || stored?.baseURL || '').trim()
    const prepared = await prepareActivation({
      provider: 'custom',
      apiKey: nextKey,
      model: nextModel,
      baseURL: nextBaseURL,
    })
    return commitPreparedActivation(prepared)
  }

  if (trimmedKey || p === AUTO_PROVIDER) {
    if (!trimmedKey) throw new Error('API key is required to auto-detect a provider')
    const prepared = await prepareActivation({
      provider: p,
      apiKey: trimmedKey,
      model,
    })
    return commitPreparedActivation(prepared)
  }

  return switchProviderConfig({ provider: p, model })
}

export function setTemperature(t) {
  const v = Math.min(2, Math.max(0, Number(t) || 0.5))
  config.temperature = v
  patchConfig({ temperature: v })
  return { temperature: v }
}

export function setThinking(enabled) {
  const v = !!enabled
  config.thinking = v
  patchConfig({ thinking: v })
  return { thinking: v }
}

export function getSecurity() {
  return {
    fileSandbox: config.security.fileSandbox,
    execSandbox: config.security.execSandbox,
    blockedTools: [...config.security.blockedTools],
    shellGuard: config.security.shellGuard || 'smart',
    fileGuard: config.security.fileGuard || 'smart',
    skillScan: config.security.skillScan || 'warn',
    skillScanWhitelist: [...(config.security.skillScanWhitelist || [])],
    toolReceipts: config.security.toolReceipts !== false,
    updatedAt: config.security.updatedAt || null,
  }
}

export function setSecurity(updates) {
  const before = getSecurity()
  if (typeof updates.fileSandbox === 'boolean') config.security.fileSandbox = updates.fileSandbox
  if (typeof updates.execSandbox === 'boolean') config.security.execSandbox = updates.execSandbox
  if (Array.isArray(updates.blockedTools)) {
    config.security.blockedTools = updates.blockedTools.filter(t => typeof t === 'string')
  }
  if (typeof updates.shellGuard === 'string') config.security.shellGuard = updates.shellGuard
  if (typeof updates.fileGuard === 'string') config.security.fileGuard = updates.fileGuard
  if (typeof updates.skillScan === 'string') config.security.skillScan = updates.skillScan
  if (Array.isArray(updates.skillScanWhitelist)) {
    config.security.skillScanWhitelist = updates.skillScanWhitelist.filter(t => typeof t === 'string')
  }
  if (typeof updates.toolReceipts === 'boolean') config.security.toolReceipts = updates.toolReceipts
  const changed = before.fileSandbox !== config.security.fileSandbox
    || before.execSandbox !== config.security.execSandbox
    || before.shellGuard !== config.security.shellGuard
    || before.fileGuard !== config.security.fileGuard
    || before.skillScan !== config.security.skillScan
    || before.toolReceipts !== config.security.toolReceipts
    || JSON.stringify(before.skillScanWhitelist) !== JSON.stringify(config.security.skillScanWhitelist)
    || JSON.stringify(before.blockedTools) !== JSON.stringify(config.security.blockedTools)
  if (changed) config.security.updatedAt = nowTimestamp()
  patchConfig({ security: { ...config.security } })
  return getSecurity()
}

export function getNetworkConfig() {
  return {
    allowLanAccess: !!config.network.allowLanAccess,
    updatedAt: config.network.updatedAt || null,
  }
}

// 工具结果压缩配置：阈值/开关。供 llm.js 在把大工具结果写入模型上下文前调用。
export function getToolCompressionConfig() {
  return {
    enabled: !!config.toolCompression.enabled,
    threshold: Number(config.toolCompression.threshold) || 6000,
    maxSaved: Number(config.toolCompression.maxSaved) || 100000,
  }
}

export function setToolCompressionConfig(updates) {
  if (typeof updates.enabled === 'boolean') config.toolCompression.enabled = updates.enabled
  if (Number.isFinite(Number(updates.threshold))) {
    const v = Number(updates.threshold)
    config.toolCompression.threshold = v >= 0 ? v : config.toolCompression.threshold
  }
  if (Number.isFinite(Number(updates.maxSaved))) {
    const v = Number(updates.maxSaved)
    config.toolCompression.maxSaved = v >= 0 ? v : config.toolCompression.maxSaved
  }
  patchConfig({ toolCompression: { ...config.toolCompression } })
  return getToolCompressionConfig()
}

// 通用长文压缩配置：开关 + 压缩后最大字符数。
export function getTextCompressionConfig() {
  return {
    enabled: !!config.textCompression.enabled,
    maxChars: Number(config.textCompression.maxChars) || 1200,
  }
}

export function setTextCompressionConfig(updates) {
  if (typeof updates.enabled === 'boolean') config.textCompression.enabled = updates.enabled
  if (Number.isFinite(Number(updates.maxChars))) {
    const v = Number(updates.maxChars)
    config.textCompression.maxChars = v > 0 ? v : config.textCompression.maxChars
  }
  patchConfig({ textCompression: { ...config.textCompression } })
  return getTextCompressionConfig()
}

export function setNetworkConfig(updates) {
  const before = getNetworkConfig()
  if (typeof updates.allowLanAccess === 'boolean') {
    config.network.allowLanAccess = updates.allowLanAccess
  }
  const changed = before.allowLanAccess !== config.network.allowLanAccess
  if (changed) config.network.updatedAt = nowTimestamp()
  patchConfig({ network: { ...config.network } })
  return {
    ...getNetworkConfig(),
    restartRequired: changed,
  }
}

export function getMinimaxKey() {
  // P0-2：secret-store 优先（加密），回退 config.json/env
  const fromSecret = getSecret(SECRET_REF_MINIMAX_KEY)
  if (fromSecret) return fromSecret
  try {
    const raw = fs.readFileSync(paths.configFile, 'utf-8')
    const parsed = JSON.parse(raw)
    return typeof parsed?.minimax_api_key === 'string' ? parsed.minimax_api_key : null
  } catch { return null }
}

export function setMinimaxKey(key) {
  const trimmed = String(key || '').trim()
  if (trimmed) {
    setSecret(SECRET_REF_MINIMAX_KEY, trimmed)   // P0-2：加密存储
    patchConfig({ minimax_api_key: 'none' })      // 明文位置置占位，下次启动迁移/读取走 secret-store
  } else {
    deleteSecretRef(SECRET_REF_MINIMAX_KEY)
    const { minimax_api_key: _removed, ...rest } = readExistingStoredConfig()
    writeStoredConfig(rest)
  }
}

// P0-2：删除 secret-store 引用（setSecret('') 等效）
function deleteSecretRef(ref) {
  try { setSecret(ref, '') } catch (e) { console.warn('[config] delete secret failed:', e?.message || e) }
}

// ── Seedance AI 视频生成（火山方舟 Ark）配置 ──
// 存于 config.json 的 seedance 字段：{ apiKey, model, baseURL }
// 中国区默认走 ark.cn-beijing.volces.com；model 是 doubao-* 形态的模型 ID 或推理接入点 ep-xxx，
// 因不同账号开通的版本号不同，做成可配置，给一个合理默认值，错了由调用错误回传引导用户改。
const SEEDANCE_DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'
const SEEDANCE_DEFAULT_MODEL = 'doubao-seedance-2-0-260128'

// seedance.json 读写（独立文件，只放 seedance 配置，谁都不会全量覆盖它）
function readSeedanceFile() {
  try { return JSON.parse(fs.readFileSync(paths.seedanceConfigFile, 'utf-8')) || {} }
  catch { return {} }
}
function writeSeedanceFile(obj) {
  const tmp = paths.seedanceConfigFile + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8')
  fs.renameSync(tmp, paths.seedanceConfigFile)
}

// 一次性迁移：旧版把 seedance 存在 config.json 里。若独立文件尚无、而 config.json 里还有，
// 就搬过去并从 config.json 删除该字段，之后只认独立文件。
function migrateLegacySeedance() {
  if (fs.existsSync(paths.seedanceConfigFile)) return
  let mainCfg
  try { mainCfg = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8')) } catch { return }
  const legacy = mainCfg?.seedance
  if (!legacy || typeof legacy !== 'object') return
  try {
    writeSeedanceFile(legacy)
    const { seedance: _removed, ...rest } = mainCfg
    writeStoredConfig(rest)
    console.log('[config] 已把旧的 seedance 配置从 config.json 迁移到 seedance.json')
  } catch (e) {
    console.warn('[config] seedance 迁移失败:', e.message)
  }
}

export function getSeedanceConfig() {
  // 环境变量优先（ARK_API_KEY），方便开发/部署注入
  const envKey = String(process.env.ARK_API_KEY || process.env.SEEDANCE_API_KEY || '').trim()
  migrateLegacySeedance()
  const stored = readSeedanceFile()
  const apiKey = envKey || String(stored.apiKey || '').trim()
  return {
    apiKey,
    model: String(stored.model || '').trim() || SEEDANCE_DEFAULT_MODEL,
    baseURL: String(stored.baseURL || '').trim() || SEEDANCE_DEFAULT_BASE_URL,
    configured: Boolean(apiKey),
  }
}

export function isSeedanceConfigured() {
  return getSeedanceConfig().configured
}

export function setSeedanceConfig({ apiKey, model, baseURL } = {}) {
  migrateLegacySeedance()
  const next = { ...readSeedanceFile() }
  if (apiKey !== undefined) next.apiKey = String(apiKey || '').trim()
  if (model !== undefined) next.model = String(model || '').trim()
  if (baseURL !== undefined) next.baseURL = String(baseURL || '').trim()
  // 没有 key 时删掉独立文件，保持干净
  if (!next.apiKey) {
    try { fs.rmSync(paths.seedanceConfigFile, { force: true }) } catch (e) { console.warn('[src/config.js] op failed:', e?.message || e) }
    return getSeedanceConfig()
  }
  writeSeedanceFile(next)
  return getSeedanceConfig()
}

// ── Social media platform config ──

const SOCIAL_ENV_KEYS = [
  'DISCORD_BOT_TOKEN',
  'FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_VERIFICATION_TOKEN',
  'WECHAT_OFFICIAL_APP_ID', 'WECHAT_OFFICIAL_APP_SECRET', 'WECHAT_OFFICIAL_TOKEN',
  'WECOM_BOT_KEY', 'WECOM_INCOMING_TOKEN',
]

// ── WeChat ClawBot credentials (written automatically after QR scan, not exposed in SOCIAL_ENV_KEYS) ──

export function getClawbotCredentials() {
  try {
    const stored = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8'))
    const c = stored?.clawbot
    return (c?.accountId && c?.botToken) ? c : null
  } catch { return null }
}

export function setClawbotCredentials({ accountId, botToken, baseUrl }) {
  patchConfig({ clawbot: { accountId, botToken, baseUrl } })
}

export function clearClawbotCredentials() {
  const { clawbot: _, ...rest } = readExistingStoredConfig()
  writeStoredConfig(rest)
}

export function getSocialConfig() {
  let stored = {}
  try { stored = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8'))?.social || {} } catch (err) {
    console.warn('[config] 读取社交配置失败:', err?.message || err)
  }
  const result = {}
  for (const key of SOCIAL_ENV_KEYS) {
    const val = stored[key] || globalThis.process?.env?.[key] || ''
    result[key] = { configured: !!val }
  }
  return result
}

export function setSocialConfig(updates) {
  const existing = readExistingStoredConfig()
  const current = existing.social || {}
  const next = { ...current }
  for (const [key, val] of Object.entries(updates || {})) {
    if (!SOCIAL_ENV_KEYS.includes(key)) continue
    const trimmed = String(val || '').trim()
    if (trimmed) {
      next[key] = trimmed
      // Take effect immediately without restart
      if (globalThis.process?.env) globalThis.process.env[key] = trimmed
    } else {
      delete next[key]
    }
  }
  writeStoredConfig({ ...existing, social: next })
}

function isValidAliyunAsrKey(value) {
  return /^sk-[A-Za-z0-9_\-.]{20,}$/.test(String(value || '').trim())
}

const CHAT_PROVIDERS_WITH_AMBIGUOUS_SK_KEYS = new Set([
  DEEPSEEK_PROVIDER,
  MINIMAX_PROVIDER,
  OPENAI_PROVIDER,
  MOONSHOT_PROVIDER,
  ZHIPU_PROVIDER,
  MIMO_PROVIDER,
])

export function getVoiceConfig() {
  const result = { voiceProvider: readActiveVoiceProvider('aliyun') }
  for (const key of VOICE_CONFIG_KEYS) {
    if (key === 'voiceProvider') continue
    const provider = VOICE_KEY_PROVIDER.get(key) || result.voiceProvider
    const stored = readVoiceProviderConfig(provider)
    result[key] = { configured: !!stored[key] }
    if (key === 'aliyunApiKey' && stored[key]) {
      result[key] = {
        configured: isValidAliyunAsrKey(stored[key]),
        invalidFormat: !isValidAliyunAsrKey(stored[key]),
      }
    }
    if (key === 'volcAsrApiKey' && stored[key]) {
      // The desktop settings UI intentionally lets its owner review this value.
      // Keep other voice secrets redacted from the API response.
      result[key] = { configured: true, value: stored[key] }
    }
  }
  return result
}

export function getVoiceRuntimeConfig(providerHint = null) {
  // 显式 hint（例如前端请求的服务商）优先；无效时回退到 active provider。
  // 旧实现把 hint 当 fallback 只在 active.json 缺失时使用，导致主动切换服务商时
  // 读到的是 active 服务商的凭证，而不是请求的服务商。
  const hint = normalizeVoiceProvider(providerHint, null)
  const provider = hint || readActiveVoiceProvider('aliyun')
  const stored = readVoiceProviderConfig(provider)
  return {
    ...stored,
    voiceProvider: provider,
    provider,
  }
}

export function setVoiceConfig(updates) {
  const existing = readExistingStoredConfig()
  const { voice: legacyVoice, ...baseConfig } = existing
  let activeProvider = readActiveVoiceProvider(legacyVoice?.voiceProvider || legacyVoice?.provider || 'aliyun')
  const requestedProvider = updates?.voiceProvider ?? updates?.provider
  if (requestedProvider !== undefined) {
    activeProvider = normalizeVoiceProvider(requestedProvider, activeProvider)
  }
  activeProvider = writeActiveVoiceProvider(activeProvider)
  const changedProviders = new Map()
  for (const [key, val] of Object.entries(updates)) {
    if (key === 'provider') continue
    if (!VOICE_CONFIG_KEYS.includes(key)) continue
    const trimmed = String(val || '').trim()
    if (key === 'voiceProvider') {
      continue
    }
    if (key === 'aliyunApiKey' && trimmed && !isValidAliyunAsrKey(trimmed)) {
      console.warn('[voice-config] Ignoring invalid Aliyun ASR key format; expected DashScope sk-* API key')
      continue
    }
    if (
      key === 'aliyunApiKey' &&
      trimmed &&
      existing.apiKey &&
      trimmed === existing.apiKey &&
      CHAT_PROVIDERS_WITH_AMBIGUOUS_SK_KEYS.has(existing.provider)
    ) {
      console.warn('[voice-config] Ignoring Aliyun ASR key because it matches the active chat provider API key')
      continue
    }
    const provider = VOICE_KEY_PROVIDER.get(key) || activeProvider
    const record = changedProviders.get(provider) || { ...readVoiceProviderConfig(provider), provider }
    if (trimmed) record[key] = trimmed
    else delete record[key]
    changedProviders.set(provider, record)
  }
  for (const [provider, record] of changedProviders) {
    writeVoiceProviderConfig(provider, record)
  }
  writeStoredConfig({
    ...baseConfig,
    schemaVersion: CONFIG_SCHEMA_VERSION,
  })
}

// TTS config
const TTS_CONFIG_KEYS = [
  'ttsProvider', 'ttsVoiceId',
  'minimaxKey',
  'doubaoKey', 'doubaoResourceId', 'doubaoSpeechRate',
  'openaiTtsKey', 'openaiTtsBaseURL',
  'elevenLabsKey',
  'volcanoAppId', 'volcanoToken',
]

export function getTTSConfig() {
  let stored = {}
  try { stored = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8'))?.tts || {} } catch (err) {
    console.warn('[config] 读取 TTS 配置失败（回退默认）:', err?.message || err)
  }
  return {
    ttsProvider:     stored.ttsProvider  || 'doubao',
    ttsVoiceId:      stored.ttsVoiceId   || 'zh_female_xiaohe_uranus_bigtts',
    minimaxKey:      { configured: !!(stored.minimaxKey || process.env.MINIMAX_API_KEY || getMinimaxKey()) },
    doubaoKey:       { configured: !!(stored.doubaoKey), value: stored.doubaoKey || '' },
    doubaoResourceId: stored.doubaoResourceId || '',
    doubaoSpeechRate: Number(stored.doubaoSpeechRate || 0) || 0,
    openaiTtsBaseURL: stored.openaiTtsBaseURL || '',
    openaiTtsKey:    { configured: !!(stored.openaiTtsKey) },
    elevenLabsKey:   { configured: !!(stored.elevenLabsKey) },
    volcanoAppId:    { configured: !!(stored.volcanoAppId), value: stored.volcanoAppId || '' },
    volcanoToken:    { configured: !!(stored.volcanoToken) },
  }
}

// Read plaintext TTS credentials (backend use only — not exposed to frontend)
export function getTTSCredentials() {
  let stored = {}
  try { stored = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8'))?.tts || {} } catch (err) {
    console.warn('[config] 读取 TTS 凭据失败:', err?.message || err)
  }
  return {
    provider:       stored.ttsProvider  || 'doubao',
    voiceId:        stored.ttsVoiceId   || 'zh_female_xiaohe_uranus_bigtts',
    doubaoKey:      stored.doubaoKey    || process.env.DOUBAO_TTS_API_KEY || '',
    doubaoResourceId: stored.doubaoResourceId || process.env.DOUBAO_TTS_RESOURCE_ID || '',
    doubaoSpeechRate: Number(stored.doubaoSpeechRate ?? process.env.DOUBAO_TTS_SPEECH_RATE ?? 0) || 0,
    minimaxKey:     process.env.MINIMAX_API_KEY || stored.minimaxKey || getMinimaxKey() || (config.provider === 'minimax' ? config.apiKey : '') || '',
    openaiKey:      stored.openaiTtsKey  || '',
    openaiBaseURL:  stored.openaiTtsBaseURL || '',
    elevenLabsKey:  stored.elevenLabsKey || '',
    volcanoAppId:   stored.volcanoAppId  || '',
    volcanoToken:   stored.volcanoToken  || '',
  }
}

export function setTTSConfig(updates) {
  const existing = readExistingStoredConfig()
  const current = existing.tts || {}
  const next = { ...current }
  for (const [key, val] of Object.entries(updates)) {
    if (!TTS_CONFIG_KEYS.includes(key)) continue
    const trimmed = String(val || '').trim()
    if (trimmed) next[key] = trimmed
    else delete next[key]
  }
  writeStoredConfig({ ...existing, tts: next })
}

// ── Embedding config ──────────────────────────────────────────────────────────
// 记忆向量召回只用本地离线模型（transformers.js + onnxruntime-node 跑 ONNX），不依赖任何云端 API。
// 零配置开箱即用：config.json 的 "embedding" 块可不存在；存在时仅 model / timeoutMs 有意义。
//   model:     本地 ONNX 模型 HF 仓库 id（缺省走 LOCAL_DEFAULT_MODEL）
//   timeoutMs: 可选，覆盖向量召回硬超时（默认 1500ms）
// 首次运行会下载 ~330MB 中文嵌入模型到 userData/data/models，之后离线可用。

const EMBEDDING_CONFIG_KEYS = ['model', 'timeoutMs']

// 本地默认模型：中文为主、量化后体积/速度均衡的小型 ONNX 模型。
const LOCAL_DEFAULT_MODEL = 'Xenova/bge-large-zh-v1.5'
const LOCAL_DEFAULT_DIMS = 1024

// 解析有效本地模型名：只认 HF 仓库 id 形态（owner/name），过滤掉残留的云端模型名
// （如 'text-embedding-3-small'），避免拿云端名当本地模型加载导致召回静默失效。
function resolveLocalModel(stored) {
  const m = typeof stored?.model === 'string' ? stored.model.trim() : ''
  return /^[^/\s]+\/[^/\s]+$/.test(m) ? m : LOCAL_DEFAULT_MODEL
}

// 仅保留 local 预设（云端 provider 已移除）。供 api 的 /settings/embedding 视图使用。
export const EMBEDDING_PROVIDER_PRESETS = {
  local: { baseURL: '', defaultModel: LOCAL_DEFAULT_MODEL, defaultDims: LOCAL_DEFAULT_DIMS, local: true },
}

let _embeddingBlockCache = null
let _embeddingBlockCacheMtime = -1

function readEmbeddingBlock() {
  let mtime
  try {
    mtime = fs.statSync(paths.configFile).mtimeMs
  } catch {
    // config 文件不存在或访问失败：直接返回 {}，不缓存（让下次有机会重试）
    return {}
  }

  if (_embeddingBlockCache !== null && mtime === _embeddingBlockCacheMtime) {
    return _embeddingBlockCache
  }

  let block = {}
  try {
    const raw = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8'))
    if (raw?.embedding && typeof raw.embedding === 'object') {
      block = raw.embedding
    }
  } catch {
    block = {}
  }

  _embeddingBlockCache = block
  _embeddingBlockCacheMtime = mtime
  return block
}

// 前端可见视图。provider 恒为 'local'，model 缺省走默认，永远 configured=true（零配置）。
export function getEmbeddingConfig() {
  const stored = readEmbeddingBlock()
  const model = resolveLocalModel(stored)
  const timeoutMs = Number.isFinite(stored.timeoutMs) ? stored.timeoutMs : null
  return { provider: 'local', model, dimensions: LOCAL_DEFAULT_DIMS, timeoutMs, configured: true }
}

// Backend-only：供 src/embedding.js 内部用。强制本地，忽略任何残留的云端字段。
export function getEmbeddingCredentials() {
  const stored = readEmbeddingBlock()
  const model = resolveLocalModel(stored)
  return {
    provider: 'local',
    model,
    apiKey: '',
    baseURL: '',
    dimensions: LOCAL_DEFAULT_DIMS,
    timeoutMs: Number.isFinite(stored.timeoutMs) ? stored.timeoutMs : null,
  }
}

export function setEmbeddingConfig(updates) {
  const existing = readExistingStoredConfig()
  const current = existing.embedding || {}
  const next = { ...current }
  for (const [key, val] of Object.entries(updates || {})) {
    if (!EMBEDDING_CONFIG_KEYS.includes(key)) continue
    if (key === 'dimensions' || key === 'timeoutMs') {
      const n = Number(val)
      if (Number.isFinite(n) && n > 0) next[key] = n
      else delete next[key]
      continue
    }
    const trimmed = String(val || '').trim()
    if (trimmed) next[key] = trimmed
    else delete next[key]
  }
  writeStoredConfig({ ...existing, embedding: next })
}

// ── Web Search 配置 ──
// 顶级字段（与现有 serper_api_key 兼容），不嵌套到子块
// 字段：serper_api_key / searxng_url / jina_api_key
const WEB_SEARCH_KEY_MAP = {
  serperKey:  'serper_api_key',
  searxngUrl: 'searxng_url',
  jinaKey:    'jina_api_key',
  braveKey:   'brave_api_key',
  tavilyKey:  'tavily_api_key',
}

function readWebSearchBlock() {
  try {
    const raw = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8'))
    return {
      serperKey:  typeof raw.serper_api_key === 'string' ? raw.serper_api_key : '',
      searxngUrl: typeof raw.searxng_url    === 'string' ? raw.searxng_url    : '',
      jinaKey:    typeof raw.jina_api_key   === 'string' ? raw.jina_api_key   : '',
      braveKey:   typeof raw.brave_api_key  === 'string' ? raw.brave_api_key  : '',
      tavilyKey:  typeof raw.tavily_api_key === 'string' ? raw.tavily_api_key : '',
    }
  } catch {
    return { serperKey: '', searxngUrl: '', jinaKey: '', braveKey: '', tavilyKey: '' }
  }
}

// 前端可见视图：不暴露 key 明文，只暴露 configured 布尔 + searxngUrl（URL 不算敏感）
// configured 同时考虑 env 兜底，避免"env 里有 key 但 UI 标未配置"的误导
// xxxFromEnv 提示来源，让 UI 标注"已配置（环境变量）"，并暗示清空输入框不会真正生效
export function getWebSearchConfig() {
  const stored = readWebSearchBlock()
  const envSerper  = process.env.SERPER_API_KEY || ''
  const envJina    = process.env.JINA_API_KEY   || ''
  const envSearxng = process.env.SEARXNG_URL    || ''
  const envBrave   = process.env.BRAVE_API_KEY  || ''
  const envTavily  = process.env.TAVILY_API_KEY || ''
  return {
    serperConfigured: !!(stored.serperKey  || envSerper),
    jinaConfigured:   !!(stored.jinaKey    || envJina),
    braveConfigured:  !!(stored.braveKey   || envBrave),
    tavilyConfigured: !!(stored.tavilyKey  || envTavily),
    // 输入框只回显 stored 值，避免用户以为能编辑 env 值
    searxngUrl:       stored.searxngUrl,
    // effective URL（含 env 兜底），UI 可显示在状态行
    effectiveSearxngUrl: stored.searxngUrl || envSearxng,
    serperFromEnv:    !stored.serperKey  && !!envSerper,
    jinaFromEnv:      !stored.jinaKey    && !!envJina,
    braveFromEnv:     !stored.braveKey   && !!envBrave,
    tavilyFromEnv:    !stored.tavilyKey  && !!envTavily,
    searxngFromEnv:   !stored.searxngUrl && !!envSearxng,
  }
}

// Backend-only：读明文 key。供 src/capabilities/executor.js 内部用，不要给前端
export function getWebSearchCredentials() {
  const stored = readWebSearchBlock()
  return {
    serperKey:  stored.serperKey  || process.env.SERPER_API_KEY || '',
    searxngUrl: stored.searxngUrl || process.env.SEARXNG_URL    || '',
    jinaKey:    stored.jinaKey    || process.env.JINA_API_KEY   || '',
    braveKey:   stored.braveKey   || process.env.BRAVE_API_KEY  || '',
    tavilyKey:  stored.tavilyKey  || process.env.TAVILY_API_KEY || '',
  }
}

export function setWebSearchConfig(updates) {
  const existing = readExistingStoredConfig()
  const next = { ...existing }
  for (const [key, val] of Object.entries(updates || {})) {
    const cfgField = WEB_SEARCH_KEY_MAP[key]
    if (!cfgField) continue
    const trimmed = String(val || '').trim()
    if (key === 'searxngUrl' && trimmed && !/^https?:\/\//i.test(trimmed)) {
      throw new Error('searxngUrl must start with http:// or https://')
    }
    if (trimmed) next[cfgField] = trimmed
    else delete next[cfgField]
  }
  writeStoredConfig(next)
}

export const __internals = {
  DEEPSEEK_MODELS,
  MINIMAX_MODELS,
  OPENAI_MODELS,
  QWEN_MODELS,
  MOONSHOT_MODELS,
  ZHIPU_MODELS,
  MIMO_MODELS,
  getProviderModelFallbacks,
  normalizeModel,
  isThinkingEnabledForModel,
  shouldOmitSamplingForProviderModel,
  shouldSendThinkingDisabledForProviderModel,
  shouldUseMaxCompletionTokensForProviderModel,
  buildPingParams,
}
