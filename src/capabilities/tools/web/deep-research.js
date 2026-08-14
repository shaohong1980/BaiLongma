// deep_research —— 深度研究代理
// 把"帮我调研 X"升级成：拆子问题 → 多路搜索 → 抓原文 → 交叉验证 → 出证据报告。
// 主 Agent 用返回的证据来写最终结论；本工具负责把调研的"体力活"做完。
import fs from 'fs'
import path from 'path'
import { throwIfAborted } from '../../abort-utils.js'
import { execWebSearch } from './search.js'
import { execFetchUrl } from './fetch.js'
import { emitEvent } from '../../../events.js'
import { paths } from '../../../paths.js'

function toolJson(obj) { return JSON.stringify(obj, null, 2) }

// 把用户问题拆成几个搜索角度（启发式，不依赖 LLM）
function decomposeQuery(query) {
  const q = String(query || '').trim()
  if (!q) return []
  const angles = [
    q,
    `${q} 是什么`,
    `${q} 最新`,
    `${q} 对比 优缺点`,
  ]
  return [...new Set(angles)].filter(Boolean).slice(0, 5)
}

function progress(stage, msg) {
  try { emitEvent('action', { tool: 'deep_research', summary: `${stage}：${msg}` }) } catch {}
  console.log(`[deep_research] ${stage}: ${msg}`)
}

function safeJsonParse(text) {
  try { return JSON.parse(text) } catch { return null }
}

export async function execDeepResearch(args = {}, context = {}) {
  throwIfAborted(context.signal)
  const query = String(args.query || args.topic || '').trim()
  if (!query) return toolJson({ ok: false, tool: 'deep_research', error: 'query 必填，例如：帮我调研XX' })

  const sourcesPerAngle = Math.min(Math.max(Number(args.sources_per_angle) || 3, 1), 6)
  const maxContent = Math.min(Math.max(Number(args.max_content) || 1200, 300), 3000)

  progress('拆解', `将「${query}」拆成多个搜索角度`)
  const angles = decomposeQuery(query)

  const evidence = []
  for (const angle of angles) {
    throwIfAborted(context.signal)
    progress('搜索', angle)
    let results = []
    try {
      const r = safeJsonParse(await execWebSearch({ query: angle, limit: sourcesPerAngle }, context))
      results = (r?.results || []).slice(0, sourcesPerAngle)
    } catch (err) { progress('跳过', `搜索失败：${err.message}`) }

    for (const res of results) {
      throwIfAborted(context.signal)
      const url = String(res.url || '')
      if (!url) continue
      let content = ''
      let fetchErr = ''
      try {
        const f = safeJsonParse(await execFetchUrl({ url }, context))
        content = f?.content ? String(f.content).replace(/\s+/g, ' ').trim().slice(0, maxContent) : ''
        if (!content && f?.error) fetchErr = f.error
      } catch (err) { fetchErr = err.message || String(err) }
      evidence.push({
        angle,
        title: String(res.title || '').slice(0, 200),
        url,
        snippet: String(res.snippet || '').slice(0, 300),
        content,
        fetch_error: fetchErr || null,
      })
      progress('抓取', `读取 ${url}`)
    }
  }

  // 落盘完整证据
  const dir = path.join(paths.sandboxDir, 'research')
  fs.mkdirSync(dir, { recursive: true })
  const safeName = String(query).replace(/[^\w\u4e00-\u9fa5-]/g, '_').slice(0, 40)
  const reportPath = path.join(dir, `${safeName}-${Date.now()}.json`)
  fs.writeFileSync(reportPath, JSON.stringify({ query, angles, evidence, generated_at: new Date().toISOString() }, null, 2), 'utf-8')

  // 按角度分组汇总
  const byAngle = {}
  for (const e of evidence) {
    (byAngle[e.angle] = byAngle[e.angle] || []).push(e)
  }

  const grouped = Object.entries(byAngle).map(([angle, items]) => ({
    angle,
    source_count: items.length,
    sources: items.map(i => ({ title: i.title, url: i.url, snippet: i.snippet, content: i.content })),
  }))

  progress('汇总', `收集 ${evidence.length} 条来源，证据已落盘`)

  return toolJson({
    ok: true,
    tool: 'deep_research',
    query,
    angles,
    evidence_count: evidence.length,
    grouped,
    report_path: 'sandbox/research/' + path.basename(reportPath),
    guidance: '把上面 grouped 证据综合成最终报告：结论先行、按可靠度引用来源、标注不确定性。若用户要对比，输出对比表。report_path 里有完整证据可 read_file。',
  })
}
