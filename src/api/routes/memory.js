import {
  getDB,
  getRecentExtractAudits,
  getRecentRecallAudits,
  getExtractAuditStats,
  getRecallAuditStats,
} from '../../db.js'
import { isRunning } from '../../control.js'
import { getQuotaStatus } from '../../quota.js'
import { getSelfEvolutionSnapshot } from '../../memory/self-evolution.js'
import { jsonResponse, safeJsonParse, readJsonBody } from '../utils.js'
import { exportVault, getVaultStatus, openVault } from '../../memory/vault.js'
import { createGoal, updateGoal, listGoals } from '../../memory/goals.js'
import { getBriefing, getLatestBriefing, generateBriefing } from '../../runtime/briefing.js'
import { getUsageSummary, getToolUsageSummary, formatUsageReport } from '../../runtime/insights.js'
import { loadSkills, getSkillById, refreshSkills } from '../../skills/registry.js'
import { listSkillUsage, getSkillUsage, removeSkillUsage } from '../../memory/skill-usage.js'
import { listMcpServers, upsertMcpServer, removeMcpServer } from '../../mcp/servers-config.js'

function stripAssistantHistoryLabels(content) {
  return String(content || '')
    .trim()
    .replace(/^(?:\s*\[assistant(?:\s+to\s+[^\]\r\n]+)?(?:\s+\d{4}-\d{2}-\d{2}T[^\]\r\n]+)?\]\s*)+/giu, '')
    .trim()
}

async function handleMemories(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/memories') {
    const db = getDB()
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 500)
    const search = url.searchParams.get('search')
    let rows
    if (search) {
      try {
        rows = db.prepare(`
          SELECT m.* FROM memories m
          JOIN memories_fts ON memories_fts.rowid = m.id
          WHERE memories_fts MATCH ? AND m.visibility = 1
          ORDER BY bm25(memories_fts), m.created_at DESC LIMIT ?
        `).all(search, limit)
      } catch {
        rows = db.prepare(`
          SELECT * FROM memories
          WHERE (
            title LIKE ? OR mem_id LIKE ? OR content LIKE ? OR detail LIKE ?
            OR entities LIKE ? OR concepts LIKE ? OR tags LIKE ?
          )
          AND visibility = 1
          ORDER BY created_at DESC LIMIT ?
        `).all(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, limit)
      }
    } else {
      rows = db.prepare('SELECT * FROM memories WHERE visibility = 1 ORDER BY created_at DESC LIMIT ?').all(limit)
    }
    jsonResponse(res, 200, rows)
    return true
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/memories/')) {
    const id = parseInt(url.pathname.split('/')[2])
    if (!id) {
      jsonResponse(res, 400, { error: 'invalid id' })
      return true
    }
    getDB().prepare('DELETE FROM memories WHERE id = ?').run(id)
    jsonResponse(res, 200, { ok: true })
    return true
  }

  if (req.method === 'PATCH' && url.pathname.startsWith('/memories/')) {
    const id = parseInt(url.pathname.split('/')[2])
    if (!id) {
      jsonResponse(res, 400, { error: 'invalid id' })
      return true
    }
    try {
      const { content, detail } = await readJsonBody(req)
      const db = getDB()
      if (content !== undefined) db.prepare('UPDATE memories SET content = ? WHERE id = ?').run(content, id)
      if (detail !== undefined) db.prepare('UPDATE memories SET detail = ? WHERE id = ?').run(detail, id)
      jsonResponse(res, 200, { ok: true })
    } catch (e) {
      jsonResponse(res, 400, { error: e.message })
    }
    return true
  }

  return false
}

