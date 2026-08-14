// 多 Agent 办公室 API
import { AGENTS } from '../../multi-agent/agents.js'
import { chatWithAgent, assignTaskToAgent, getConversation, resetConversation } from '../../multi-agent/manager.js'
import { jsonResponse, readJsonBody } from '../utils.js'

export async function handleAgentRoutes(req, res, url) {
  // GET /agents —— 列出所有 Agent
  if (req.method === 'GET' && url.pathname === '/agents') {
    const list = AGENTS.map(a => {
      const conv = getConversation(a.id, 2)
      return {
        id: a.id, name: a.name, role: a.role, avatar: a.avatar, color: a.color,
        capabilities: a.capabilities, description: a.persona,
        last: conv[conv.length - 1] || null,
      }
    })
    jsonResponse(res, 200, { ok: true, agents: list })
    return true
  }

  // GET /agents/:id/messages —— 某 Agent 的对话历史
  const msgMatch = url.pathname.match(/^\/agents\/([^/]+)\/messages$/)
  if (req.method === 'GET' && msgMatch) {
    jsonResponse(res, 200, { ok: true, agentId: msgMatch[1], messages: getConversation(msgMatch[1], 50) })
    return true
  }

  // POST /agents/:id/message —— 与某 Agent 对话
  const chatMatch = url.pathname.match(/^\/agents\/([^/]+)\/message$/)
  if (req.method === 'POST' && chatMatch) {
    try {
      const body = await readJsonBody(req)
      const result = await chatWithAgent(chatMatch[1], body?.content)
      jsonResponse(res, 200, { ok: true, ...result })
    } catch (err) {
      jsonResponse(res, 400, { ok: false, error: err.message })
    }
    return true
  }

  // POST /agents/:id/task —— 布置任务
  const taskMatch = url.pathname.match(/^\/agents\/([^/]+)\/task$/)
  if (req.method === 'POST' && taskMatch) {
    try {
      const body = await readJsonBody(req)
      const result = await assignTaskToAgent(taskMatch[1], body?.task)
      jsonResponse(res, 200, { ok: true, ...result })
    } catch (err) {
      jsonResponse(res, 400, { ok: false, error: err.message })
    }
    return true
  }

  // POST /agents/:id/reset —— 清空某 Agent 对话
  const resetMatch = url.pathname.match(/^\/agents\/([^/]+)\/reset$/)
  if (req.method === 'POST' && resetMatch) {
    resetConversation(resetMatch[1])
    jsonResponse(res, 200, { ok: true })
    return true
  }

  return false
}
