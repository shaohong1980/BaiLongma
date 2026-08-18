// model-router.js —— 快/强模型路由（对齐主流 harness 的 flash/pro 分层）
//
// 原则：主循环（涉及 cache 的连续对话）保持单一模型以命中 prefix cache；
// 分层只用于「独立子调用」——子代理/子任务/低风险工具链的中间轮用快模型省钱，
// 因为独立请求不打断主对话的 cache 前缀。
import { config } from '../config.js'

// 各 provider 的快模型（若与当前主模型相同则返回 null，避免无意义切换）
const FAST_MODEL_BY_PROVIDER = {
  deepseek: 'deepseek-v4-flash',
}

export function getFastModel() {
  const fast = FAST_MODEL_BY_PROVIDER[config.provider]
  if (!fast || fast === config.model) return null
  return fast
}

// 当前是否有可用的快模型分层
export function hasFastModel() {
  return !!getFastModel()
}