export async function handleMemoryRoutes(req, res, url) {
  if (await handleMemories(req, res, url)) return true

  if (req.method === 'GET' && url.pathname === '/audit/recall') {
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 500)
    const rows = getRecentRecallAudits(limit).map(r => ({
      ...r,
      matched_mem_ids: safeJsonParse(r.matched_mem_ids, []),
      event_type_dist: safeJsonParse(r.event_type_dist, {}),
    }))
    jsonResponse(res, 200, rows)
    return true
  }

  if (req.method === 'GET' && url.pathname === '/audit/extract') {
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 500)
    const rows = getRecentExtractAudits(limit).map(r => ({
      ...r,
      extracted_mem_ids: safeJsonParse(r.extracted_mem_ids, []),
      event_type_dist: safeJsonParse(r.event_type_dist, {}),
      skipped: !!r.skipped,
    }))
    jsonResponse(res, 200, rows)
    return true
  }

  if (req.method === 'GET' && url.pathname === '/audit/stats') {
    const hours = Math.max(1, Math.min(parseInt(url.searchParams.get('hours') || '168'), 24 * 30))
    const sinceIso = new Date(Date.now() - hours * 3600_000).toISOString().replace('T', ' ').slice(0, 19)
    jsonResponse(res, 200, {
      windowHours: hours,
      sinceIso,
      recall: getRecallAuditStats({ sinceIso }) || {},
      extract: getExtractAuditStats({ sinceIso }) || {},
    })
    return true
  }

  if (req.method === 'GET' && url.pathname === '/conversations') {
    const db = getDB()
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '60'), 500)
    const includeSystemSignals = url.searchParams.get('includeSystemSignals') === 'true'
    const rows = db.prepare(`
      SELECT id, role, from_id, to_id, content, timestamp, channel, external_party_id, focus_absorbed, focus_topic, open_question
      FROM conversations
      WHERE (? OR NOT (from_id = 'SYSTEM' AND channel = 'APP_SIGNAL'))
      ORDER BY id DESC
      LIMIT ?
    `).all(includeSystemSignals ? 1 : 0, limit)
    jsonResponse(res, 200, rows.reverse().map(row => (
      row.role === 'jarvis'
        ? { ...row, content: stripAssistantHistoryLabels(row.content) }
        : row
    )))
    return true
  }

  if (req.method === 'GET' && url.pathname === '/status') {
    const { n } = getDB().prepare('SELECT COUNT(*) as n FROM memories').get()
    jsonResponse(res, 200, {
      ok: true,
      memory_count: n,
      running: isRunning(),
      self_evolution: getSelfEvolutionSnapshot({ maxRecent: 5 }),
    })
    return true
  }

  if (req.method === 'GET' && (url.pathname === '/self-evolution' || url.pathname === '/memory/self-evolution')) {
    const limit = Math.max(1, Math.min(parseInt(url.searchParams.get('limit') || '20'), 24))
    jsonResponse(res, 200, { ok: true, ...getSelfEvolutionSnapshot({ maxRecent: limit }) })
    return true
  }

  if (req.method === 'GET' && url.pathname === '/quota') {
    jsonResponse(res, 200, getQuotaStatus())
    return true
  }

  // ── Obsidian 记忆 vault ──
  if (req.method === 'GET' && url.pathname === '/memories/vault') {
    jsonResponse(res, 200, getVaultStatus())
    return true
  }
  if (req.method === 'POST' && url.pathname === '/memories/vault/export') {
    jsonResponse(res, 200, exportVault())
    return true
  }
  if (req.method === 'POST' && url.pathname === '/memories/vault/open') {
    jsonResponse(res, 200, await openVault())
    return true
  }

  // ── 长期目标（Goals）──
  if (req.method === 'GET' && url.pathname === '/goals') {
    const status = url.searchParams.get('status')
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200)
    jsonResponse(res, 200, { ok: true, goals: listGoals({ status: status || null, limit }) })
    return true
  }
  if (req.method === 'POST' && url.pathname === '/goals') {
    const body = await readJsonBody(req)
    jsonResponse(res, 200, createGoal(body))
    return true
  }
  if (req.method === 'PATCH' && url.pathname.startsWith('/goals/')) {
    const id = Number(url.pathname.split('/')[2])
    const body = await readJsonBody(req)
    jsonResponse(res, 200, updateGoal(id, body))
    return true
  }

  // ── 晨间简报 ──
  if (req.method === 'GET' && url.pathname === '/briefing') {
    jsonResponse(res, 200, { ok: true, briefing: getLatestBriefing(), today: getBriefing() })
    return true
  }
  if (req.method === 'POST' && url.pathname === '/briefing/generate') {
    const body = await readJsonBody(req)
    jsonResponse(res, 200, await generateBriefing({ force: body?.force === true }))
    return true
  }

  // ── 技能（Agent Skills）：列表 / 用量遥测 ──
  if (req.method === 'GET' && url.pathname === '/skills') {
    const skills = loadSkills({ force: true })
    const usage = new Map(listSkillUsage().map(u => [u.id, u]))
    jsonResponse(res, 200, {
      ok: true,
      skills: skills.map(s => ({
        id: s.id,
        name: s.name,
        description: s.description,
        source: s.source,
        relativeDir: s.relativeDir,
        usage: usage.get(s.id) || { use_count: 0, state: 'active' },
      })),
    })
    return true
  }
  if (req.method === 'GET' && url.pathname.startsWith('/skills/')) {
    const id = decodeURIComponent(url.pathname.split('/')[2] || '')
    const usage = getSkillUsage(id)
    const skill = getSkillById(id)
    jsonResponse(res, 200, {
      ok: true,
      id,
      usage,
      skill: skill ? { id: skill.id, name: skill.name, description: skill.description, source: skill.source, dir: skill.dir, raw: skill.raw } : null,
    })
    return true
  }
  if (req.method === 'DELETE' && url.pathname.startsWith('/skills/')) {
    const id = decodeURIComponent(url.pathname.split('/')[2] || '')
    const skill = getSkillById(id)
    if (!skill) { jsonResponse(res, 404, { ok: false, error: `找不到技能「${id}」` }); return true }
    if (skill.source === 'bundled') { jsonResponse(res, 400, { ok: false, error: '内置打包技能不能删除' }); return true }
    try {
      const fs = await import('fs')
      fs.rmSync(skill.dir, { recursive: true, force: true })
      removeSkillUsage(skill.id)
      refreshSkills()
      jsonResponse(res, 200, { ok: true, deleted: skill.id })
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: String(err?.message || err) })
    }
    return true
  }

  // ── 用量洞察（Insights）──
  if (req.method === 'GET' && url.pathname === '/insights') {
    const days = Math.min(parseInt(url.searchParams.get('days') || '1'), 365)
    jsonResponse(res, 200, {
      ok: true,
      days,
      summary: getUsageSummary({ days }),
      tools: getToolUsageSummary({ days }),
      report: formatUsageReport({ days }),
    })
    return true
  }

  // ── MCP 服务器配置 ──
  if (req.method === 'GET' && url.pathname === '/mcp/servers') {
    jsonResponse(res, 200, { ok: true, servers: listMcpServers() })
    return true
  }
  if (req.method === 'POST' && url.pathname === '/mcp/servers') {
    const body = await readJsonBody(req)
    const { name, ...entry } = body
    jsonResponse(res, 200, upsertMcpServer(String(name || '').trim(), entry))
    return true
  }
  if (req.method === 'DELETE' && url.pathname.startsWith('/mcp/servers/')) {
    const name = decodeURIComponent(url.pathname.split('/')[3] || '')
    jsonResponse(res, 200, removeMcpServer(name))
    return true
  }

  return false
}
