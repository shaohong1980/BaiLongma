// 多 Agent 会议室 —— 引擎路由：每个 Agent 可用不同的大模型/引擎
//   internal : 爻台主模型 + 该 Agent 人格（默认，零配置）
//   custom   : 自选 OpenAI 兼容端点（base_url/api_key/model）
//   cli      : 调用外部 CLI 智能体（Claude Code / Codex / Hermes 等，需本机安装并配置命令）
import OpenAI from 'openai'
import { spawn } from 'child_process'
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

// 内部引擎：爻台主模型 + 人格（输出放宽，避免长回复被截断）
async function runInternal(agent, roomHistory, bossMessage, isTask) {
  const messages = buildMessages(agent, roomHistory, bossMessage, isTask)
  // P2-2：子角色可选 fast 模型（flash）——低风险角色（如摘要/记录）配置 fast:true 省成本；
  // 默认 false 保持主模型质量（CEO/军机处等核心角色不应降级）
  const fast = agent.fast === true
  return runSimpleCompletion({ messages, temperature: Number(agent.temperature) || 0.5, maxTokens: isTask ? 3000 : 2500, fast })
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
    max_tokens: isTask ? 3000 : 2500,
  })
  return res?.choices?.[0]?.message?.content?.trim?.() || ''
}

// 组装 CLI 提示词：当前对话 + 近期会议室上下文，让外部智能体看到全貌
function buildCliPrompt(roomHistory, bossMessage, isTask) {
  const parts = [(isTask ? '【任务】' : '【对话】') + bossMessage]
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
      } catch {}
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
  const prompt = buildCliPrompt(roomHistory, bossMessage, isTask)
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
    const timer = setTimeout(() => { try { child.kill() } catch {} }, timeoutMs)
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
