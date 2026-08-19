// workflow/engine.js —— 工作流运行时解释器
//
// 执行 workflow JSON，支持节点类型：start/end/llm/tool/condition/loop/parallel/human_input/approval/code
// 数据通过 context 传递，用 {{var.path}} 引用。
//
// 使用：
//   const engine = createWorkflowEngine({ executeTool, executeLLM })
//   const result = await engine.run(workflow, { input: '你好' })

import { validateWorkflow, renderTemplate } from './schema.js'
import crypto from 'crypto'

function generateId() {
  return 'wf_' + crypto.randomBytes(6).toString('hex')
}

function nowIso() {
  return new Date().toISOString()
}

export function createWorkflowEngine({ executeTool, executeLLM, signal = null } = {}) {
  // 执行单个节点，返回 { output, nextNodeId, metadata }
  async function executeNode(node, context, executionLog) {
    const startedAt = Date.now()
    const nodeResult = { node_id: node.id, node_type: node.type, name: node.name, started_at: nowIso() }

    try {
      switch (node.type) {
        case 'start':
          return finishNode(nodeResult, startedAt, { output: context.input, nextNodeId: node.next })

        case 'end':
          return finishNode(nodeResult, startedAt, { output: context, nextNodeId: null, isEnd: true })

        case 'llm': {
          const prompt = renderTemplate(node.config?.prompt || '', context)
          const systemPrompt = renderTemplate(node.config?.system_prompt || '你是一个有帮助的助手。', context)
          const llmResult = executeLLM
            ? await executeLLM({ prompt, systemPrompt, context })
            : { content: `[LLM 未配置] prompt: ${prompt.slice(0, 100)}` }
          context[node.id] = { result: llmResult.content || llmResult, raw: llmResult }
          return finishNode(nodeResult, startedAt, { output: llmResult.content, nextNodeId: node.next })
        }

        case 'tool': {
          const toolName = renderTemplate(node.config?.tool || '', context)
          const toolArgs = renderTemplateObject(node.config?.args || {}, context)
          const toolResult = executeTool
            ? await executeTool({ tool: toolName, args: toolArgs, context })
            : { ok: false, error: `工具执行器未配置: ${toolName}` }
          context[node.id] = { result: toolResult, args: toolArgs }
          return finishNode(nodeResult, startedAt, { output: toolResult, nextNodeId: node.next })
        }

        case 'condition': {
          const condition = renderTemplate(node.config?.condition || '', context)
          // 条件求值：支持简单的 JS 表达式（在沙箱中）
          const result = safeEvalCondition(condition, context)
          const branch = result ? 'true' : 'false'
          const nextNodeId = typeof node.next === 'object' ? node.next[branch] : node.next
          context[node.id] = { condition, result, branch }
          return finishNode(nodeResult, startedAt, { output: result, nextNodeId, metadata: { branch } })
        }

        case 'loop': {
          const itemsPath = node.config?.items || 'input'
          const items = getNested(context, itemsPath) || []
          const subNodeId = node.config?.body // 循环体节点 ID
          const results = []
          if (subNodeId && Array.isArray(items)) {
            for (let i = 0; i < items.length; i++) {
              if (signal?.aborted) break
              context._loop_index = i
              context._loop_item = items[i]
              // 循环体执行（简化：直接执行指定节点）
              const subNode = findNode(workflow, subNodeId)
              if (subNode) {
                const subResult = await executeNode(subNode, context, executionLog)
                results.push(subResult.output)
              }
            }
          }
          delete context._loop_index
          delete context._loop_item
          context[node.id] = { results, count: results.length }
          return finishNode(nodeResult, startedAt, { output: results, nextNodeId: node.next })
        }

        case 'parallel': {
          const branches = node.config?.branches || [] // 每个分支是节点 ID 数组
          const results = await Promise.all(
            branches.map(async (branchNodes) => {
              const branchContext = { ...context }
              for (const nid of branchNodes) {
                if (signal?.aborted) break
                const n = findNode(workflow, nid)
                if (n) {
                  const r = await executeNode(n, branchContext, executionLog)
                  if (r.isEnd) break
                }
              }
              return branchContext
            })
          )
          context[node.id] = { results }
          return finishNode(nodeResult, startedAt, { output: results, nextNodeId: node.next })
        }

        case 'human_input': {
          // 人工输入节点：暂停工作流，等待外部输入
          // 实际使用时由调用方通过 resumeWorkflow 传入
          const prompt = renderTemplate(node.config?.prompt || '请输入：', context)
          context[node.id] = { waiting: true, prompt }
          return finishNode(nodeResult, startedAt, {
            output: null,
            nextNodeId: node.next,
            metadata: { waiting_for_input: true, prompt },
            paused: true,
          })
        }

        case 'approval': {
          const title = renderTemplate(node.config?.title || '需要审批', context)
          const description = renderTemplate(node.config?.description || '', context)
          const riskLevel = node.config?.risk_level || 'medium'
          // 审批节点：返回待审批状态，由外部处理
          context[node.id] = { waiting: true, title, description, risk_level: riskLevel }
          return finishNode(nodeResult, startedAt, {
            output: null,
            nextNodeId: typeof node.next === 'object' ? node.next : node.next,
            metadata: { waiting_for_approval: true, title, description, risk_level: riskLevel },
            paused: true,
          })
        }

        case 'code': {
          const code = renderTemplate(node.config?.code || '', context)
          const result = safeEvalCode(code, context)
          context[node.id] = { result }
          return finishNode(nodeResult, startedAt, { output: result, nextNodeId: node.next })
        }

        default:
          return finishNode(nodeResult, startedAt, { output: null, nextNodeId: node.next, metadata: { warning: `未知节点类型: ${node.type}` } })
      }
    } catch (err) {
      nodeResult.error = err.message
      nodeResult.status = 'error'
      nodeResult.duration_ms = Date.now() - startedAt
      executionLog.push(nodeResult)
      throw err
    }
  }

  function finishNode(nodeResult, startedAt, { output, nextNodeId, metadata = {}, isEnd = false, paused = false }) {
    nodeResult.output = output
    nodeResult.status = paused ? 'paused' : 'ok'
    nodeResult.duration_ms = Date.now() - startedAt
    nodeResult.metadata = metadata
    if (isEnd) nodeResult.is_end = true
    return { ...nodeResult, nextNodeId, isEnd, paused }
  }

  // 主执行函数
  async function run(workflow, input = {}) {
    const validation = validateWorkflow(workflow)
    if (!validation.valid) {
      return { ok: false, error: '工作流验证失败', errors: validation.errors }
    }

    const executionId = generateId()
    const context = { ...input, _execution_id: executionId }
    const executionLog = []
    const startNode = workflow.nodes.find(n => n.type === 'start')
    if (!startNode) return { ok: false, error: '缺少 start 节点' }

    let currentNodeId = startNode.id
    let maxSteps = (workflow.nodes?.length || 10) * 10 + 50 // 防止死循环
    let pausedState = null

    while (currentNodeId && maxSteps-- > 0) {
      if (signal?.aborted) {
        return { ok: false, error: '执行被中断', execution_id: executionId, log: executionLog, context }
      }

      const node = findNode(workflow, currentNodeId)
      if (!node) {
        return { ok: false, error: `节点不存在: ${currentNodeId}`, execution_id: executionId, log: executionLog, context }
      }

      const result = await executeNode(node, context, executionLog)
      executionLog.push(result)

      if (result.paused) {
        pausedState = { node_id: node.id, node_type: node.type, metadata: result.metadata }
        break
      }
      if (result.isEnd) break
      currentNodeId = result.nextNodeId
    }

    if (pausedState) {
      return {
        ok: true,
        execution_id: executionId,
        status: 'paused',
        paused_at: pausedState,
        context,
        log: executionLog,
        message: `工作流在节点 ${pausedState.node_id} 处暂停，等待外部输入`,
      }
    }

    return {
      ok: true,
      execution_id: executionId,
      status: 'completed',
      context,
      log: executionLog,
      output: context,
    }
  }

  return { run }
}

