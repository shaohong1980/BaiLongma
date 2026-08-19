// workflow/proposer.js —— Agent 自主工作流设计（移植自 openhuman propose_workflow）
//
// 让 Agent 根据一句自然语言需求，自主设计一个多步骤工作流图：
//   1. 把「节点目录 + 图格式」作为系统提示喂给 LLM
//   2. LLM 输出工作流 JSON → 校验 → 失败则带错误信息重试一次
//   3. 成功返回 workflow_proposal 提案（require_approval=true，HITL 门控）
//
// 提案由前端工作流编辑器接收：用户审阅 → 接受 → 加载到画布 → 保存/运行。

import { validateWorkflow } from './schema.js'

// 节点目录（供 LLM 设计时参考，与编辑器/引擎保持一致）
const NODE_CATALOG = [
  { type: 'start', note: '起始节点（唯一）。config: {}，next 指向第一步', example: '{ "id":"start","type":"start","name":"开始","config":{},"next":"llm1" }' },
  { type: 'llm', note: '调用 LLM。config.prompt 支持 {{input}} / {{节点id.输出名}} 模板变量', example: '{ "id":"llm1","type":"llm","name":"总结","config":{"prompt":"总结：{{input}}"},"outputs":[{"name":"answer","source":"output"}],"next":"..." }' },
  { type: 'tool', note: '调用内置工具（knowledge_search / run_python / web_search / read_file / write_file / send_message / cost_stats 等）。config.tool + config.args', example: '{ "id":"t1","type":"tool","name":"检索","config":{"tool":"knowledge_search","args":{"query":"{{input}}"}},"next":"..." }' },
  { type: 'condition', note: '真/假二分支。config.condition 是 JS 表达式（可用 context.input / {{var}}）', example: '{ "id":"c1","type":"condition","name":"判断","config":{"condition":"(context.input||\\"\\").length>10"},"next":{"true":"a1","false":"a2"} }' },
  { type: 'switch', note: '多分支路由。config.expr 求值，config.branches=[{value,label}] 定义分支；next 为 {分支值:"节点id", default:"节点id"}', example: '{ "id":"sw1","type":"switch","name":"分级","config":{"expr":"context.input.type","branches":[{"value":"urgent","label":"紧急"},{"value":"normal","label":"普通"}]},"next":{"urgent":"a1","normal":"a2","default":"end"} }' },
  { type: 'loop', note: '遍历数组。config.items 是数组路径（如 input.items）；循环体用 blocks 子流', example: '{ "id":"lp1","type":"loop","name":"遍历","config":{"items":"input.items"},"blocks":[{"id":"body","label":"循环体","nodes":[子流节点...]}],"next":"..." }' },
  { type: 'parallel', note: '并行分支。每个 block 是一个并行分支子流', example: '{ "id":"pp1","type":"parallel","name":"并行","config":{},"blocks":[{"id":"b1","label":"分支1","nodes":[...]},{"id":"b2","label":"分支2","nodes":[...]}],"next":"..." }' },
  { type: 'code', note: 'JS 代码节点。可用 context 访问变量，return 的值即输出', example: '{ "id":"cd1","type":"code","name":"清洗","config":{"code":"return { clean: String(context.input).trim() }"},"next":"..." }' },
  { type: 'approval', note: '人工审批节点。config.title + risk_level', example: '{ "id":"ap1","type":"approval","name":"审批","config":{"title":"确认删除","risk_level":"high"},"next":"..." }' },
  { type: 'end', note: '结束节点（可多个）。next 为 null', example: '{ "id":"end","type":"end","name":"结束","config":{},"next":null }' },
]

const GRAPH_FORMAT = `
工作流图 JSON 格式：
{
  "name": "工作流名",
  "description": "用途说明（可选）",
  "nodes": [ <节点对象...> ]
}
规则：
1. 必须有一个 type="start" 节点；至少一个 type="end" 节点
2. 每个节点的 next：普通节点为字符串节点id；condition/approval 为 {分支:"节点id"}；switch 为 {分支值:"节点id", default:"节点id"}；end 为 null
3. next 必须指向已存在的节点 id，不能悬空
4. 条件/循环/并行如需子流，用 blocks: [{id, label, nodes:[子节点...]}]（循环体 id 用 "body"，条件用 "true"/"false"）
5. llm/tool/code 可加 "outputs":[{"name":"输出名","source":"output"}]，下游用 {{节点id.输出名}} 引用其输出
只输出一个 JSON 对象，不要任何其它文字、注释或代码块围栏。`

const SYSTEM_PROMPT = `你是工作流设计专家。根据用户的一句话需求，设计一个最小可行、可靠的多步骤 Agent 工作流图。

${GRAPH_FORMAT}

可用节点类型（含配置示例）：
${NODE_CATALOG.map(c => `- ${c.type}：${c.note}\n  示例：${c.example}`).join('\n')}

设计原则：
- 用最少节点完成需求；读/查/计算优先用 tool / code，需要理解/生成文本用 llm
- 变量流：上游节点输出用 {{节点id.输出名}} 引用；LLM/工具/代码节点声明 outputs 让下游可引用
- 有分支就用 condition（二分支）或 switch（多分支）；重复处理用 loop；互不依赖的多路用 parallel`

function sanitizeGraphText(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/)
  return m ? m[0] : String(text || '')
}

// 主入口：设计并校验工作流，返回 workflow_proposal
export async function proposeWorkflow({ name, task, description = '' } = {}) {
  const n = String(name || '').trim()
  const t = String(task || '').trim()
  if (!n) return { ok: false, error: '缺少 name' }
  if (!t) return { ok: false, error: '缺少 task' }

  const { runSimpleCompletion } = await import('../llm.js')
  const prompt = `工作流名称：${n}\n用户需求：${t}${description ? `\n补充说明：${description}` : ''}\n\n请设计并输出上述 JSON 工作流图。`

  let lastErr = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const reply = await runSimpleCompletion({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt + (lastErr ? `\n\n上次设计校验未通过，请修正这些错误后重新输出完整 JSON：\n${lastErr}` : '') },
        ],
        temperature: 0.3,
        maxTokens: 5000,
      })
      const graph = JSON.parse(sanitizeGraphText(reply))
      if (!graph || typeof graph !== 'object' || !Array.isArray(graph.nodes)) {
        lastErr = '输出不是合法的工作流图对象（缺少 nodes 数组）'
        continue
      }
      const wf = { id: `proposed_${Date.now().toString(36)}`, name: n, description: description || graph.description || '', ...graph }
      const validation = validateWorkflow(wf)
      if (validation.valid) {
        const steps = (wf.nodes || [])
          .filter(x => x.type !== 'start' && x.type !== 'end')
          .map(x => ({ kind: x.type, name: x.name || x.id }))
        return {
          ok: true,
          proposal: {
            type: 'workflow_proposal',
            name: n,
            graph: wf,
            require_approval: true,
            summary: { trigger: t, steps },
          },
        }
      }
      lastErr = validation.errors.join('; ')
    } catch (err) {
      lastErr = err?.message || String(err)
    }
  }
  return { ok: false, error: `工作流设计失败（已重试一次）：${lastErr}` }
}
