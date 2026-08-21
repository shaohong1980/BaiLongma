// smoke-ui-enhancements.mjs —— UI 优化冒烟：命令面板 / 待审批横幅 / 最近会话
// 独立静态服务器 + Playwright，验证三项新 UI 功能在浏览器里真实可用。
import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { chromium } from 'playwright'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const brainUiRoot = path.join(root, 'src', 'ui', 'brain-ui')

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase()
  const type = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.css' ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8'
  try {
    const stat = fs.statSync(filePath)
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Cache-Control': 'no-cache' })
    fs.createReadStream(filePath).pipe(res)
  } catch { res.writeHead(404); res.end('not found') }
}
function sendJson(res, body) { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)) }

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/brain-ui' || url.pathname === '/') return sendFile(res, path.join(root, 'brain-ui.html'))
  if (url.pathname === '/vendor/d3/d3.min.js') return sendFile(res, path.join(root, 'node_modules', 'd3', 'dist', 'd3.min.js'))
  if (url.pathname.startsWith('/src/ui/')) {
    const rel = decodeURIComponent(url.pathname.slice('/src/ui/'.length))
    return sendFile(res, path.resolve(path.join(root, 'src', 'ui'), rel))
  }
  if (url.pathname.startsWith('/src/ui/brain-ui/')) {
    return sendFile(res, path.resolve(brainUiRoot, decodeURIComponent(url.pathname.slice('/src/ui/brain-ui/'.length))))
  }
  if (url.pathname === '/agent-profile') return sendJson(res, { name: 'UiTest' })
  if (url.pathname === '/conversations') return sendJson(res, [
    { id: 1, role: 'user', from_id: 'ID:000001', content: '帮我写个报告', timestamp: '2026-08-20T10:00:00' },
    { id: 2, role: 'jarvis', from_id: 'jarvis', content: '好的，报告写好了', timestamp: '2026-08-20T10:00:30' },
    { id: 3, role: 'user', from_id: 'discord:123', content: 'hello from discord', timestamp: '2026-08-20T09:00:00' },
  ])
  if (url.pathname === '/approvals') return sendJson(res, { pending_count: 2, approvals: [
    { id: 'a1', risk_level: 'high', title: '执行删除文件', description: 'rm report.tmp', created_at: '2026-08-20T11:00:00' },
    { id: 'a2', risk_level: 'medium', title: '安装软件', description: 'install python', created_at: '2026-08-20T11:05:00' },
  ] })
  if (url.pathname === '/settings') return sendJson(res, { llm: { activated: true, provider: 'deepseek', model: 'x', models: [{ id: 'x', label: 'X' }] }, providers: { deepseek: { models: [{ id: 'x', label: 'X' }] } }, minimax: { configured: false } })
  if (url.pathname === '/settings/tts') return sendJson(res, { ok: true, tts: {}, providers: [], voices: {} })
  if (url.pathname === '/hotspots') return sendJson(res, { ok: true, refreshMinutes: 30, fetchedAt: '', stale: false, platforms: {} })
  if (url.pathname === '/audit/stats') return sendJson(res, { windowHours: 1, sinceIso: '', recall: {}, extract: {} })
  if (url.pathname === '/docs') return sendJson(res, { ok: true, topics: [] })
  if (url.pathname.startsWith('/docs/')) return sendJson(res, { ok: true, doc: { id: 'x', title: 'x', body: '' } })
  if (url.pathname === '/aivideo/history') return sendJson(res, { ok: true, jobs: [] })
  if (url.pathname === '/person-card') return sendJson(res, { ok: true, card: { name: 'x', summary: '', knownFor: [], tags: [] } })
  if (url.pathname === '/workbench' || url.pathname === '/workbench/reviews') return sendJson(res, { ok: true, snapshot: {}, pending: [], done: [], reviews: [], currentWeekKey: '2026-W33' })
  if (url.pathname === '/social/wechat-clawbot/qr') return sendJson(res, { ok: true, qr: null, status: 'unavailable' })
  if (url.pathname === '/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }); res.write(`data: ${JSON.stringify({ type: 'connected', data: {}, ts: new Date().toISOString() })}\n\n`); return }
  if (url.pathname === '/message') return sendJson(res, { ok: true })
  res.writeHead(404); res.end('not found')
})

await new Promise(r => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const base = `http://127.0.0.1:${port}`

let pass = 0, fail = 0
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓', name) } else { fail++; console.log('  ✗', name, extra) }
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 840 } })
const errors = []
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message))
try {
  await page.goto(`${base}/brain-ui`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#navbar', { timeout: 10000 })

  // 1. 命令面板：Ctrl+K 打开，列出命令，执行页面切换
  await page.keyboard.press('Control+K')
  await page.waitForSelector('.command-palette-overlay.open', { timeout: 4000 })
  const itemCount = await page.evaluate(() => document.querySelectorAll('.command-palette-item').length)
  check('command palette opens with items', itemCount >= 10, `got ${itemCount}`)
  await page.fill('.command-palette-input', '多Agent')
  await page.waitForTimeout(150)
  const filtered = await page.evaluate(() => document.querySelectorAll('.command-palette-item').length)
  check('palette filters by keyword', filtered === 1, `got ${filtered}`)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(200)
  const onMultiagent = await page.evaluate(() => document.body.classList.contains('page-multiagent'))
  check('palette executes page switch', onMultiagent === true)

  // 2. 侧栏最近会话
  await page.waitForSelector('.recent-conv', { timeout: 4000 })
  const recentCount = await page.evaluate(() => document.querySelectorAll('.recent-conv').length)
  check('recent conversations render', recentCount >= 2, `got ${recentCount}`)
  const firstLabel = await page.evaluate(() => document.querySelector('.recent-conv-label')?.textContent || '')
  check('recent conversation has party label', firstLabel.length > 0, firstLabel)

  // 3. 待审批横幅
  await page.waitForSelector('#approval-banner.show', { timeout: 4000 })
  const bannerText = await page.evaluate(() => document.getElementById('approval-banner-text')?.textContent || '')
  check('approval banner shows count', bannerText.includes('2'), bannerText)
  await page.click('#approval-banner-btn')
  await page.waitForSelector('#approvals-overlay:not([hidden])', { timeout: 4000 })
  check('approval banner opens approvals modal', true)
  const approvalItems = await page.evaluate(() => document.querySelectorAll('.approval-item').length)
  check('approvals modal lists items', approvalItems >= 2, `got ${approvalItems}`)

  check('no uncaught JS exceptions', errors.length === 0, JSON.stringify(errors))
} finally {
  await browser.close()
  server.closeAllConnections?.()
  server.close()
}

console.log(`\nUI enhancements: ${pass}/${pass+fail} passed`)
process.exit(fail ? 1 : 0)