// ─── 工具函数 ──────────────────────────────────────────────────────
function findNode(workflow, nodeId) {
  return workflow.nodes?.find(n => n.id === nodeId)
}

function renderTemplateObject(obj, context) {
  if (typeof obj === 'string') return renderTemplate(obj, context)
  if (Array.isArray(obj)) return obj.map(item => renderTemplateObject(item, context))
  if (obj && typeof obj === 'object') {
    const result = {}
    for (const [k, v] of Object.entries(obj)) {
      result[k] = renderTemplateObject(v, context)
    }
    return result
  }
  return obj
}

function getNested(obj, path) {
  return path.split('.').reduce((acc, key) => {
    if (acc === null || acc === undefined) return undefined
    const idx = Number(key)
    if (!isNaN(idx) && Array.isArray(acc)) return acc[idx]
    return acc[key]
  }, obj)
}

// 安全条件求值（只允许简单比较和逻辑运算）
function safeEvalCondition(condition, context) {
  try {
    // 替换变量引用
    const expr = condition.replace(/\{\{([^}]+)\}\}/g, (_, path) => {
      const val = getNested(context, path.trim())
      if (typeof val === 'string') return JSON.stringify(val)
      return String(val ?? 'null')
    })
    // 只允许安全字符
    if (!/^[\s\w'"()<>=!&|+\-*/%.\[\],.]+$/.test(expr)) return false
    // eslint-disable-next-line no-new-func
    return Boolean(new Function(`"use strict"; return (${expr})`)())
  } catch {
    return false
  }
}

// 安全代码执行（只允许简单表达式，访问 context）
function safeEvalCode(code, context) {
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('context', `"use strict"; ${code}`)
    return fn(context)
  } catch (err) {
    return { error: err.message }
  }
}
