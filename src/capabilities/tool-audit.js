import { insertActionLog, updateActionLogReceipt } from '../db.js'
import { emitEvent } from '../events.js'
import { classifyTool } from './tool-policy.js'
import { previewValue, safeJsonStringify } from './tool-utils.js'
import { toolReceiptsEnabled, buildReceiptForLogRow } from './tool-receipts.js'

function getExecutionSource(context = {}) {
  return context.source || context.trigger || (context.autonomous ? 'autonomous' : 'llm')
}
function summarizeToolExecution(name, args = {}) {
  switch (name) {
    case 'read_file':
      return `read_file(${args.path || args.filename || args.file_path || '?'})`
    case 'list_dir':
      return `list_dir(${args.path || args.dir || args.directory || '.'})`
    case 'write_file':
      return `write_file(${args.path || args.filename || args.file_path || '?'})`
    case 'delete_file':
      return `delete_file(${args.path || args.filename || args.file_path || '?'})`
    case 'make_dir':
      return `make_dir(${args.path || args.dir || args.directory || '?'})`
    case 'exec_command':
      return `exec_command(${String(args.command || args.cmd || '?').slice(0, 100)})`
    case 'install_software':
      return `install_software(${String(args.query || args.package_id || args.job_id || '?').slice(0, 100)})`
    case 'fetch_url':
    case 'browser_read':
      return `${name}(${String(args.url || args.link || args.href || '?').slice(0, 120)})`
    case 'web_search':
      return `web_search(${String(args.query || args.q || args.keyword || '?').slice(0, 120)})`
    case 'send_message':
    case 'express':
      return `${name} -> ${args.target_id || '(unknown)'}`
    case 'upsert_memory': {
      const count = Array.isArray(args.memories) ? args.memories.length : 0
      return `upsert_memory(${count})`
    }
    default:
      return name
  }
}

const SENSITIVE_ARG_KEY_RE = /(?:api[_-]?key|apikey|access[_-]?key|secret|token|password|authorization|bearer)/i
const SECRET_VALUE_RE = /\b(?:sk|ak|rk|pk)-[A-Za-z0-9_\-.]{12,180}\b/g

function redactAuditValue(value) {
  if (typeof value === 'string') return value.replace(SECRET_VALUE_RE, '[redacted]')
  if (Array.isArray(value)) return value.map(redactAuditValue)
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    out[key] = SENSITIVE_ARG_KEY_RE.test(key) ? '[redacted]' : redactAuditValue(item)
  }
  return out
}

export function inferToolStatus(result) {
  const text = String(result ?? '').trim()
  if (!text) return 'ok'
  try {
    const parsed = JSON.parse(text)
    return parsed?.ok === false ? 'error' : 'ok'
  } catch { /* 工具结果多数非 JSON，探测失败是预期高频，无需告警 */ }
  return /^(错误|请求失败|执行失败|命令超时|命令执行失败|閿欒|璇锋眰澶辫触|鎵ц澶辫触|鍛戒护瓒呮椂|鍛戒护鎵ц澶辫触)/.test(text) ? 'error' : 'ok'
}

export function writeToolAuditLog({ name, args, context, policy, status, result = '', error = '', startedAt }) {
  const durationMs = Date.now() - startedAt
  const detailParts = []
  if (policy?.reason) detailParts.push(`policy=${policy.reason}`)
  const auditArgs = redactAuditValue(args)
  const argPreview = previewValue(auditArgs, 160)
  if (argPreview && argPreview !== '{}') detailParts.push(`args=${argPreview}`)
  const resultPreview = previewValue(result || error, 220)
  if (resultPreview) detailParts.push(`result=${resultPreview}`)

  try {
    const logId = insertActionLog({
      timestamp: new Date(startedAt).toISOString(),
      tool: name,
      summary: summarizeToolExecution(name, auditArgs),
      detail: detailParts.join(' | '),
      status,
      risk: policy?.risk || classifyTool(name),
      argsJson: safeJsonStringify(auditArgs),
      resultPreview,
      error,
      durationMs,
      source: getExecutionSource(context),
    })
    // ZeroClaw 工具回执移植：action_log 落盘后生成可验证签名回执写回 receipt 列。
    // 回执绑定 (id|tool|time|status|risk|source|args_hash|result_hash|summary)，本地密钥 HMAC。
    if (toolReceiptsEnabled()) {
      try {
        const receipt = buildReceiptForLogRow({
          id: logId,
          tool: name,
          timestamp: new Date(startedAt).toISOString(),
          status,
          risk: policy?.risk || classifyTool(name),
          source: getExecutionSource(context),
          summary: summarizeToolExecution(name, auditArgs),
          args_json: safeJsonStringify(auditArgs),
          result_preview: resultPreview,
          error,
        })
        if (receipt) updateActionLogReceipt(logId, JSON.stringify(receipt))
      } catch (receiptErr) {
        console.warn(`[audit] failed to attach tool receipt: ${receiptErr.message}`)
      }
    }
  } catch (err) {
    console.warn(`[audit] failed to persist tool audit log: ${err.message}`)
  }

  emitEvent('tool_audit', {
    tool: name,
    status,
    risk: policy?.risk || classifyTool(name),
    summary: summarizeToolExecution(name, auditArgs),
    duration_ms: durationMs,
    source: getExecutionSource(context),
  })
}
