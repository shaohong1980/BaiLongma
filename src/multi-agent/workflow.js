// workflow.js —— P2-7 可编程编排：JSON 定义的多步流程运行器
// 步骤形态：
//   { stage, agent: 'id', prompt }                单 Agent 执行
//   { stage, parallel: ['id','id'], prompt }      并行多 Agent 执行后合并
//   { stage, summary: 'id', prompt }              汇总/裁决
//   { stage, loop: { max, agent, prompt, reviewAgent, reviewPrompt } }
//                                                  评审-返工循环（②）：执行→评审→不通过重做，最多 max 次
// 单步错误恢复（②）：可加 retries（同 agent 重试次数）+ fallback（失败后换执行人）
// prompt 支持占位：{content}=原始内容，{prev}=上一步结果（merged/reply）
import { runAgentEngine } from './engines.js'
import { getRoomHistory } from './room.js'
import { getAgentConfig } from './config.js'
import { remember } from './memory.js'
import { StateGraph } from './state-graph.js'
import { paths } from '../paths.js'
import path from 'path'

function fill(tpl, content, prev) {
  return String(tpl || '')
    .replace(/\{content\}/g, String(content || ''))
    .replace(/\{prev\}/g, String(prev || ''))
}

const isVoidReply = (txt) => !String(txt || '').trim() || /响应失败|执行失败|（执行失败|（失败/.test(String(txt))

// 单 agent 执行（带 retries + fallback 错误恢复）
async function runSingle(id, prompt, ctx, step) {
  // 默认至少重试一次：空回复/失败标记很常见（对齐 task-flow 的 call()），
  // 只在失败时才消耗重试，成功不额外调用
  const retries = Math.max(1, Number(step.retries) || 1)
  const agents = [id]
  if (step.fallback && getAgentConfig(step.fallback)) agents.push(step.fallback)
  let lastReply = ''
  let lastError = ''
  for (const aid of agents) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const reply = await runAgentEngine(aid, ctx, prompt, true)
        lastReply = String(reply || '')
        if (!isVoidReply(lastReply)) {
          return { ok: true, agent: aid, name: getAgentConfig(aid)?.name || aid, reply: lastReply, merged: lastReply }
        }
        lastError = '空回复或失败标记'
      } catch (err) {
        lastError = err.message
        lastReply = ''
      }
    }
  }
  return { ok: false, agent: agents[0], name: getAgentConfig(agents[0])?.name || agents[0], reply: lastReply || lastError, merged: lastReply || lastError, error: lastError }
}

// 评审-返工循环：执行 agent → reviewAgent 评判 → 不通过则带评审意见重做，最多 max 次
async function runLoopStep(step, content, ctx) {
  const lp = step.loop || {}
  const max = Math.max(1, Number(lp.max) || 3)
  const execId = lp.agent
  const reviewId = lp.reviewAgent || 'gm'
  const execPrompt = fill(lp.prompt, content, '')
  const reviewPrompt = lp.reviewPrompt || '请评审以下交付是否合格，用"通过"或"驳回"开头并说明理由（要具体、可执行）：\n\n交付内容：\n{prev}'
  let last = ''
  let lastVerdict = ''
  for (let attempt = 1; attempt <= max; attempt++) {
    // 返工时带上评审意见，让执行人针对性修改
    const prompt = attempt === 1 ? execPrompt : `${execPrompt}\n\n【评审驳回意见，请针对修改】\n${lastVerdict}`
    const reply = await runAgentEngine(execId, ctx, prompt, true)
    last = String(reply || '')
    lastVerdict = await runAgentEngine(reviewId, ctx, fill(reviewPrompt, content, last), true)
    if (/^(通过|合格|approve|ok|可以)/i.test(String(lastVerdict).trim())) {
      return { ok: true, agent: execId, name: getAgentConfig(execId)?.name || execId, reply: last, merged: last, attempts: attempt, verdict: String(lastVerdict).slice(0, 300) }
    }
    // 最后一轮仍被驳回 → 交付最后版本并附评审意见，不无限循环
  }
  return { ok: true, agent: execId, name: getAgentConfig(execId)?.name || execId, reply: last, merged: last, attempts: max, forced: true, verdict: String(lastVerdict).slice(0, 300) }
}

