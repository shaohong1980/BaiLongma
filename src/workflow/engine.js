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

export function createWorkflowEngine({ executeTool, executeLLM, executeRoom, allowCode = false, signal = null } = {}) {
  // 执行单个节点 + 应用「命名输出绑定」（Coze 数据流）：
  //   node.outputs = [{ name:'answer', source:'output' }] → context[node.id].answer = 本节点主输出
  //   下游节点可用 {{node_id.output_name}} 引用。
  //   scope = 当前节点所属的节点列表（顶层 workflow.nodes 或子流 block.nodes），供 merge 找上游。
  async function runNode(node, context, executionLog, scope) {
    const r = await executeNode(node, context, executionLog, scope || [])
    // 始终把主输出写入 context[node.id].output（无论是否声明 outputs），让 merge/transform/{{节点id.output}} 可靠引用。
    // end 节点例外：其 output 是整个 context，写入会形成循环引用。
    if (r.output !== undefined && !r.isEnd) {
      if (!context[node.id] || typeof context[node.id] !== 'object') context[node.id] = {}
      context[node.id].output = r.output
    }
    // 命名输出绑定：node.outputs = [{name, source}] → context[node.id].name
    if (Array.isArray(node.outputs) && node.outputs.length && r.output !== undefined) {
      if (!context[node.id] || typeof context[node.id] !== 'object') context[node.id] = {}
      for (const o of node.outputs) {
        const name = String(o?.name || '').trim()
        if (!name) continue
        const source = String(o?.source || 'output').trim()
        context[node.id][name] = source === 'output' ? r.output : getNested({ output: r.output, raw: r.output }, source)
      }
    }
    return r
  }

  // 执行一个子流（block.nodes 组成的迷你工作流），从 entry 节点沿 next 走到 end / 无后继。
  async function runSubflow(blockNodes, startNodeId, context, executionLog) {
    const miniWorkflow = { nodes: blockNodes || [] }
    let currentNodeId = startNodeId
    const results = []
    let steps = 0
    const MAX = (miniWorkflow.nodes.length || 1) * 10 + 50
    while (currentNodeId && steps++ < MAX) {
      if (signal?.aborted) break
      const n = findNode(miniWorkflow, currentNodeId)
      if (!n) break
      const r = await runNode(n, context, executionLog, miniWorkflow.nodes)
      executionLog.push(r)
      results.push(r)
      if (r.paused || r.isEnd) break
      currentNodeId = r.nextNodeId
    }
    return { results, lastResult: results[results.length - 1] }
  }

  // 解析 block 的入口节点：优先 block.start，其次 block 内 type=start，最后第一个节点
  function blockEntry(block) {
    if (!block || !Array.isArray(block.nodes) || !block.nodes.length) return null
    return block.start || block.nodes.find(n => n.type === 'start')?.id || block.nodes[0].id
  }

  // 执行单个节点，返回 { output, nextNodeId, metadata }；scope = 当前节点所属节点列表
  async function executeNode(node, context, executionLog, scope = []) {
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
          // 嵌套 blocks：真/假分支各是一个子流（Coze 模型）
          const block = (node.blocks || []).find(b => {
            const bid = String(b.id || '').toLowerCase()
            const bl = String(b.label || '').toLowerCase()
            return bid === branch || bl === branch
              || (branch === 'true' && (bid === 'yes' || bl === '是' || bl === '真'))
              || (branch === 'false' && (bid === 'no' || bl === '否' || bl === '假'))
          })
          if (block && Array.isArray(block.nodes) && block.nodes.length) {
            const entry = blockEntry(block)
            const { lastResult } = await runSubflow(block.nodes, entry, context, executionLog)
            const output = lastResult?.output ?? result
            context[node.id] = { condition, result, branch, output }
            return finishNode(nodeResult, startedAt, { output, nextNodeId: node.next, metadata: { branch, subflow: true } })
          }
          // 扁平 next 兜底
          const nextNodeId = typeof node.next === 'object' ? node.next[branch] : node.next
          context[node.id] = { condition, result, branch }
          return finishNode(nodeResult, startedAt, { output: result, nextNodeId, metadata: { branch } })
        }

        case 'switch': {
          // 多分支路由（openhuman switch）：config.expr 求值 → 匹配 config.branches[i].value → 走 next.<value> 或 next[分支索引]
          const expr = renderTemplate(node.config?.expr || node.config?.condition || 'context.input', context)
          const value = safeEvalValue(expr, context)
          const branches = node.config?.branches || []
          let matched = null
          for (const b of branches) {
            if (String(b?.value) === String(value)) { matched = b; break }
          }
          // 分支目标：优先 next[value]，其次 next[索引]，再次 next.default
          const o = node.next && typeof node.next === 'object' ? node.next : {}
          let nextNodeId = matched ? (o[matched.value] || o[String(branches.indexOf(matched))]) : null
          if (!nextNodeId) nextNodeId = o.default || (typeof node.next === 'string' ? node.next : null)
          context[node.id] = { value, matched: matched?.value ?? null, branches }
          return finishNode(nodeResult, startedAt, { output: value, nextNodeId, metadata: { value, matched: matched?.value ?? null } })
        }

        case 'loop': {
          const itemsPath = node.config?.items || 'input'
          const items = getNested(context, itemsPath) || []
          const results = []
          // 嵌套 blocks：body 块作为循环体子流（Coze 模型）
          const block = (node.blocks || []).find(b => {
            const bid = String(b.id || '').toLowerCase()
            const bl = String(b.label || '').toLowerCase()
            return bid === 'body' || bl === 'body' || bl.includes('循环') || bl.includes('loop')
          }) || (node.blocks || [])[0]
          if (block && Array.isArray(block.nodes) && block.nodes.length && Array.isArray(items)) {
            const entry = blockEntry(block)
            for (let i = 0; i < items.length; i++) {
              if (signal?.aborted) break
              context._loop_index = i
              context._loop_item = items[i]
              const { lastResult } = await runSubflow(block.nodes, entry, context, executionLog)
              results.push(lastResult?.output)
            }
            delete context._loop_index
            delete context._loop_item
          } else {
            // 扁平 body 兜底：body 指向外层节点
            const subNodeId = node.config?.body
            if (subNodeId && Array.isArray(items)) {
              for (let i = 0; i < items.length; i++) {
                if (signal?.aborted) break
                context._loop_index = i
                context._loop_item = items[i]
                const subNode = findNode({ nodes: scope || [] }, subNodeId)
                if (subNode) {
                  const subResult = await runNode(subNode, context, executionLog)
                  results.push(subResult.output)
                }
              }
              delete context._loop_index
              delete context._loop_item
            }
          }
          context[node.id] = { results, count: results.length }
          return finishNode(nodeResult, startedAt, { output: results, nextNodeId: node.next, metadata: { count: results.length } })
        }

        case 'parallel': {
          const blocks = node.blocks || []
          const branchConfigs = node.config?.branches || []
          let results
          if (blocks.length && blocks.every(b => Array.isArray(b.nodes))) {
            // 嵌套 blocks：每个 block 是一个并行分支子流（Coze 模型）
            results = await Promise.all(blocks.map(async (block) => {
              const branchContext = { ...context }
              const branchLog = []
              const entry = blockEntry(block)
              let output = null
              if (entry) {
                const { lastResult } = await runSubflow(block.nodes, entry, branchContext, branchLog)
                output = lastResult?.output ?? null
              }
              executionLog.push(...branchLog)
              return { block: block.id || block.label || '', output, context: branchContext }
            }))
          } else {
            // 扁平 branches 兜底：每个分支是节点 ID 数组
            results = await Promise.all(branchConfigs.map(async (branchNodes) => {
              const branchContext = { ...context }
              for (const nid of branchNodes) {
                if (signal?.aborted) break
                const n = findNode({ nodes: scope || [] }, nid)
                if (n) {
                  const r = await runNode(n, branchContext, executionLog)
                  if (r.isEnd) break
                }
              }
              return { output: branchContext, context: branchContext }
            }))
          }
          context[node.id] = { results }
          return finishNode(nodeResult, startedAt, { output: results, nextNodeId: node.next })
        }

        case 'merge': {
          // 汇聚（openhuman merge）：收集所有指向本节点的上游节点输出，作为 items 传给下游
          const upstream = (scope || []).filter(n => {
            const targets = n.next && typeof n.next === 'object' && !Array.isArray(n.next) ? Object.values(n.next) : (Array.isArray(n.next) ? n.next : [n.next])
            return targets.includes(node.id)
          })
          const items = []
          for (const n of upstream) {
            const v = context[n.id]?.output !== undefined ? context[n.id].output : context[n.id]
            if (Array.isArray(v)) items.push(...v)  // 上游已是数组（如并行分支结果）→ 展平
            else if (v !== null && v !== undefined) items.push(v)
          }
          const output = items  // fan-in barrier：把收集的 items 传下去（下游可迭代）
          context[node.id] = { items, upstream: upstream.map(n => n.id), output }
          return finishNode(nodeResult, startedAt, { output, nextNodeId: node.next, metadata: { merged: items.length } })
        }

        case 'transform': {
          // 转换（openhuman transform）：config.set = { key: "=expr" }，对上游输出求值并合并到结果
          const set = node.config?.set || {}
          const upstream = (scope || []).filter(n => {
            const targets = n.next && typeof n.next === 'object' && !Array.isArray(n.next) ? Object.values(n.next) : (Array.isArray(n.next) ? n.next : [n.next])
            return targets.includes(node.id)
          })
          const srcNode = upstream[upstream.length - 1]
          const item = srcNode ? (context[srcNode.id]?.output !== undefined ? context[srcNode.id].output : context[srcNode.id]) : context.input
          const base = (item && typeof item === 'object' && !Array.isArray(item)) ? { ...item } : { value: item }
          const out = { ...base }
          for (const [key, expr] of Object.entries(set)) {
            out[key] = evalItemExpr(expr, item, context)
          }
          context[node.id] = { result: out, item, set }
          return finishNode(nodeResult, startedAt, { output: out, nextNodeId: node.next })
        }

        case 'sub_workflow': {
          // 子流程复用（openhuman sub_workflow）：config.workflow 内联图 或 config.workflow_id 引用已保存
          const childGraph = node.config?.workflow
          const childId = node.config?.workflow_id
          if (!childGraph && !childId) throw new Error('sub_workflow 节点必须提供 config.workflow 或 config.workflow_id')
          if (childGraph && childId) throw new Error('sub_workflow 节点只能提供 workflow 或 workflow_id 之一')
          let child = childGraph
          if (childId && !child) {
            const { getWorkflow } = await import('../workflow/index.js')
            child = getWorkflow(childId)?.definition
          }
          if (!child || !Array.isArray(child.nodes)) throw new Error(`子工作流不可用: ${childId || 'inline'}`)
          if ((context._sub_depth || 0) >= 8) throw new Error('子工作流嵌套过深（上限 8 层）')

          // 解析子工作流输入（config.inputs 支持 =expr / {{var}}）
          const inputs = node.config?.inputs || {}
          const childInput = {}
          for (const [k, v] of Object.entries(inputs)) {
            if (typeof v === 'string' && v.startsWith('=')) {
              childInput[k] = evalItemExpr(v.slice(1), context[node.id]?.output ?? context.input, context)
            } else {
              const rv = renderTemplate(String(v), context)
              try { childInput[k] = JSON.parse(rv) } catch { childInput[k] = rv }
            }
          }
          if (Object.keys(childInput).length === 0) childInput.input = context.input

          const childEngine = createWorkflowEngine({ executeTool, executeLLM, signal })
          const childResult = await childEngine.run(
            { ...child, id: child.id || 'sub', name: child.name || '子流程' },
            childInput,
          )
          const childStatus = childResult.ok ? 'ok' : 'error'
          executionLog.push({
            node_id: node.id, node_type: 'sub_workflow', name: node.name,
            status: childStatus, output: childResult.output,
            duration_ms: Date.now() - startedAt,
            metadata: { subflow: childId || 'inline', child_steps: childResult.log?.length || 0, child_status: childResult.status },
          })
          context[node.id] = { result: childResult.output, raw: childResult, _sub_depth: (context._sub_depth || 0) + 1 }
          return finishNode(nodeResult, startedAt, { output: childResult.output, nextNodeId: node.next, metadata: { subflow: childId || 'inline', child_steps: childResult.log?.length || 0, child_status: childResult.status } })
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
          // S3：code 节点执行任意 JS。默认禁用（allowCode=false），由 createWorkflowEngine 显式开启——
          // 开启方（如 workflow_run 工具）须已具备 Agent 级代码执行能力，否则是越权入口。
          if (!allowCode) {
            context[node.id] = { result: { ok: false, error: 'code 节点被禁用（createWorkflowEngine 需 allowCode:true）' } }
            return finishNode(nodeResult, startedAt, { output: { ok: false, error: 'code 节点被禁用' }, nextNodeId: node.next, metadata: { codeDisabled: true } })
          }
          const code = renderTemplate(node.config?.code || '', context)
          const result = safeEvalCode(code, context)
          context[node.id] = { result }
          return finishNode(nodeResult, startedAt, { output: result, nextNodeId: node.next })
        }

        case 'room': {
          // 会议室节点（F1 收敛）：把「多Agent办公室」作为主引擎的一等节点。
          // config: { mode: 'office'|'crew'|'speak', content, roles?, process?, manager?, ... }
          const roomArgs = {
            mode: node.config?.mode || 'office',
            content: renderTemplate(node.config?.content || '', context),
            roles: node.config?.roles,
            process: node.config?.process,
            manager: node.config?.manager,
          }
          const roomResult = executeRoom
            ? await executeRoom(roomArgs)
            : { ok: false, error: '会议室执行器未配置（executeRoom）' }
          context[node.id] = { result: roomResult, args: roomArgs }
          const output = typeof roomResult === 'string' ? roomResult
            : (roomResult?.summary || roomResult?.ceoSummary || roomResult?.reply || roomResult?.error || roomResult)
          return finishNode(nodeResult, startedAt, { output, nextNodeId: node.next, metadata: { room: roomArgs.mode, ok: roomResult?.ok } })
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

      const result = await runNode(node, context, executionLog, workflow.nodes)
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

// 安全求值（transform/sub_workflow 的 =expr：可用 item.xxx / context.xxx / {{var}}）
function evalItemExpr(expr, item, context) {
  try {
    let raw = String(expr || '').trim()
    if (raw.startsWith('=')) raw = raw.slice(1)  // 剥离 =expr 前缀
    const cleaned = raw.replace(/\{\{([^}]+)\}\}/g, (_, path) => {
      const val = getNested(context, path.trim())
      if (typeof val === 'string') return JSON.stringify(val)
      return String(val ?? 'null')
    })
    if (!/^[\s\w'"()<>=!&|+\-*/%.\[\],.]+$/.test(cleaned)) return undefined
    // eslint-disable-next-line no-new-func
    return new Function('context', 'item', `"use strict"; return (${cleaned})`)(context, item)
  } catch {
    return undefined
  }
}

// 安全求值（返回原始值，供 switch 分支匹配；支持 {{var}} 模板变量 与 context.xxx 直接引用）
function safeEvalValue(expr, context) {
  try {
    const cleaned = String(expr || '').replace(/\{\{([^}]+)\}\}/g, (_, path) => {
      const val = getNested(context, path.trim())
      if (typeof val === 'string') return JSON.stringify(val)
      return String(val ?? 'null')
    })
    if (!/^[\s\w'"()<>=!&|+\-*/%.\[\],.]+$/.test(cleaned)) return undefined
    // eslint-disable-next-line no-new-func
    return new Function('context', `"use strict"; return (${cleaned})`)(context)
  } catch {
    return undefined
  }
}

// 安全条件求值（只允许简单比较和逻辑运算；支持 {{var}} 模板变量 与 context.xxx 直接引用）
function safeEvalCondition(condition, context) {
  try {
    // 替换 {{var}} 变量引用
    const expr = condition.replace(/\{\{([^}]+)\}\}/g, (_, path) => {
      const val = getNested(context, path.trim())
      if (typeof val === 'string') return JSON.stringify(val)
      return String(val ?? 'null')
    })
    // 只允许安全字符
    if (!/^[\s\w'"()<>=!&|+\-*/%.\[\],.]+$/.test(expr)) return false
    // eslint-disable-next-line no-new-func
    return Boolean(new Function('context', `"use strict"; return (${expr})`)(context))
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
