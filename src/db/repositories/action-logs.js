// action-logs.js —— action_logs 表 repository（从 db.js 拆出，保持 db.js re-export 兼容）
import { getDB } from '../connection.js'

function safeStringify(value) {
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return '{}'
  }
}

// 每次工具调用写一行行动日志
export function insertActionLog({
  timestamp,
  tool,
  summary,
  detail = '',
  status = 'ok',
  risk = 'medium',
  args = null,
  argsJson = null,
  resultPreview = '',
  error = '',
  durationMs = 0,
  source = '',
}) {
  const db = getDB()
  const serializedArgs = argsJson ?? safeStringify(args ?? {})
  const result = db.prepare(`
    INSERT INTO action_logs (
      timestamp, tool, summary, detail,
      status, risk, args_json, result_preview, error, duration_ms, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    timestamp,
    tool,
    summary,
    String(detail).slice(0, 300),
    status,
    risk,
    String(serializedArgs || '{}').slice(0, 2000),
    String(resultPreview || '').slice(0, 500),
    String(error || '').slice(0, 500),
    Number(durationMs) || 0,
    String(source || '').slice(0, 120)
  )
  return Number(result.lastInsertRowid)
}

// 工具回执（ZeroClaw 移植）：按 action_log id 取回执 / 写回执
export function getActionLog(id) {
  const db = getDB()
  return db.prepare(`SELECT * FROM action_logs WHERE id = ?`).get(Number(id) || 0) || null
}
export function updateActionLogReceipt(id, receiptJson) {
  const db = getDB()
  db.prepare(`UPDATE action_logs SET receipt = ? WHERE id = ?`).run(String(receiptJson || ''), Number(id) || 0)
  return Number(id) || 0
}

// 获取最近 N 条行动日志（时间正序）
// 默认排除后台 housekeeping 人格（recognizer / consolidator）：它们不算主 Agent 的"自我历史"。
// 一旦混进 self-snapshot 的"工具习惯（近 10 次调用）"、tool-router 的 ActionLog 保活，
// 主 Agent 会(1)误以为自己最近在做识别/整理，把无关问题误读成"用户在问识别器"，
// (2)被把 skip_recognition / skip_consolidation 这类后台专属工具重新注入工具表，
//    于是在普通对话回完话后顺手补一个 skip_consolidation 当收尾（多余的"跳过整理"步骤）。
// 极少数审计/诊断场景需要看全部时，传 { includeHousekeeping: true }。
export function getRecentActionLogs(limit = 50, { includeHousekeeping = false, includeRecognizer = false } = {}) {
  const db = getDB()
  if (includeHousekeeping || includeRecognizer) {
    return db.prepare(`
      SELECT * FROM action_logs ORDER BY id DESC LIMIT ?
    `).all(limit).reverse()
  }
  return db.prepare(`
    SELECT * FROM action_logs
    WHERE source IS NULL OR source NOT IN ('recognizer', 'consolidator', 'reviewer')
    ORDER BY id DESC LIMIT ?
  `).all(limit).reverse()
}
