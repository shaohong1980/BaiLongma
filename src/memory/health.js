// health.js —— 记忆健康度报告
//
// 给整合循环（consolidation-loop）提供记忆质量视角：总量 / 低价值占比 / 冗余率 / 类型分布，
// 输出可观测报告。对齐主流记忆系统（Mem0/Letta）的"记忆质量指标"，供调优注入/整理策略。
import { getDB } from '../db.js'

export function getMemoryHealth() {
  const db = getDB()
  try {
    const total = db.prepare(`SELECT COUNT(*) AS c FROM memories WHERE visibility = 1`).get().c || 0
    const lowSalience = db.prepare(`SELECT COUNT(*) AS c FROM memories WHERE visibility = 1 AND COALESCE(salience, 3) <= 2`).get().c || 0
    const byType = db.prepare(`
      SELECT event_type, COUNT(*) AS c FROM memories WHERE visibility = 1
      GROUP BY event_type ORDER BY c DESC
    `).all()
    // 冗余近似：content 前 40 字重复的条数（超出第一条的即为可合并冗余）
    const dupRows = db.prepare(`
      SELECT substr(content, 1, 40) AS p, COUNT(*) AS c FROM memories
      WHERE visibility = 1 GROUP BY p HAVING c > 1
    `).all()
    const redundant = dupRows.reduce((sum, r) => sum + (r.c - 1), 0)
    return {
      total,
      lowSalience,
      lowSalienceRatio: total ? Math.round((lowSalience / total) * 1000) / 10 : 0,
      redundant,
      redundantRatio: total ? Math.round((redundant / total) * 1000) / 10 : 0,
      byType,
      checkedAt: new Date().toISOString(),
    }
  } catch {
    return null
  }
}

export function formatMemoryHealth(health) {
  if (!health) return '（记忆健康度统计不可用）'
  const lines = [
    `记忆总数: ${health.total}`,
    `低价值(salience≤2): ${health.lowSalienceRatio}%`,
    `冗余(同前缀>1): ${health.redundantRatio}%`,
  ]
  if (Array.isArray(health.byType) && health.byType.length) {
    const top = health.byType.slice(0, 5).map(r => `${r.event_type}:${r.c}`).join(' ')
    lines.push(`分布: ${top}`)
  }
  return lines.join(' | ')
}
