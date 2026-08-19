// workspace API：豆包新增能力的 HTTP 管理端点
//   - 知识库（knowledge）: 列表 / 详情 / 统计 / 删除 / 检索
//   - 审批（approvals）: 列表 / 通过 / 拒绝（HITL）
//   - 工作流（workflows）: 列表 / 运行
//   - 可观测性（observability）: 仪表盘 / 成本明细
import { listDocs, getDoc, deleteDoc, getStats, search } from '../../knowledge/index.js'
import { listApprovals, resolveApproval, getPendingCount } from '../../hitl/approval.js'
import { listWorkflows, getWorkflow, saveWorkflow, WORKFLOW_TEMPLATES } from '../../workflow/index.js'
import { validateWorkflow } from '../../workflow/schema.js'
import { execWorkflowRun } from '../../capabilities/tools/workflow.js'
import { getDashboardData, getCostBreakdown } from '../../observability/index.js'
import { jsonResponse, readJsonBody } from '../utils.js'

function parsePathId(pathname, prefix) {
  const m = String(pathname).match(new RegExp(`^${prefix}/([^/]+)`))
  return m ? decodeURIComponent(m[1]) : null
}

export async function handleWorkspaceRoutes(req, res, url) {
  const p = url.pathname

  // ── 知识库：统计 ──
  if (req.method === 'GET' && p === '/knowledge/stats') {
    try { jsonResponse(res, 200, getStats()) } catch (err) { jsonResponse(res, 500, { ok: false, error: err.message }) }
    return true
  }

  // ── 知识库：文档列表 ──
  if (req.method === 'GET' && p === '/knowledge/docs') {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200)
    const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0)
    try { jsonResponse(res, 200, listDocs({ limit, offset })) } catch (err) { jsonResponse(res, 500, { ok: false, error: err.message }) }
    return true
  }

  // ── 知识库：文档详情 ──
  if (req.method === 'GET' && p.startsWith('/knowledge/docs/')) {
    const docId = parsePathId(p, '/knowledge/docs')
    if (!docId) { jsonResponse(res, 400, { ok: false, error: '缺少 doc_id' }); return true }
    try {
      const doc = getDoc(docId)
      if (!doc) { jsonResponse(res, 404, { ok: false, error: `文档不存在: ${docId}` }); return true }
      jsonResponse(res, 200, { ok: true, doc })
    } catch (err) { jsonResponse(res, 500, { ok: false, error: err.message }) }
    return true
  }

  // ── 知识库：删除文档 ──
  if (req.method === 'DELETE' && p.startsWith('/knowledge/docs/')) {
    const docId = parsePathId(p, '/knowledge/docs')
    if (!docId) { jsonResponse(res, 400, { ok: false, error: '缺少 doc_id' }); return true }
    try {
      const r = deleteDoc(docId)
      jsonResponse(res, r.ok ? 200 : 400, r)
    } catch (err) { jsonResponse(res, 500, { ok: false, error: err.message }) }
    return true
  }

  // ── 知识库：检索 ──
  if (req.method === 'POST' && p === '/knowledge/search') {
    try {
      const body = await readJsonBody(req)
      const q = String(body.query || '').trim()
      if (!q) { jsonResponse(res, 400, { ok: false, error: '缺少 query' }); return true }
      const r = await search(q, { limit: Number(body.limit) || 8, docId: body.doc_id || null })
      jsonResponse(res, 200, r)
    } catch (err) { jsonResponse(res, 500, { ok: false, error: err.message }) }
    return true
  }

  // ── 审批：列表 ──
  if (req.method === 'GET' && p === '/approvals') {
    const status = url.searchParams.get('status') || null
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200)
    try {
      const r = listApprovals({ status, limit })
      r.pending_count = getPendingCount()
      jsonResponse(res, 200, r)
    } catch (err) { jsonResponse(res, 500, { ok: false, error: err.message }) }
    return true
  }

  // ── 审批：通过 / 拒绝 ──
  if ((req.method === 'POST' || req.method === 'PATCH') && p.startsWith('/approvals/')) {
    const m = String(p).match(/^\/approvals\/([^/]+)\/(approve|reject)$/)
    if (!m) { jsonResponse(res, 404, { ok: false, error: 'unknown approval action' }); return true }
    try {
      const body = await readJsonBody(req).catch(() => ({}))
      const r = resolveApproval(m[1], { action: m[2] === 'approve' ? 'approve' : 'reject', reason: body.reason, resolvedBy: 'user' })
      jsonResponse(res, r.ok ? 200 : 400, r)
    } catch (err) { jsonResponse(res, 500, { ok: false, error: err.message }) }
    return true
  }

  // ── 工作流：列表（含内置模板） ──
  if (req.method === 'GET' && p === '/workflows') {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200)
    try {
      const saved = listWorkflows({ limit })
      const templates = Object.entries(WORKFLOW_TEMPLATES).map(([id, t]) => ({ id, name: t.name, description: t.description, type: 'template', nodes: t.nodes?.length || 0 }))
      jsonResponse(res, 200, { ok: true, templates, saved: saved.workflows, total_saved: saved.total })
    } catch (err) { jsonResponse(res, 500, { ok: false, error: err.message }) }
    return true
  }

  // ── 工作流：模板定义详情（可视化编辑器加载完整模板） ──
  if (req.method === 'GET' && p.startsWith('/workflows/templates/')) {
    const tplId = parsePathId(p, '/workflows/templates')
    if (!tplId) { jsonResponse(res, 400, { ok: false, error: '缺少模板 id' }); return true }
    const tpl = WORKFLOW_TEMPLATES[tplId]
    if (!tpl) { jsonResponse(res, 404, { ok: false, error: `模板不存在: ${tplId}` }); return true }
    const definition = JSON.parse(JSON.stringify(tpl))
    const validation = validateWorkflow(definition)
    // 模板定义补 id（部分模板 id 与 key 相同，但确保兼容）
    if (!definition.id) definition.id = tplId
    jsonResponse(res, 200, { ok: true, template: definition, valid: validation.valid, errors: validation.errors })
    return true
  }

  // ── 工作流：运行（template / workflow_id / 内联定义） ──
  if (req.method === 'POST' && p === '/workflows/run') {
    try {
      const body = await readJsonBody(req)
      const r = await execWorkflowRun({
        template: body.template,
        workflow_id: body.workflow_id,
        workflow: body.workflow,
        input: body.input,
      })
      jsonResponse(res, 200, JSON.parse(r))
    } catch (err) { jsonResponse(res, 500, { ok: false, error: err.message }) }
    return true
  }

  // ── 工作流：保存（可视化编辑器） ──
  if (req.method === 'POST' && p === '/workflows/save') {
    try {
      const body = await readJsonBody(req)
      const name = String(body.name || '').trim()
      const workflow = body.workflow
      if (!name || !workflow || typeof workflow !== 'object') {
        jsonResponse(res, 400, { ok: false, error: '缺少 name 或 workflow' })
        return true
      }
      const toSave = { ...workflow, name }
      if (!toSave.id || toSave.id === 'draft') toSave.id = `wf_${Date.now().toString(36)}`
      const r = saveWorkflow(toSave)
      jsonResponse(res, r.ok ? 200 : 400, { ...r, id: toSave.id })
    } catch (err) { jsonResponse(res, 500, { ok: false, error: err.message }) }
    return true
  }

  // ── 工作流：读取定义详情（可视化编辑器加载已保存工作流） ──
  if (req.method === 'GET' && p.startsWith('/workflows/')) {
    const wfId = parsePathId(p, '/workflows')
    if (!wfId || wfId === 'run' || wfId === 'save') return false
    try {
      const wf = getWorkflow(wfId)
      if (!wf) { jsonResponse(res, 404, { ok: false, error: `工作流不存在: ${wfId}` }); return true }
      jsonResponse(res, 200, { ok: true, workflow: wf })
    } catch (err) { jsonResponse(res, 500, { ok: false, error: err.message }) }
    return true
  }

  // ── 可观测性：综合仪表盘 ──
  if (req.method === 'GET' && p === '/observability/dashboard') {
    const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 7, 1), 365)
    try { jsonResponse(res, 200, { ok: true, ...getDashboardData({ days }) }) } catch (err) { jsonResponse(res, 500, { ok: false, error: err.message }) }
    return true
  }

  // ── 可观测性：成本明细 ──
  if (req.method === 'GET' && p === '/observability/cost') {
    const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 7, 1), 365)
    try { jsonResponse(res, 200, { ok: true, ...getCostBreakdown({ days }) }) } catch (err) { jsonResponse(res, 500, { ok: false, error: err.message }) }
    return true
  }

  return false
}
