// smoke-ui-layout.mjs —— 前端冒烟（Playwright）
//
// 两部分：
//   1. memory-graph 纯函数模块（node 直接 import，无 DOM 依赖）——防 app.js 拆分回归。
//   2. 布局切换（连真实后端 http://127.0.0.1:3721/brain-ui）——验证 video/music/sphere
//      三种模式布局与核心面板元素。后端不可用时跳过本部分（不失败）。
// 运行：node scripts/smoke-ui-layout.mjs
import path from 'path'
import fs from 'fs'
import { chromium } from 'playwright'


let pass = 0, fail = 0, skip = 0
function check(label, cond) {
  if (cond) { pass++; console.log('PASS:', label) }
  else { fail++; console.log('FAIL:', label) }
}

// ── 1. memory-graph 纯函数（node 直接 import，无需页面 / 后端）──
const mg = await import('../src/ui/brain-ui/memory-graph.js')
check('parseEntities 解析数组', mg.parseEntities('["a","b"]').length === 2)
check('parseLinks 解析数组', mg.parseLinks('[{"source":1,"target":2}]').length === 1)
check('deterministicIndex 返回 [0,mod)', (() => { const i = mg.deterministicIndex('hello', 10); return i >= 0 && i < 10 })())
check('createVisualOrder 核心节点优先', (() => {
  const order = mg.createVisualOrder([{ _nid: 1, _core: true, entities: '[]' }, { _nid: 2, entities: '[]' }])
  return order[0]._nid === 1
})())
check('shuffleArray 不修改原数组', (() => { const a = [1,2,3]; mg.shuffleArray(a); return a.length === 3 })())

// ── 2. 布局切换（需后端）──
let backendUp = false
try {
  const resp = await fetch('http://127.0.0.1:3721/activation-status', { signal: AbortSignal.timeout(2000) })
  backendUp = resp.ok
} catch {}

if (!backendUp) {
  console.log('SKIP: 后端不可用（布局检查跳过；先 npm run dev 启动后端）')
  skip += 4
} else {
  // 自动探测已安装的 Playwright chromium
  let chromiumPath = process.env.CHROMIUM_PATH || ''
  if (!chromiumPath) {
    const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ms-playwright') : ''
    if (base && fs.existsSync(base)) {
      try {
        for (const dir of fs.readdirSync(base).filter(d => d.startsWith('chromium-')).sort().reverse()) {
          const exe = path.join(base, dir, 'chrome-win64', 'chrome.exe')
          if (fs.existsSync(exe)) { chromiumPath = exe; break }
        }
      } catch {}
    }
  }

  const browser = await chromium.launch({ headless: true, ...(chromiumPath ? { executablePath: chromiumPath } : {}) })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  await page.goto('http://127.0.0.1:3721/brain-ui', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(5000)

  check('核心元素：聊天输入框', !!(await page.$('#msg-input')))
  check('核心元素：图谱画布', !!(await page.$('#graph')))
  check('无 JS 错误', errors.length === 0)

  // 布局切换（重置缩放为 1 消除 UI zoom 干扰；禁用 transition 避免 headless 下测量到中间值）
  await page.addStyleTag({ content: '#video-panel,#aivideo-panel,#music-panel,#graph{transition:none!important}' })
  await page.evaluate(() => { document.documentElement.style.zoom = '1' })
  const layout = await page.evaluate(() => {
    const rect = (s) => { const el = document.querySelector(s); if (!el) return null; const b = el.getBoundingClientRect(); return Math.round(b.width) }
    const out = {}
    document.body.classList.add('video-mode')
    out.video = rect('#video-panel')
    document.body.classList.remove('video-mode'); document.body.classList.add('music-mode')
    out.music = rect('#music-panel')
    document.body.classList.remove('music-mode'); document.body.classList.add('sphere-enlarged')
    const g = document.getElementById('graph'); if (g) { g.classList.add('enlarged'); g.style.removeProperty('display') }
    const gc = document.getElementById('graph-controls')
    out.sphere = gc ? getComputedStyle(gc).flexDirection : null
    return out
  })
  check('video 面板布局（宽 760）', layout.video === 760)
  check('music 面板布局（宽 640）', layout.music === 640)
  check('sphere 控制条横向排布', layout.sphere === 'row')

  await browser.close()
}

console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`)
process.exit(fail === 0 ? 0 : 1)
