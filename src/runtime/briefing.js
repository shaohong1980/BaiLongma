// briefing.js —— 晨间简报
//
// 每天早上（当天首次触发）用 LLM 生成一份简报：近期记忆亮点、活跃目标进展、
// 未来 24h 提醒。存 briefing 表（按日期 upsert），Brain UI 拉取展示。
// 生成时机由 consolidation-loop 每天首次 tick 触发（maybeGenerateBriefing）。

import { callLLM } from '../llm.js'
import { getDB, getConfig, setConfig } from '../db.js'
import { listActiveGoals } from '../memory/goals.js'
import { formatUsageReport } from './insights.js'

const BRIEFING_SYSTEM = `你是一个干练的晨间助手。基于提供的「近期记忆 / 活跃目标 / 待办提醒」，写一份简短的晨间简报。

要求：
- 中文，200~350 字，用 Markdown（## 小节）。
- 结构：## 昨晚回顾（近期记忆里值得一提的事）→ ## 目标进展（每个活跃目标一句话进度）→ ## 今日提醒（未来 24h 的到期事项）→ ## 建议（1~2 条今天的可执行建议）。
- 信息不足就少写，不要编造。没有内容的小节可以省略。
- 语气像熟悉你的助手，不要用"您好"，直接说事。`

function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

export function getBriefing({ date = null } = {}) {
  const db = getDB()
  const d = date || todayStr()
  return db.prepare('SELECT * FROM briefing WHERE date = ?').get(d) || null
}

export function getLatestBriefing() {
  return getDB().prepare('SELECT * FROM briefing ORDER BY date DESC LIMIT 1').get() || null
}

export function shouldGenerateBriefing() {
  return !getBriefing()
}

async function buildContext() {
  const db = getDB()
  // 精简上下文：只取标题 + 内容前 36 字，最多 10 条（避免超本地小上下文模型的 context）
  const memories = db.prepare(`
    SELECT title, content, timestamp FROM memories
    WHERE visibility = 1 AND timestamp >= datetime('now', '-3 days')
    ORDER BY timestamp DESC LIMIT 10
  `).all()
  const goals = listActiveGoals().map(g => `${g.title}（进度 ${g.progress || 0}%）`)
  const reminders = db.prepare(`
    SELECT task, due_at FROM reminders
    WHERE status = 'pending' AND due_at <= datetime('now', '+24 hours')
    ORDER BY due_at LIMIT 5
  `).all()
  const parts = []
  parts.push('【近期记忆】\n' + (memories.map(m => `- ${((m.title || '') + '：' + (m.content || '')).trim().slice(0, 36)}（${(m.timestamp || '').slice(0, 10)}）`).join('\n') || '（暂无）'))
  parts.push('【活跃目标】\n' + (goals.join('\n') || '（暂无）'))
  parts.push('【今日提醒】\n' + (reminders.map(r => `- ${(r.task || '').slice(0, 40)}（${(r.due_at || '').slice(0, 16)}）`).join('\n') || '（暂无）'))
  // 用量洞察：把昨天（或最近 1 天）的 token/成本/常用工具并进简报上下文
  try {
    const usageText = formatUsageReport({ days: 1 })
    if (usageText && !usageText.includes('暂无用量记录')) parts.push(usageText)
  } catch { /* 用量数据不影响简报生成 */ }
  return parts.join('\n\n')
}

// 生成今天的简报并落库（幂等：已有则跳过）。force 可覆盖重新生成。
export async function generateBriefing({ force = false } = {}) {
  const existing = getBriefing()
  if (existing && !force) return { ok: true, date: existing.date, cached: true, content: existing.content }
  try {
    const context = await buildContext()
    const r = await callLLM({
      systemPrompt: BRIEFING_SYSTEM,
      message: context,
      temperature: 0.6,
      thinking: true,
      maxTokens: 1200,
      mustReply: true,
      localReply: true, // 后台任务：直接输出纯文本，不要包 send_message
    })
    const content = String(r?.content || '').trim()
    if (!content) return { ok: false, error: '简报生成为空' }
    const db = getDB()
    const date = todayStr()
    db.prepare(`
      INSERT INTO briefing (date, content) VALUES (?, ?)
      ON CONFLICT(date) DO UPDATE SET content = excluded.content, created_at = datetime('now')
    `).run(date, content)
    console.log(`[简报] 已生成 ${date}（${content.length} 字）`)
    return { ok: true, date, content }
  } catch (err) {
    console.error('[简报] 生成失败:', err?.message || err)
    return { ok: false, error: String(err?.message || err) }
  }
}

// 供循环调用的节流入口：同一天只尝试一次（成功生成或失败都标记，避免 key 失效时每轮重试）
export async function maybeGenerateBriefing() {
  const today = todayStr()
  if (getBriefing()) return { ok: true, skipped: true, cached: true }
  if (getConfig('briefing_last_attempt_date') === today) return { ok: true, skipped: true }
  try { setConfig('briefing_last_attempt_date', today) } catch (e) { /* 忽略 */ }
  return generateBriefing()
}

