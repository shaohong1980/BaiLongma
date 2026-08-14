// 多 Agent 会议室 —— 引擎路由：每个 Agent 可用不同的大模型/引擎
//   internal : 白龙马主模型 + 该 Agent 人格（默认，零配置）
//   custom   : 自选 OpenAI 兼容端点（base_url/api_key/model）
//   cli      : 调用外部 CLI 智能体（Claude Code / Codex / Hermes 等，需本机安装并配置命令）
import OpenAI from 'openai'
import { execFileSync } from 'child_process'
import { runSimpleCompletion } from '../llm.js'
import { getAgentConfig } from './config.js'

function buildSystemPrompt(agent) {
  const parts = [
    `你是「${agent.name}」，担任${agent.role}。`,
    agent.persona,
    agent.style,
    `你的专长：${(agent.capabilities || []).join('、')}。`,
    '保持角色设定，用第一人称回答。专业、具体、可执行；不确定就说明。',
  ]
  // 私有记忆（仅该 Agent 可见，其他角色无法调取）：演算草稿、内部清单、历史沉淀
  if (agent.private_memory && String(agent.private_memory).trim()) {
    parts.push(`【你的私有记忆（仅你自己可见）】\n${String(agent.private_memory).trim()}`)
  }
  return parts.join('\n')
}

// 生成给引擎的 messages
function buildMessages(agent, roomHistory, bossMessage, isTask = false) {
  const sys = buildSystemPrompt(agent)
  const msgs = [{ role: 'system', content: sys }]
  // 注入近期会议室上下文（老板和其他 Agent 的发言），让 Agent 知道全貌
  for (const m of roomHistory.slice(-12)) {
    if (m.role === 'boss') msgs.push({ role: 'user', content: `[老板] ${m.content}` })
    else if (m.role === 'agent' && m.agentId !== agent.id) {
      msgs.push({ role: 'user', content: `[${m.agentName || '同事'} 说] ${m.content}` })
    }
  }
  msgs.push({ role: 'user', content: isTask ? `【老板布置任务给你】${bossMessage}` : `[老板 点名你] ${bossMessage}` })
  if (isTask) {
    msgs.push({ role: 'system', content: '这是任务布置。直接给出可执行交付（方案/清单/代码/步骤），不要只回"收到"。结构化交付。' })
  }
  return msgs
}

// 内部引擎：白龙马主模型 + 人格
async function runInternal(agent, roomHistory, bossMessage, isTask) {
  const messages = buildMessages(agent, roomHistory, bossMessage, isTask)
  return runSimpleCompletion({ messages, temperature: Number(agent.temperature) || 0.5, maxTokens: isTask ? 1600 : 1200 })
}

// 自定义引擎：独立 OpenAI 兼容端点
async function runCustom(agent, roomHistory, bossMessage, isTask) {
  if (!agent.base_url || !agent.api_key || !agent.model) {
    throw new Error(`Agent ${agent.name} 的 custom 引擎缺少 base_url/api_key/model 配置`)
  }
  const client = new OpenAI({ apiKey: agent.api_key, baseURL: agent.base_url })
  const messages = buildMessages(agent, roomHistory, bossMessage, isTask)
  const res = await client.chat.completions.create({
    model: agent.model,
    messages,
    temperature: Number(agent.temperature) || 0.5,
    max_tokens: isTask ? 1600 : 1200,
  })
  return res?.choices?.[0]?.message?.content?.trim?.() || ''
}

// CLI 引擎：调用外部智能体（Claude Code / Codex / Hermes ...）
async function runCli(agent, roomHistory, bossMessage, isTask) {
  const cmd = String(agent.cli_command || '').trim()
  if (!cmd) throw new Error(`Agent ${agent.name} 的 cli 引擎缺少 cli_command 配置（如 claude -p "..."）`)
  const prompt = (isTask ? '【任务】' : '【对话】') + bossMessage
  const fullCmd = cmd.replace(/\{prompt\}/g, `"${prompt.replace(/"/g, '\\"')}"`)
  const out = execFileSync(fullCmd, { shell: true, timeout: 180000, maxBuffer: 8 * 1024 * 1024 })
  return String(out || '').trim().slice(0, 4000) || '(该外部智能体未输出)'
}

// 统一入口：按 Agent 的 engine 路由；cli/custom 失败时回退 internal，保证一定有响应
export async function runAgentEngine(agentId, roomHistory, bossMessage, isTask = false) {
  const agent = getAgentConfig(agentId)
  if (!agent) throw new Error(`未知 Agent: ${agentId}`)
  const engine = String(agent.engine || 'internal').trim().toLowerCase()
  if (engine === 'custom') {
    try { return await runCustom(agent, roomHistory, bossMessage, isTask) }
    catch (err) { console.warn(`[agent:${agent.name}] custom 失败，回退 internal:`, err.message); return runInternal(agent, roomHistory, bossMessage, isTask) }
  }
  if (engine === 'cli') {
    try { return await runCli(agent, roomHistory, bossMessage, isTask) }
    catch (err) { console.warn(`[agent:${agent.name}] cli 失败，回退 internal:`, err.message); return runInternal(agent, roomHistory, bossMessage, isTask) }
  }
  return runInternal(agent, roomHistory, bossMessage, isTask)
}
