// workflow/schema.js —— 工作流 JSON Schema 定义与验证
//
// 工作流是一个有向无环图（DAG），由节点和边组成。
// 节点类型：
//   - start      : 起始节点（唯一）
//   - end        : 结束节点（可有多个）
//   - llm        : LLM 调用节点
//   - tool       : 工具调用节点（调用 Agent 已注册的工具）
//   - condition  : 条件分支节点（if/else）
//   - loop       : 循环节点（对数组逐项执行子工作流）
//   - parallel   : 并行节点（同时执行多个分支）
//   - human_input: 人工输入节点（暂停等待用户输入）
//   - approval   : 审批节点（HITL）
//   - code       : 代码执行节点（JavaScript 表达式，沙箱内）
//
// 每个节点有：id, type, name, config, next（下一个节点ID或条件映射）
// 数据通过 context 变量在节点间传递，用 {{variable}} 语法引用。

const NODE_TYPES = ['start', 'end', 'llm', 'tool', 'condition', 'switch', 'loop', 'parallel', 'human_input', 'approval', 'code']

// 验证工作流定义
export function validateWorkflow(workflow, { allowNoStart = false } = {}) {
  const errors = []
  if (!workflow || typeof workflow !== 'object') {
    return { valid: false, errors: ['workflow 必须是对象'] }
  }
  if (!workflow.id) errors.push('缺少 id')
  if (!workflow.name) errors.push('缺少 name')
  if (!Array.isArray(workflow.nodes) || workflow.nodes.length === 0) {
    return { valid: false, errors: [...errors, 'nodes 必须是非空数组'] }
  }

  const nodeIds = new Set()
  let startCount = 0

  for (const node of workflow.nodes) {
    if (!node.id) { errors.push('节点缺少 id'); continue }
    if (nodeIds.has(node.id)) { errors.push(`节点 id 重复: ${node.id}`); continue }
    nodeIds.add(node.id)

    if (!NODE_TYPES.includes(node.type)) {
      errors.push(`节点 ${node.id} 类型无效: ${node.type}（支持: ${NODE_TYPES.join(', ')}）`)
    }
    if (node.type === 'start') startCount++

    // 节点特定验证
    if (node.type === 'llm' && !node.config?.prompt) {
      errors.push(`LLM 节点 ${node.id} 缺少 config.prompt`)
    }
    if (node.type === 'tool' && !node.config?.tool) {
      errors.push(`工具节点 ${node.id} 缺少 config.tool`)
    }
    if (node.type === 'condition' && !node.config?.condition) {
      errors.push(`条件节点 ${node.id} 缺少 config.condition`)
    }
    if (node.type === 'switch' && !node.config?.expr) {
      errors.push(`分支节点 ${node.id} 缺少 config.expr`)
    }
    if (node.type === 'code' && !node.config?.code) {
      errors.push(`代码节点 ${node.id} 缺少 config.code`)
    }

    // 命名输出：node.outputs = [{ name, source?, description? }]
    if (node.outputs !== undefined) {
      if (!Array.isArray(node.outputs)) {
        errors.push(`节点 ${node.id} 的 outputs 必须是数组`)
      } else {
        for (const o of node.outputs) {
          if (!o || typeof o !== 'object') { errors.push(`节点 ${node.id} 的 outputs 元素必须是对象`); continue }
          if (!String(o.name || '').trim()) errors.push(`节点 ${node.id} 的 outputs 元素缺少 name`)
        }
      }
    }

    // 嵌套 blocks：node.blocks = [{ id, label, nodes: [...] }]（条件分支/循环体/并行分支子流）
    if (node.blocks !== undefined) {
      if (!Array.isArray(node.blocks)) {
        errors.push(`节点 ${node.id} 的 blocks 必须是数组`)
      } else {
        const blockIds = new Set()
        for (const b of node.blocks) {
          if (!b || typeof b !== 'object') { errors.push(`节点 ${node.id} 的 blocks 元素必须是对象`); continue }
          const bid = String(b.id || '')
          if (!bid) { errors.push(`节点 ${node.id} 的 block 缺少 id`); continue }
          if (blockIds.has(bid)) { errors.push(`节点 ${node.id} 的 block id 重复: ${bid}`); continue }
          blockIds.add(bid)
          if (!Array.isArray(b.nodes) || b.nodes.length === 0) {
            errors.push(`节点 ${node.id} 的 block「${bid}」必须包含非空 nodes`)
            continue
          }
          // 递归校验子流（子流入口是 block.start 或首个节点，不强制 start 节点）
          const sub = validateWorkflow({ id: `${node.id}__${bid}`, name: `${node.id}__${bid}`, nodes: b.nodes }, { allowNoStart: true })
          for (const e of sub.errors) errors.push(`[${node.id}.${bid}] ${e}`)
        }
      }
    }
  }

  if (startCount === 0 && !allowNoStart) errors.push('缺少 start 节点')
  if (startCount > 1) errors.push(`有 ${startCount} 个 start 节点，只能有 1 个`)

  // 验证边的目标节点存在
  for (const node of workflow.nodes) {
    if (node.next) {
      if (typeof node.next === 'string' && !nodeIds.has(node.next)) {
        errors.push(`节点 ${node.id} 的 next 指向不存在的节点: ${node.next}`)
      }
      if (typeof node.next === 'object') {
        for (const [key, target] of Object.entries(node.next)) {
          if (target && !nodeIds.has(target)) {
            errors.push(`节点 ${node.id} 的 next.${key} 指向不存在的节点: ${target}`)
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors }
}

// 模板变量替换：{{var.path}} → context 中的值
export function renderTemplate(str, context) {
  if (typeof str !== 'string') return str
  return str.replace(/\{\{([^}]+)\}\}/g, (match, path) => {
    const value = getNestedValue(context, path.trim())
    return value === undefined ? match : String(value)
  })
}

function getNestedValue(obj, path) {
  return path.split('.').reduce((acc, key) => {
    if (acc === null || acc === undefined) return undefined
    // 支持数组索引：items.0.name
    const idx = Number(key)
    if (!isNaN(idx) && Array.isArray(acc)) return acc[idx]
    return acc[key]
  }, obj)
}

// 内置工作流模板
export const WORKFLOW_TEMPLATES = {
  simple_qa: {
    id: 'simple_qa',
    name: '简单问答',
    description: '用户提问 → LLM 回答',
    nodes: [
      { id: 'start', type: 'start', name: '开始', next: 'answer' },
      { id: 'answer', type: 'llm', name: '回答', config: { prompt: '{{input}}' }, next: 'end' },
      { id: 'end', type: 'end', name: '结束' },
    ],
  },

  research_then_answer: {
    id: 'research_then_answer',
    name: '检索后回答',
    description: '知识库检索 → LLM 基于检索结果回答',
    nodes: [
      { id: 'start', type: 'start', name: '开始', next: 'search' },
      { id: 'search', type: 'tool', name: '检索知识库', config: { tool: 'knowledge_search', args: { query: '{{input}}', limit: 5 } }, next: 'answer' },
      { id: 'answer', type: 'llm', name: '基于检索回答', config: { prompt: '基于以下检索结果回答问题：\n\n检索结果：\n{{search.result}}\n\n问题：{{input}}' }, next: 'end' },
      { id: 'end', type: 'end', name: '结束' },
    ],
  },

  approve_then_execute: {
    id: 'approve_then_execute',
    name: '审批后执行',
    description: '请求审批 → 通过则执行工具，拒绝则终止',
    nodes: [
      { id: 'start', type: 'start', name: '开始', next: 'approve' },
      { id: 'approve', type: 'approval', name: '审批', config: { title: '操作确认', description: '{{input}}', risk_level: 'medium' }, next: { approved: 'execute', rejected: 'rejected_end' } },
      { id: 'execute', type: 'tool', name: '执行', config: { tool: '{{tool_name}}', args: {} }, next: 'end' },
      { id: 'rejected_end', type: 'end', name: '已拒绝' },
      { id: 'end', type: 'end', name: '完成' },
    ],
  },

  data_analysis: {
    id: 'data_analysis',
    name: '数据分析',
    description: 'Python 分析数据 → 生成图表 → LLM 解读',
    nodes: [
      { id: 'start', type: 'start', name: '开始', next: 'analyze' },
      { id: 'analyze', type: 'tool', name: 'Python 分析', config: { tool: 'run_python', args: { code: '{{code}}' } }, next: 'interpret' },
      { id: 'interpret', type: 'llm', name: '解读结果', config: { prompt: '解读以下数据分析结果：\n\n{{analyze.result}}' }, next: 'end' },
      { id: 'end', type: 'end', name: '结束' },
    ],
  },
}

export { NODE_TYPES }
