// reflection.js —— 失败反思闭环（Reflexion）
//
// 对齐主流 Agent 的 Reflexion 思路：任务/工具失败时，把"发生了什么 / 为什么失败 /
// 下次怎么改"沉淀为 kind:reflection 记忆。同类上下文再次出现时，注入器按语义召回
// 自动带上这些反思（记忆系统已支持，无需额外注入逻辑）。
//
// 只在「真实失败」时写入（工具熔断 / 任务失败），避免高频路径噪音。
import { insertMemory } from '../db.js'
import { nowTimestamp } from '../time.js'

export function recordReflection({ content, task = '', tags = [], eventType = 'knowledge' }) {
  try {
    const text = String(content || '').trim()
    if (!text) return false
    insertMemory({
      event_type: eventType,
      title: `反思：${String(task || text).slice(0, 40)}`,
      content: text.slice(0, 500),
      detail: task ? `task: ${String(task).slice(0, 200)}` : '',
      tags: ['kind:reflection', ...(Array.isArray(tags) ? tags : [])],
      entities: ['agent:jarvis'],
      salience: 4,
      timestamp: nowTimestamp(),
    })
    return true
  } catch (err) {
    console.warn('[reflection] 写入失败:', err?.message || err)
    return false
  }
}

// 从工具结果/错误构造一条反思文本
export function buildReflectionFromFailure({ _task = '', tool = '', reason = '', lesson = '' }) {
  const parts = []
  if (tool) parts.push(`工具 ${tool} 失败`)
  if (reason) parts.push(`原因: ${reason}`)
  if (lesson) parts.push(`教训: ${lesson}`)
  if (!parts.length) return ''
  return parts.join('。') + '。下次遇到类似情况应参考此教训。'
}
