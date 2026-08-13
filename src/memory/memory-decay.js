/**
 * 记忆衰减模块 — memory-decay.js
 * 
 * 核心公式：Score = 重要性 × 新鲜度
 * - 重要性：salience (1-5) 归一化到 0.2-1.0
 * - 新鲜度：指数衰减 fresh = e^(-λ × Δt)，λ 默认 0.05（约 14 天新鲜度降到一半）
 * 
 * 用法：
 *   import { applyDecayScore, sortByDecay, getDecayConfig, setDecayConfig } from './memory-decay.js'
 *   const scored = applyDecayScore(memories)
 *   const sorted = sortByDecay(memories)
 */

// ============================================================
// 配置
// ============================================================

const DEFAULT_CONFIG = {
  /** 衰减速率 λ。越大忘得越快。0.05 ≈ 14 天新鲜度降到 50% */
  lambda: 0.05,
  /** Score 低于此阈值的记忆不注入上下文 */
  scoreThreshold: 0.15,
  /** 是否启用衰减排序（关闭时回退到纯 salience 排序） */
  enabled: true,
  /** 新鲜度计算的时间单位：'day' | 'hour' */
  timeUnit: 'day',
  /** salience 归一化范围 */
  salienceMin: 0.2,
  salienceMax: 1.0,
}

let config = { ...DEFAULT_CONFIG }

export function getDecayConfig() {
  return { ...config }
}

export function setDecayConfig(partial) {
  config = { ...config, ...partial }
}

// ============================================================
// 核心计算
// ============================================================

/**
 * 计算新鲜度因子
 * @param {Date|string|number} timestamp - 记忆的时间戳
 * @param {Date} [now] - 当前时间，默认 now
 * @returns {number} 0-1 之间的新鲜度值
 */
export function calcFreshness(timestamp, now = new Date()) {
  const ts = timestamp instanceof Date ? timestamp : new Date(timestamp)
  if (isNaN(ts.getTime())) return 0.5 // 无效时间戳给中性值

  const deltaMs = now.getTime() - ts.getTime()
  if (deltaMs < 0) return 1.0 // 未来时间视为最新

  let deltaT
  if (config.timeUnit === 'hour') {
    deltaT = deltaMs / (1000 * 60 * 60)
  } else {
    deltaT = deltaMs / (1000 * 60 * 60 * 24)
  }

  return Math.exp(-config.lambda * deltaT)
}

/**
 * 将 salience (1-5) 归一化到 [salienceMin, salienceMax]
 */
export function normalizeSalience(salience) {
  const s = Math.max(1, Math.min(5, salience ?? 3))
  const normalized = (s - 1) / 4 // 0-1
  return config.salienceMin + normalized * (config.salienceMax - config.salienceMin)
}

/**
 * 计算单条记忆的衰减分数
 * @param {Object} memory - 记忆对象，需含 salience 和 timestamp
 * @param {Date} [now]
 * @returns {number} decayedScore
 */
export function calcDecayScore(memory, now) {
  const importance = normalizeSalience(memory.salience)
  const freshness = calcFreshness(memory.timestamp, now)
  return importance * freshness
}

/**
 * 批量为记忆数组附加 decayedScore 字段
 * @param {Array} memories
 * @param {Date} [now]
 * @returns {Array} 原数组（原地修改），每条记忆多了 decayedScore
 */
export function applyDecayScore(memories, now) {
  if (!config.enabled) {
    for (const m of memories) {
      m.decayedScore = normalizeSalience(m.salience)
    }
    return memories
  }

  const currentTime = now || new Date()
  for (const m of memories) {
    m.decayedScore = calcDecayScore(m, currentTime)
  }
  return memories
}

/**
 * 按衰减分数降序排列，低于阈值的标记为 filtered
 * @param {Array} memories
 * @param {Object} [opts]
 * @param {number} [opts.threshold] - 覆盖全局阈值
 * @param {boolean} [opts.includeFiltered] - 是否保留低于阈值的（仅标记不剔除）
 * @returns {Array} 排序后的数组
 */
export function sortByDecay(memories, opts = {}) {
  const threshold = opts.threshold ?? config.scoreThreshold
  const includeFiltered = opts.includeFiltered ?? false

  // 先计算分数
  applyDecayScore(memories)

  // 排序
  const sorted = [...memories].sort((a, b) => (b.decayedScore ?? 0) - (a.decayedScore ?? 0))

  // 标记低于阈值的
  for (const m of sorted) {
    m.filteredByDecay = (m.decayedScore ?? 0) < threshold
  }

  if (!includeFiltered) {
    return sorted.filter(m => !m.filteredByDecay)
  }

  return sorted
}

/**
 * 获取衰减统计信息（用于调试/面板展示）
 */
export function getDecayStats(memories, now) {
  applyDecayScore(memories, now)
  const scores = memories.map(m => m.decayedScore ?? 0).sort((a, b) => b - a)
  if (scores.length === 0) return { count: 0 }

  const sum = scores.reduce((a, b) => a + b, 0)
  const filtered = scores.filter(s => s < config.scoreThreshold).length

  return {
    count: scores.length,
    max: scores[0],
    min: scores[scores.length - 1],
    avg: sum / scores.length,
    median: scores[Math.floor(scores.length / 2)],
    filtered,
    threshold: config.scoreThreshold,
    lambda: config.lambda,
  }
}

// ============================================================
// 便捷导出
// ============================================================

export default {
  calcFreshness,
  normalizeSalience,
  calcDecayScore,
  applyDecayScore,
  sortByDecay,
  getDecayStats,
  getDecayConfig,
  setDecayConfig,
}
