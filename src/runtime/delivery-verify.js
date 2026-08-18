// delivery-verify.js —— 交付验证统一策略
//
// 收拢散落的"产出→必须验证"判定（write_file 读回 / unverifiedDeliveryNotice /
// 服务探测 / action-contract）到一处，供 executor / review / evals 复用。
// 原则：产出类动作（写/建/起服务）之后必须有验证动作（读回/运行/检查），
// 否则收尾时给出软引导，提示"别做完就宣称成功"。

// 产出类工具：出现这类动作后，后续必须有验证
const ARTIFACT_TOOLS = new Set(['write_file', 'make_dir'])
// 明确的验证工具
const VERIFY_TOOLS = new Set(['fetch_url', 'browser_read', 'review_work', 'read_file'])
// 命令摘要里的验证信号
const VERIFY_CMD_RE = /curl|invoke-webrequest|invoke-restmethod|--check|--test|测试|验证/i
// 命令摘要里的"起服务"信号（视为产出）
const SERVE_CMD_RE = /node |npm start|server|serve|python .*http/i

// 检查 action_logs（新→旧）里，最近一次产出之后是否有验证动作。
// 返回 { verified, reason }。
export function hasVerificationEvidence(logs = []) {
  if (!Array.isArray(logs) || logs.length === 0) return { verified: true, reason: 'no logs' }

  let lastArtifactIdx = -1
  for (let i = logs.length - 1; i >= 0; i--) {
    const t = logs[i]?.tool || ''
    const summary = String(logs[i]?.summary || '')
    if (ARTIFACT_TOOLS.has(t)) { lastArtifactIdx = i; break }
    if (t === 'exec_command' && SERVE_CMD_RE.test(summary)) { lastArtifactIdx = i; break }
  }
  if (lastArtifactIdx < 0) return { verified: true, reason: 'no artifact produced' }

  for (let i = lastArtifactIdx + 1; i < logs.length; i++) {
    const t = logs[i]?.tool || ''
    const summary = String(logs[i]?.summary || '')
    if (VERIFY_TOOLS.has(t)) return { verified: true, reason: `verification tool ${t}` }
    if (t === 'exec_command' && VERIFY_CMD_RE.test(summary)) return { verified: true, reason: 'verification command' }
  }
  return { verified: false, reason: 'no verification after artifact' }
}

// 未验证时的软引导（不拦截，附在 complete_task 返回值）
export function buildDeliveryVerifyNotice(verified) {
  if (verified) return ''
  return '注意：本任务产出了文件/起了服务，但收尾前没有任何验证动作（fetch_url / browser_read / review_work / 读回产物）。任务已照常收尾——如果你还没亲自确认成果真的能跑，现在就去验证；发现问题立刻修复并如实告知用户，别等用户先发现。'
}

// 一站式：给定 action_logs，返回收尾时的验证引导（空串 = 已验证/无需）
export function deliveryVerifyNoticeFromLogs(logs) {
  try {
    const { verified } = hasVerificationEvidence(logs)
    return buildDeliveryVerifyNotice(verified)
  } catch {
    return ''
  }
}
