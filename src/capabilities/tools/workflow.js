// tools/workflow.js —— 工作流工具执行器（P1）
import { createWorkflowEngine, WORKFLOW_TEMPLATES, getWorkflow, saveWorkflow, listWorkflows, deleteWorkflow, saveExecution } from '../../workflow/index.js'
import { proposeWorkflow } from '../../workflow/proposer.js'
import { emitEvent } from '../../events.js'

function toolJson(payload) {
  return JSON.stringify(payload, null, 2)
}

// 构建工作流引擎（注入工具执行器和 LLM 执行器）
function buildEngine(context = {}) {
  // 动态导入避免循环依赖
  return createWorkflowEngine({
    executeTool: async ({ tool, args }) => {
      try {
        const { executeToolUnchecked } = await import('../executor.js')
        return await executeToolUnchecked(tool, args || {}, context)
      } catch (err) {
        return { ok: false, error: err.message }
      }
    },
    executeLLM: async ({ prompt, systemPrompt }) => {
      try {
        const { runSimpleCompletion } = await import('../../llm.js')
        const content = await runSimpleCompletion({
          messages: [
            { role: 'system', content: systemPrompt || '你是一个有帮助的助手。' },
            { role: 'user', content: prompt },
          ],
          temperature: 0.3,
          maxTokens: 2000,
        })
        return { content }
      } catch (err) {
        return { content: `[LLM 调用失败: ${err.message}]` }
      }
    },
    signal: context.signal,
  })
}

// workflow_run：运行工作流
export async function execWorkflowRun(args = {}, context = {}) {
  const input = args.input && typeof args.input === 'object' ? args.input : { input: args.input ? String(args.input) : '' }

  // 获取工作流定义
  let workflow = null
  if (args.template && WORKFLOW_TEMPLATES[args.template]) {
    workflow = JSON.parse(JSON.stringify(WORKFLOW_TEMPLATES[args.template]))
    workflow.id = `template_${args.template}_${Date.now()}`
  } else if (args.workflow_id) {
    const saved = getWorkflow(args.workflow_id)
    if (!saved) return toolJson({ ok: false, tool: 'workflow_run', error: `工作流不存在: ${args.workflow_id}` })
    workflow = saved.definition
  } else if (args.workflow && typeof args.workflow === 'object') {
    workflow = args.workflow
  } else {
    return toolJson({ ok: false, tool: 'workflow_run', error: '必须指定 template、workflow_id 或 workflow 之一' })
  }

  try {
    const engine = buildEngine(context)
    const result = await engine.run(workflow, input)

    // 保存执行记录
    try {
      saveExecution({
        ...result,
        workflow_id: workflow.id,
        input,
        started_at: new Date().toISOString(),
      })
    } catch { /* 保存失败不影响返回 */ }

    // 格式化输出
    const formatted = {
      ok: result.ok,
      tool: 'workflow_run',
      execution_id: result.execution_id,
      status: result.status,
      steps: result.log?.length || 0,
      log: (result.log || []).map(l => ({
        node_id: l.node_id,
        node_type: l.node_type,
        name: l.name,
        status: l.status,
        duration_ms: l.duration_ms,
        output_preview: typeof l.output === 'string' ? l.output.slice(0, 300) : JSON.stringify(l.output || {}).slice(0, 300),
      })),
    }

    if (result.status === 'paused') {
      formatted.paused_at = result.paused_at
      formatted.message = result.message
    } else if (result.ok) {
      // 提取最终输出（最后一个非 end 节点的 output）
      const lastOutput = [...(result.log || [])].reverse().find(l => l.node_type !== 'end' && l.output)
      formatted.result = lastOutput?.output
    } else {
      formatted.error = result.error
    }

    return toolJson(formatted)
  } catch (err) {
    return toolJson({ ok: false, tool: 'workflow_run', error: `工作流执行失败: ${err.message}` })
  }
}

// workflow_list：列出工作流
export function execWorkflowList(args = {}) {
  const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 200)
  const includeTemplates = args.include_templates !== false

  try {
    const saved = listWorkflows({ limit })
    const templates = includeTemplates ? Object.entries(WORKFLOW_TEMPLATES).map(([id, t]) => ({
      id,
      name: t.name,
      description: t.description,
      type: 'template',
      nodes: t.nodes?.length || 0,
    })) : []

    return toolJson({
      ok: true,
      tool: 'workflow_list',
      total_saved: saved.total,
      templates,
      saved: saved.workflows,
    })
  } catch (err) {
    return toolJson({ ok: false, tool: 'workflow_list', error: err.message })
  }
}

// workflow_save：保存工作流
export function execWorkflowSave(args = {}) {
  const name = String(args.name || '').trim()
  const workflow = args.workflow
  if (!name) return toolJson({ ok: false, tool: 'workflow_save', error: '缺少 name' })
  if (!workflow || typeof workflow !== 'object') return toolJson({ ok: false, tool: 'workflow_save', error: '缺少 workflow 定义' })

  try {
    const toSave = { ...workflow, name, description: args.description || workflow.description || '' }
    if (!toSave.id) toSave.id = `wf_${Date.now().toString(36)}`
    const result = saveWorkflow(toSave)
    return toolJson({ ...result, tool: 'workflow_save' })
  } catch (err) {
    return toolJson({ ok: false, tool: 'workflow_save', error: err.message })
  }
}

// workflow_delete：删除工作流
export function execWorkflowDelete(args = {}) {
  const workflowId = String(args.workflow_id || '').trim()
  if (!workflowId) return toolJson({ ok: false, tool: 'workflow_delete', error: '缺少 workflow_id' })
  try {
    const result = deleteWorkflow(workflowId)
    return toolJson({ ...result, tool: 'workflow_delete' })
  } catch (err) {
    return toolJson({ ok: false, tool: 'workflow_delete', error: err.message })
  }
}

// propose_workflow：Agent 从自然语言自主设计工作流 → 校验 → 提案待用户审阅（openhuman 移植）
export async function execProposeWorkflow(args = {}, context = {}) {
  const name = String(args.name || '').trim()
  const task = String(args.task || '').trim()
  const description = String(args.description || '').trim()
  if (!name) return toolJson({ ok: false, tool: 'propose_workflow', error: '缺少 name（工作流名称）' })
  if (!task) return toolJson({ ok: false, tool: 'propose_workflow', error: '缺少 task（用一句话描述要自动化的事情）' })

  try {
    const r = await proposeWorkflow({ name, task, description })
    if (!r.ok) return toolJson({ ok: false, tool: 'propose_workflow', error: r.error })
    // 通知前端：有待审的工作流提案（工作流编辑器显示「接受提案」卡片）
    try { emitEvent('workflow_proposal', { proposal: r.proposal }) } catch {}
    return toolJson({
      ok: true,
      tool: 'propose_workflow',
      proposal: r.proposal,
      steps: r.proposal.summary.steps,
      hint: '已生成工作流提案，等待用户在工作流编辑器审阅。用户接受后才会保存/运行。',
    })
  } catch (err) {
    return toolJson({ ok: false, tool: 'propose_workflow', error: `工作流设计失败: ${err.message}` })
  }
}
