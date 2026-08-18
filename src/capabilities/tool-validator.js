// tool-validator.js —— 工具参数运行时校验
//
// 对齐主流 Agent 的 schema 校验：在工具执行前检查必需参数缺失 / 明显类型错误，
// 返回结构化错误（模型据此修正，而非带错参数执行）。校验失败算一次工具失败，
// 由 llm.js 的熔断计数防死循环（同参数反复错会触发熔断）。
import { getToolSchemas } from './schemas.js'

const schemaCache = new Map()
function getParamsSchema(name) {
  if (!schemaCache.has(name)) {
    const s = getToolSchemas([name])[0]
    schemaCache.set(name, s?.function?.parameters || null)
  }
  return schemaCache.get(name)
}

export function validateToolArgs(name, args = {}) {
  const params = getParamsSchema(name)
  if (!params) return { ok: true }
  const required = Array.isArray(params.required) ? params.required : []
  const properties = params.properties || {}
  const errors = []

  // 必需参数缺失 / 空值
  for (const req of required) {
    const v = args[req]
    if (v === undefined || v === null || v === '') {
      errors.push(`缺少必需参数 ${req}`)
    }
  }

  // 类型检查（宽松：只拦明显错误；string 不校验，数字/布尔/数组做校验）
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null || value === '') continue
    const t = properties[key]?.type
    if (!t || t === 'string') continue
    if (t === 'number') {
      if (typeof value !== 'number' && !/^-?\d+(\.\d+)?$/.test(String(value).trim())) {
        errors.push(`${key} 应为数字，收到 ${String(value).slice(0, 20)}`)
      }
    } else if (t === 'boolean') {
      if (typeof value !== 'boolean' && !/^(true|false)$/i.test(String(value).trim())) {
        errors.push(`${key} 应为布尔值，收到 ${String(value).slice(0, 20)}`)
      }
    } else if (t === 'array' && !Array.isArray(value)) {
      errors.push(`${key} 应为数组`)
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true }
}
