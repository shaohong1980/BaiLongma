// 多 Agent 会议室 —— 引擎路由：每个 Agent 可用不同的大模型/引擎
//   internal : 爻台主模型 + 该 Agent 人格（默认，零配置）
//   custom   : 自选 OpenAI 兼容端点（base_url/api_key/model）
//   cli      : 调用外部 CLI 智能体（Claude Code / Codex / Hermes 等，需本机安装并配置命令）
import OpenAI from 'openai'
import { spawn } from 'child_process'
import { runSimpleCompletion, callLLM } from '../llm.js'
import { getAgentConfig } from './config.js'
import { getMemorySnapshot, searchMemory } from './memory.js'

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
async function buildMessages(agent, roomHistory, bossMessage, isTask = false) {
  const sys = buildSystemPrompt(agent)
  // 注入办公室长期记忆：近期快照 + 语义召回的"相关历史记忆"（向量记忆）
  const memory = getMemorySnapshot(6)
  const relevant = await searchMemory(bossMessage, 4)
  let sysContent = sys
  if (memory) sysContent += `\n\n【办公室近期记忆（最近决策/结论）】\n${memory}`
  if (relevant) sysContent += `\n\n【办公室相关历史记忆（语义召回，可参考）】\n${relevant}`
  const msgs = [{ role: 'system', content: sysContent }]
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

// 内部引擎：爻台主模型 + 人格（输出放宽，避免长回复被截断）
// 若 Agent 配置了 tools，则走 callLLM 完整工具循环（执行真实工具→带回结果→继续），
// 让工位员工真正"干活"而不是只输出文本；无工具或工具循环失败则回退纯文本完成。
async function runInternal(agent, roomHistory, bossMessage, isTask) {
  const messages = await buildMessages(agent, roomHistory, bossMessage, isTask)
  // P2-2：子角色可选 fast 模型（flash）——低风险角色（如摘要/记录）配置 fast:true 省成本；
  // 默认 false 保持主模型质量（CEO/军机处等核心角色不应降级）
  const fast = agent.fast === true
  let tools = Array.isArray(agent.tools) && agent.tools.length ? agent.tools : []
  if (tools.length) {
    // ③ 高危命令纵深防御：权限变更/安装/系统级工具对子 agent 一律禁用
    //（即使配进 allowlist 也会被过滤，防止子 agent 越权；exec_command 的危险
    //  命令由 isDangerousShellCommand 另行拦截）
    const SUBAGENT_FORBIDDEN = new Set([
      'manage_rule', 'set_security', 'install_software', 'install_tool', 'uninstall_tool',
      'manage_tool_factory', 'grant_agent_delegation', 'manage_api_capability',
      'kill_process', 'generate_image', 'generate_music', 'download_file',
      'exec_background_command', 'workflow_save', 'workflow_delete',
    ])
    tools = tools.filter(t => !SUBAGENT_FORBIDDEN.has(t))
    try {
      const result = await callLLM({
        messages,
        tools,
        temperature: Number(agent.temperature) || 0.5,
        maxTokens: isTask ? 3000 : 2500,
        localReply: true,   // 本地办公室渠道：纯文本即最终回复，无需 send_message
        mustReply: true,
        toolContext: { subAgent: true, agentId: agent.id },   // 标记为子 agent，供策略层识别
        onToolCall: (tool) => console.log(`[agent:${agent.name}] 调用工具 → ${tool?.name || tool}`),
        onToolExecute: (tool, res) => console.log(`[agent:${agent.name}] ${tool?.name || tool} → ${String(res || '').slice(0, 80)}`),
      })
      const text = String(result?.content || '').trim()
      return text || '（该环节未返回内容）'
    } catch (err) {
      console.warn(`[agent:${agent.name}] 工具循环失败，回退纯文本:`, err.message)
    }
  }
  return runSimpleCompletion({ messages, temperature: Number(agent.temperature) || 0.5, maxTokens: isTask ? 3000 : 2500, fast })
}

// 自定义引擎：独立 OpenAI 兼容端点
async function runCustom(agent, roomHistory, bossMessage, isTask) {
  if (!agent.base_url || !agent.api_key || !agent.model) {
    throw new Error(`Agent ${agent.name} 的 custom 引擎缺少 base_url/api_key/model 配置`)
  }
  const client = new OpenAI({ apiKey: agent.api_key, baseURL: agent.base_url })
  const messages = await buildMessages(agent, roomHistory, bossMessage, isTask)
  const res = await client.chat.completions.create({
    model: agent.model,
    messages,
    temperature: Number(agent.temperature) || 0.5,
    max_tokens: isTask ? 3000 : 2500,
  })
  return res?.choices?.[0]?.message?.content?.trim?.() || ''
}

// 组装 CLI 提示词：当前对话 + 近期会议室上下文，让外部智能体看到全貌
async function buildCliPrompt(roomHistory, bossMessage, isTask) {
  const parts = [(isTask ? '【任务】' : '【对话】') + bossMessage]
  // 注入办公室长期记忆（A2A/CLI 外部 agent 也能看到近期决策 + 语义召回历史）
  const memory = getMemorySnapshot(6)
  if (memory) parts.push('【办公室近期记忆（最近决策/结论）】\n' + memory)
  const relevant = await searchMemory(bossMessage, 4)
  if (relevant) parts.push('【办公室相关历史记忆（语义召回，可参考）】\n' + relevant)
  const recent = (roomHistory || []).slice(-8)
  if (recent.length) {
    const ctx = recent.map(m => {
      if (m.role === 'boss') return `[老板] ${m.content}`
      if (m.role === 'agent') return `[${m.agentName || '同事'} 说] ${m.content}`
      return ''
    }).filter(Boolean).join('\n')
    if (ctx) parts.push('【近期会议室上下文】\n' + ctx)
  }
  return parts.join('\n\n')
}

// cmd.exe 参数转义：双引号写成 ""（cmd 语法）
function escapeShellArg(s) {
  return String(s || '').replace(/"/g, '""')
}

// 从外部 CLI 输出里提取最终回复：
//   claw-code（--output-format json）→ 逐行 NDJSON assistant_text_delta 事件 → 拼接文本
//   Hermes（run_agent.py）→ 🎯 FINAL RESPONSE: ... 👋 Agent execution completed!
//   其它 → 去掉明显的日志/状态行取末段
function extractCliResponse(out) {
  const text = String(out || '')
  // claw-code 等：NDJSON 事件 → assistant_text_delta（流式）或 assistant_turn（非流式）里取 text
  const ndjson = text.split('\n').map(l => l.trim()).filter(l => l.startsWith('{'))
  if (ndjson.length) {
    let joined = ''
    for (const line of ndjson) {
      try {
        const o = JSON.parse(line)
        if (o.type === 'assistant_text_delta' && o.text) joined += o.text
        else if (o.type === 'assistant_turn' && o.text) joined += o.text
      } catch (e) { console.warn('[src/multi-agent/engines.js] op failed:', e?.message || e) }
    }
    if (joined.trim()) return joined.trim().slice(0, 8000)
  }
  // Hermes 风格：FINAL RESPONSE 标记段（直至 👋/💾 收尾或文本结束）
  const m = text.match(/🎯 FINAL RESPONSE:\s*\n[-—]{10,}\s*\n([\s\S]*?)(?=👋|💾|$)/)
  if (m && m[1] && m[1].trim()) return m[1].trim().slice(0, 8000)
  // 通用兜底：去掉日志/状态行
  const lines = text.split('\n').map(l => l.trim()).filter(l => l && !/^(📝|🎯|📋|✅|📞|💬|💾|👋|🎉|🔧|💡|#|Usage|python| {2}python|-{5,})/.test(l))
  return lines.join('\n').slice(-8000).trim()
}

// CLI 引擎：调用外部智能体（Claude Code / Codex / Hermes / claw-code ...）
// 命令模板支持两种占位：
//   {prompt}        —— 内联进命令行（如 claude -p "{prompt}" 或 py run_agent.py --query="{prompt}"）
//   {prompt_stdin}  —— 经 stdin 喂给外部智能体（适合中文/特殊字符多的提示，如 claw-code）
// 用 spawn 手动写 stdin（node 的 execFile input 选项对某些子进程会失效），
// 并支持 agent.cli_cwd 指定子进程工作目录（避免从 BaiLongma 目录误读其 .env）。
async function runCli(agent, roomHistory, bossMessage, isTask) {
  const cmd = String(agent.cli_command || '').trim()
  if (!cmd) throw new Error(`Agent ${agent.name} 的 cli 引擎缺少 cli_command 配置（如 claude -p "..."）`)
  const prompt = await buildCliPrompt(roomHistory, bossMessage, isTask)
  const timeoutMs = Number(agent.cli_timeout) > 0 ? Number(agent.cli_timeout) : 300000
  let fullCmd = cmd
  let useStdin = false
  if (fullCmd.includes('{prompt_stdin}')) {
    fullCmd = fullCmd.replace(/\{prompt_stdin\}/g, '')
    useStdin = true
  } else {
    fullCmd = fullCmd.replace(/\{prompt\}/g, escapeShellArg(prompt))
  }
  const cwd = String(agent.cli_cwd || '').trim() || undefined

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(fullCmd, { shell: true, cwd, windowsHide: true })
    } catch (err) { reject(err); return }
    let stdout = '', stderr = ''
    const timer = setTimeout(() => { try { child.kill() } catch (e) { console.warn('[src/multi-agent/engines.js] op failed:', e?.message || e) } }, timeoutMs)
    child.stdout?.on('data', d => { stdout += Buffer.from(d).toString('utf-8') })
    child.stderr?.on('data', d => { stderr += Buffer.from(d).toString('utf-8') })
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('close', (code) => {
      clearTimeout(timer)
      // 优先从输出里提取最终回复；有回复就认为成功（即使退出码非 0，如超时前已给完整答案）
      const reply = extractCliResponse(stdout)
      if (reply) { resolve(reply); return }
      if (code === 0) { resolve('(该外部智能体未输出)'); return }
      const err = new Error(stderr ? stderr.slice(-400) : `外部智能体退出码 ${code}`)
      err.stdout = stdout; err.stderr = stderr
      reject(err)
    })
    if (useStdin) {
      child.stdin.write(prompt)
      child.stdin.end()
    }
  })
}

// ---------------------------------------------------------------------------
// A2A 引擎：调用独立外部 Agent（Hermes / Claude Code / 任意 A2A v1.0 端点）
// ---------------------------------------------------------------------------
// 每个 Agent 一个 contextId：同一外部 Agent 跨轮共享上下文（多轮记忆），
// 兼容 message/send 的 contextId 字段与 metadata.contextId 两种携带方式。
const a2aContexts = {}   // agentId -> contextId

function extractA2AText(task) {
  const parts = []
  const status = task?.status || {}
  for (const p of (status?.message?.parts || [])) if (p && p.text) parts.push(p.text)
  for (const a of (task?.artifacts || [])) for (const p of (a?.parts || [])) if (p && p.text) parts.push(p.text)
  const seen = new Set()
  return parts
    .map(t => String(t || '').trim())
    .filter(t => { if (!t || seen.has(t)) return false; seen.add(t); return true })
    .join('\n')
    .trim()
}

async function runA2A(agent, roomHistory, bossMessage, isTask) {
  const base = String(agent.a2a_url || agent.base_url || '').trim()
  if (!base) throw new Error(`Agent ${agent.name} 的 a2a 引擎缺少 a2a_url 配置（如 http://127.0.0.1:9920）`)
  // a2a_timeout 单位是秒（与 config 语义一致），这里换算成毫秒
  const timeoutMs = (Number(agent.a2a_timeout) > 0 ? Number(agent.a2a_timeout) : 120) * 1000
  const prompt = await buildCliPrompt(roomHistory, bossMessage, isTask)
  const ctx = a2aContexts[agent.id] || (a2aContexts[agent.id] = 'blm-office-' + agent.id + '-' + Date.now().toString(36))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers = { 'Content-Type': 'application/json' }
    if (agent.a2a_token) headers['Authorization'] = `Bearer ${agent.a2a_token}`   // P2-9：可选鉴权
    const res = await fetch(base.replace(/\/+$/, '') + '/', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0', id: 'blm-' + Date.now().toString(36),
        method: 'message/send',
        params: {
          message: { role: 'user', parts: [{ text: prompt, mediaType: 'text/plain' }], contextId: ctx },
          metadata: { contextId: ctx },   // 兼容部分客户端不传 message.contextId 的读取路径
        },
      }),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`A2A HTTP ${res.status}`)
    const data = await res.json()
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error))
    const result = data.result || {}
    const task = result.task || result
    const reply = extractA2AText(task)
    return reply || '(该外部 Agent 未输出)'
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error(`外部 Agent ${agent.name} 响应超时（${Math.round(timeoutMs / 1000)}s）`, { cause: err })
    throw err
  } finally {
    clearTimeout(timer)
  }
}

// 统一入口：按 Agent 的 engine 路由；a2a/cli/custom 失败时回退 internal，保证一定有响应
export async function runAgentEngine(agentId, roomHistory, bossMessage, isTask = false) {
  const agent = getAgentConfig(agentId)
  if (!agent) throw new Error(`未知 Agent: ${agentId}`)
  const engine = String(agent.engine || 'internal').trim().toLowerCase()
  if (engine === 'a2a') {
    try { return await runA2A(agent, roomHistory, bossMessage, isTask) }
    catch (err) { console.warn(`[agent:${agent.name}] a2a 失败，回退 internal:`, err.message); return runInternal(agent, roomHistory, bossMessage, isTask) }
  }
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
