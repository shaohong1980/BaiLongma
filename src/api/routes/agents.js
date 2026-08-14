// 多 Agent 会议室 API
import { getAllAgentConfigs, getAgentConfig, updateAgentConfig } from '../../multi-agent/config.js'
import { bossSpeak, assignTask, getRoomHistory, resetRoom, getMeetingRound } from '../../multi-agent/room.js'
import { jsonResponse, readJsonBody } from '../utils.js'

export async function handleAgentRoutes(req, res, url) {
  // GET /agents —— 列出所有 Agent（含形象/语音/引擎配置）
  if (req.method === 'GET' && url.pathname === '/agents') {
    const agents = getAllAgentConfigs().map(a => {
      const { api_key, ...pub } = a
      return { ...pub, has_api_key: !!api_key }
    })
    jsonResponse(res, 200, { ok: true, agents })
    return true
  }

  // GET /agents/:id —— 单 Agent 配置（含脱敏 key）
  const oneMatch = url.pathname.match(/^\/agents\/([^/]+)$/)
  if (req.method === 'GET' && oneMatch) {
    const agent = getAgentConfig(oneMatch[1])
    if (!agent) { jsonResponse(res, 404, { ok: false, error: 'unknown agent' }); return true }
    const { api_key, ...pub } = agent
    jsonResponse(res, 200, { ok: true, agent: { ...pub, has_api_key: !!api_key } })
    return true
  }

  // POST /agents/:id/config —— 更新 Agent 配置（形象/语音/引擎/模型等）
  const cfgMatch = url.pathname.match(/^\/agents\/([^/]+)\/config$/)
  if (req.method === 'POST' && cfgMatch) {
    try {
      const body = await readJsonBody(req)
      const r = updateAgentConfig(cfgMatch[1], body)
      if (!r.ok) { jsonResponse(res, 400, r); return true }
      const { api_key, ...pub } = r.agent
      jsonResponse(res, 200, { ok: true, agent: { ...pub, has_api_key: !!api_key } })
    } catch (err) { jsonResponse(res, 400, { ok: false, error: err.message }) }
    return true
  }

  // GET /room —— 会议室历史 + 会议轮次
  if (req.method === 'GET' && url.pathname === '/room') {
    jsonResponse(res, 200, { ok: true, round: getMeetingRound(), messages: getRoomHistory(200) })
    return true
  }

  // POST /room/message —— 老板发言（点名/推断 → 对应 Agent 响应）
  if (req.method === 'POST' && url.pathname === '/room/message') {
    try {
      const body = await readJsonBody(req)
      const result = await bossSpeak(body?.content)
      jsonResponse(res, 200, { ok: true, ...result })
    } catch (err) { jsonResponse(res, 400, { ok: false, error: err.message }) }
    return true
  }

  // POST /agents/:id/task —— 布置任务给指定 Agent
  const taskMatch = url.pathname.match(/^\/agents\/([^/]+)\/task$/)
  if (req.method === 'POST' && taskMatch) {
    try {
      const body = await readJsonBody(req)
      const result = await assignTask(taskMatch[1], body?.task)
      jsonResponse(res, 200, { ok: true, ...result })
    } catch (err) { jsonResponse(res, 400, { ok: false, error: err.message }) }
    return true
  }

  // POST /room/reset —— 清空会议室
  if (req.method === 'POST' && url.pathname === '/room/reset') {
    resetRoom()
    jsonResponse(res, 200, { ok: true })
    return true
  }

  return false
}