// 运行一个流程：flow = { name, steps: [...] }
export async function runFlow(flow, content) {
  const steps = Array.isArray(flow) ? flow : (flow?.steps || [])
  const ctx = getRoomHistory(40)
  const results = []
  let prev = ''
  for (const step of steps) {
    const stage = step.stage || step.name || '步骤'
    const prompt = fill(step.prompt, content, prev)
    const rec = { stage, ts: new Date().toISOString(), ms: 0 }
    const t0 = Date.now()
    try {
      if (step.loop && step.loop.agent) {
        // ② 评审-返工循环
        const lr = await runLoopStep(step, content, ctx)
        Object.assign(rec, lr)
        prev = lr.merged || prev
      } else if (Array.isArray(step.parallel) && step.parallel.length) {
        const agents = step.parallel.filter(id => getAgentConfig(id))
        const replies = await Promise.allSettled(agents.map(id =>
          runAgentEngine(id, ctx, prompt, true).catch(e => `（失败：${e.message}）`)))
        rec.parallel = agents.map((id, i) => ({
          agent: id, name: getAgentConfig(id)?.name || id,
          reply: replies[i].status === 'fulfilled' ? String(replies[i].value || '') : String(replies[i].reason || ''),
        }))
        rec.merged = rec.parallel.map(r => `【${r.name}】${r.reply}`).join('\n\n')
        prev = rec.merged
      } else if (step.summary) {
        const id = step.summary
        const sr = await runSingle(id, prompt, ctx, step)
        Object.assign(rec, sr)
        prev = sr.merged || prev
      } else if (step.agent) {
        const id = step.agent
        const sr = await runSingle(id, prompt, ctx, step)
        Object.assign(rec, sr)
        prev = sr.merged || prev
      } else {
        rec.error = 'step 需提供 agent / parallel / summary / loop 之一'
      }
      if (rec.ok === undefined) rec.ok = true
    } catch (err) {
      rec.ok = false
      rec.error = err.message
    }
    rec.ms = Date.now() - t0
    results.push(rec)
  }
  // 结论沉淀到长期记忆
  const last = results[results.length - 1]
  if (last && last.merged && !/失败/.test(last.merged)) {
    await remember({ type: 'result', agent: flow?.name || '流程', content: `${String(content || '').slice(0, 80)} → ${String(last.merged).slice(0, 300)}` })
  }
  return { ok: true, flow_name: flow?.name || 'custom', results }
}

// ── 状态图流程（学 LangGraph）──────────────────────────────────────────
// 把现有线性 steps（含 parallel/loop/summary/retries/fallback）编译成状态图，
// 旧配置零改动即可获得：checkpoint 断点续跑、approval 人工审批、audit 回放。
const GRAPH_CP_DIR = () => path.join(paths.dataDir, 'graph-checkpoints')
const graphRuns = new Map()   // threadId -> compiled app（供 resume）

// 单步执行器：按步骤形态运行，返回该步结果对象（与 runFlow 的 rec 同构）
async function runStepAsNode(step, i, state, ctx) {
  const rec = { stage: step.stage || step.name || ('步骤' + (i + 1)), ts: new Date().toISOString() }
  const prompt = fill(step.prompt, state.content, state.prev)
  try {
    if (step.loop && step.loop.agent) {
      const lr = await runLoopStep(step, state.content, ctx)
      Object.assign(rec, lr)
    } else if (Array.isArray(step.parallel) && step.parallel.length) {
      const agents = step.parallel.filter(id => getAgentConfig(id))
      const replies = await Promise.allSettled(agents.map(id =>
        runAgentEngine(id, ctx, prompt, true).catch(e => `（失败：${e.message}）`)))
      rec.parallel = agents.map((id, j) => ({
        agent: id, name: getAgentConfig(id)?.name || id,
        reply: replies[j].status === 'fulfilled' ? String(replies[j].value || '') : String(replies[j].reason || ''),
      }))
      rec.merged = rec.parallel.map(r => `【${r.name}】${r.reply}`).join('\n\n')
    } else {
      const id = step.agent || step.summary
      if (!id) { rec.ok = false; rec.error = 'step 需提供 agent / parallel / summary / loop 之一'; return rec }
      const sr = await runSingle(id, prompt, ctx, step)
      Object.assign(rec, sr)
    }
    if (rec.ok === undefined) rec.ok = true
  } catch (err) {
    rec.ok = false
    rec.error = err.message
  }
  return rec
}

// 把线性 steps 编译为状态图（线性链；approvals 指定的 stage 成为人工审批点）
export function compileFlowToGraph(flow, content, opts = {}) {
  const steps = Array.isArray(flow) ? flow : (flow?.steps || [])
  const ctx = getRoomHistory(40)
  const g = new StateGraph({ checkpointDir: opts.checkpointDir || GRAPH_CP_DIR() })
  steps.forEach((step, i) => {
    const name = 'step_' + i
    const approval = Array.isArray(opts.approvals) && opts.approvals.includes(step.stage || step.name)
    g.addNode(name, async (state) => {
      const t0 = Date.now()
      const rec = await runStepAsNode(step, i, state, ctx)
      rec.ms = Date.now() - t0
      const upd = { ['r' + i]: rec }
      if (rec.merged) upd.prev = rec.merged
      return upd
    }, { approval })
    if (i === 0) g.setEntry(name)
    else g.addEdge('step_' + (i - 1), name)
  })
  return g
}

