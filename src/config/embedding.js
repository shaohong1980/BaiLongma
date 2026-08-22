// embedding.js —— 本地嵌入（Embedding）配置（从 src/config.js 拆出）
// 记忆向量召回只用本地离线模型（transformers.js + onnxruntime-node 跑 ONNX），不依赖任何云端 API。
// 零配置开箱即用：config.json 的 "embedding" 块可不存在；存在时仅 model / timeoutMs 有意义。
//   model:     本地 ONNX 模型 HF 仓库 id（缺省走 LOCAL_DEFAULT_MODEL）
//   timeoutMs: 可选，覆盖向量召回硬超时（默认 1500ms）
// 首次运行会下载 ~330MB 中文嵌入模型到 userData/data/models，之后离线可用。
import fs from 'fs'
import { paths } from '../paths.js'
import { readExistingStoredConfig, writeStoredConfig } from './io.js'

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
