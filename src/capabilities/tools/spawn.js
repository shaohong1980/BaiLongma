// spawn_subagents —— 多 Agent 并行协作（P1-2）
// 把复杂任务拆成若干独立子问题，并行调用 LLM（与主 Agent 同 provider/model），
// 各自独立推理，汇总结果返回主 Agent 综合。适合"一个查资料、一个写代码、一个审校"。
import { throwIfAborted } from '../abort-utils.js'
import { runSimpleCompletion } from '../../llm.js'
import { emitEvent } from '../../events.js'

function toolJson(obj) { return JSON.stringify(obj, null, 2) }

export async function execSpawnSubagents(args = {}, context = {}) {
  throwIfAborted(context.signal)
  const task = String(args.task || args.goal || '').trim()
  const subtasks = Array.isArray(args.subtasks) ? args.subtasks : []
  const maxWorkers = Math.min(Math.max(Number(args.workers) || 3, 1), 5)

  if (!task && !subtasks.length) {
    return toolJson({ ok: false, tool: 'spawn_subagents', error: '需要 task（总目标）或 subtasks（子任务列表）' })
  }

  // 子任务归一化：支持 subtasks 数组 [{id,prompt}]，或单个 task 自动拆成 2-3 个角度
  let jobs = subtasks.map((s, i) => ({
    id: String(s.id || `sub${i + 1}`),
    prompt: String(s.prompt || s.text || '').trim(),
  })).filter(j => j.prompt)

  if (!jobs.length && task) {
    jobs = [
      { id: 'overview', prompt: `就"${task}"给出核心要点和结论（300字内）` },
      { id: 'detail', prompt: `就"${task}"补充关键细节、数据、步骤或证据（300字内）` },
      { id: 'risk', prompt: `就"${task}"指出风险、误区或需要注意的点（300字内）` },
    ]
  }
  if (!jobs.length) return toolJson({ ok: false, tool: 'spawn_subagents', error: '没有可执行的子任务' })

  jobs = jobs.slice(0, maxWorkers)
  emitEvent('action', { tool: 'spawn_subagents', summary: `并行派发 ${jobs.length} 个子代理`, detail: task || jobs.map(j => j.id).join(',') })
  console.log(`[spawn_subagents] ${jobs.length} workers: ${jobs.map(j => j.id).join(', ')}`)

  // 并行执行（Promise.allSettled，单个子代理失败不拖垮整体）
  const results = await Promise.allSettled(jobs.map(async (job) => {
    throwIfAborted(context.signal)
    try {
      const text = await runSimpleCompletion({
        messages: [
          { role: 'system', content: 'You are a focused sub-agent. Answer the given sub-task concisely and factually in the same language as the prompt. Do not over-explain. If unsure, say so.' },
          { role: 'user', content: job.prompt },
        ],
        temperature: 0.3,
        maxTokens: 1200,
      })
      return { id: job.id, ok: true, result: text.slice(0, 4000) }
    } catch (err) {
      return { id: job.id, ok: false, error: err.message || String(err) }
    }
  }))

  const collected = results.map(r => r.status === 'fulfilled' ? r.value : { id: '?', ok: false, error: r.reason?.message || String(r.reason) })

  return toolJson({
    ok: true,
    tool: 'spawn_subagents',
    task: task || '',
    workers: collected.length,
    results: collected,
    guidance: '把上面各子代理的 results 综合成对用户请求的最终回答：去重、合并、按重要性组织；某子代理失败可标注或用自己的知识补充。',
  })
}