// 运行状态图流程；支持 checkpoint/审批/回放。返回 { threadId, results, audit, interrupted, waitingNode }
export async function runGraphFlow(flow, content, opts = {}) {
  const steps = Array.isArray(flow) ? flow : (flow?.steps || [])
  if (opts.approvals === undefined && flow?.approvals) opts = { ...opts, approvals: flow.approvals }
  const g = compileFlowToGraph(flow, content, opts)
  const app = g.compile()
  const threadId = opts.threadId || ('flow-' + Date.now().toString(36))
  graphRuns.set(threadId, { app, flow })
  const initial = { content: String(content || ''), prev: '' }
  const r = await app.invoke(initial, { threadId, onStep: opts.onStep })
  const results = steps.map((_, i) => (r.state || {})['r' + i] || { stage: '步骤' + (i + 1) })
  const last = results[results.length - 1]
  if (!r.interrupted && last && last.merged && !/失败/.test(last.merged)) {
    await remember({ type: 'result', agent: flow?.name || '流程', content: `${String(content || '').slice(0, 80)} → ${String(last.merged).slice(0, 300)}` })
  }
  return {
    ok: !r.interrupted, graph: true, flow_name: flow?.name || 'custom',
    threadId, results, audit: r.audit || [],
    interrupted: !!r.interrupted, waitingNode: r.waitingNode || null, state: r.state || {},
  }
}

// 人工审批/断点续跑：同意则继续，驳回则停在原地
export async function resumeGraphFlow(threadId, { approved = true, note = '' } = {}) {
  const entry = graphRuns.get(threadId)
  if (!entry) throw new Error(`未知流程线程: ${threadId}（请先 runGraphFlow）`)
  const r = await entry.app.resume(threadId, { approved, note })
  return { ok: true, threadId, resumed: !!r.resumed, rejected: !!r.rejected, state: r.state || {}, audit: r.audit || [], note }
}

// 预设流程
export const WORKFLOWS = {
  consult: {
    name: '会议桌评审',
    steps: [
      { stage: '提案拆解', agent: 'gm', prompt: '请作为 CEO 拆解这个议题并给出评审要点：{content}' },
      { stage: '外部评审', parallel: ['claudecode', 'hermesagent'], prompt: '请从你的专业角度独立评审该议题，给出意见与风险点：{content}' },
      { stage: '汇总裁决', summary: 'gm', prompt: '综合以下外部评审意见，给出最终裁决、责任人分工与下一步计划。\n\n外部评审意见：\n{prev}' },
    ],
  },
  implement: {
    name: '立项实施',
    steps: [
      { stage: '拆解', agent: 'gm', prompt: '拆解任务并确定执行人（尽量从 claudecode/hubu/host/libu 中选）：{content}' },
      { stage: '执行', parallel: ['claudecode', 'libu'], prompt: '按职责产出可交付成果：{content}', retries: 1, fallback: 'host' },
      { stage: '验收汇报', summary: 'gm', prompt: '验收以下交付成果，汇总向用户汇报：\n\n交付成果：\n{prev}' },
    ],
  },
  reviewfix: {
    name: '评审返工闭环',
    steps: [
      { stage: '执行', loop: { max: 3, agent: 'claudecode', reviewAgent: 'gm',
          prompt: '请产出完整可交付成果（代码/文档/方案）：{content}',
          reviewPrompt: '请评审以下交付是否合格，用"通过"或"驳回"开头并给出具体修改意见（这是关键，要让执行人能针对性返工）：\n\n交付内容：\n{prev}' } },
      { stage: '汇总结案', summary: 'gm', prompt: '汇总结案：交付是否通过、最终产出、遗留问题。\n\n最终交付：\n{prev}' },
    ],
  },
  // 状态图版本（学 LangGraph）：并行 + 评审返工循环 + 人工审批 + checkpoint 断点续跑
  production: {
    graph: true,
    name: '企业生产流程（状态图）',
    approvals: ['人工审批'],   // 该阶段执行前暂停，等人工审批（可断点续跑）
    steps: [
      { stage: '任务拆解', agent: 'gm', prompt: '拆解该任务，给出执行要点与验收标准（300字内）：{content}' },
      { stage: '并行执行', parallel: ['claudecode', 'hermesagent'], prompt: '分别从技术/管理视角产出方案，控制在400字内：{content}\n\n背景：{prev}' },
      { stage: '评审返工', loop: { max: 2, agent: 'claudecode', reviewAgent: 'gm',
          prompt: '基于评审意见产出终稿，控制在500字内：{content}\n\n现有方案：{prev}',
          reviewPrompt: '评审该交付是否合格，用"通过"或"驳回"开头并给出具体可执行的修改意见：\n\n交付内容：\n{prev}' } },
      { stage: '人工审批', summary: 'gm', prompt: '汇总最终交付与审计要点，供人工审批确认：{content}\n\n交付：{prev}' },
      { stage: '汇总结案', summary: 'gm', prompt: '汇总结案：最终交付、待确认事项。\n\n交付：{prev}' },
    ],
  },
}
