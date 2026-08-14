// browser_act —— 交互式浏览器会话（Playwright Chromium）
// 与 browser_read 的一次性渲染不同，本工具维持一个跨调用持久的 page，
// 支持 navigate → click → fill → press → select → screenshot 的多步交互。
import fs from 'fs'
import path from 'path'
import { throwIfAborted } from '../../abort-utils.js'
import { getSharedBrowser, invalidateSharedBrowser, BROWSER_VIEWPORT } from './browser.js'
import { paths } from '../../../paths.js'
import { webJson, normalizeWebUrl } from './util.js'

const IDLE_TIMEOUT_MS = 8 * 60 * 1000  // 8 分钟无操作自动关会话
let session = null                     // { browser, context, page, lastUsed }

function ensureScreenshotDir() {
  const dir = path.join(paths.sandboxDir, 'screenshots')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

async function getOrCreateSession() {
  const now = Date.now()
  if (session) {
    if (now - session.lastUsed > IDLE_TIMEOUT_MS) {
      await closeSession()
    } else {
      session.lastUsed = now
      return session
    }
  }
  const { WEB_HEADERS } = await import('./util.js')
  const browser = await getSharedBrowser()
  const context = await browser.newContext({
    viewport: BROWSER_VIEWPORT,
    locale: 'zh-CN',
    userAgent: WEB_HEADERS['User-Agent'],
    ignoreHTTPSErrors: true,
  })
  const page = await context.newPage()
  session = { browser, context, page, lastUsed: now }
  return session
}

export async function closeSession() {
  if (!session) return
  const s = session
  session = null
  try { await s.page?.close() } catch {}
  try { await s.context?.close() } catch {}
  // 复用单例浏览器，不关
}

async function extractInteractiveElements(page, limit = 30) {
  return page.evaluate((limit) => {
    const out = []
    const push = (tag, el) => {
      if (out.length >= limit) return
      const text = (el.textContent || el.getAttribute?.('aria-label') || el.getAttribute?.('placeholder') || '')
        .replace(/\s+/g, ' ').trim().slice(0, 40)
      const id = el.id ? '#' + el.id : ''
      const cls = el.className && typeof el.className === 'string'
        ? '.' + el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.') : ''
      const name = el.getAttribute?.('name') ? '[name="' + el.getAttribute('name') + '"]' : ''
      out.push(tag + ' <' + el.tagName.toLowerCase() + id + cls + name + '> "' + text + '"')
    }
    document.querySelectorAll('a[href]').forEach(el => push('link', el))
    document.querySelectorAll('button').forEach(el => push('button', el))
    document.querySelectorAll('input, select, textarea').forEach(el => push('input', el))
    return out
  }, limit)
}

async function snapshot(page, { maxChars = 4000 } = {}) {
  const title = (await page.title()).trim()
  const url = page.url()
  const bodyText = await page.evaluate(() => {
    ;['script', 'style', 'noscript', 'svg', 'canvas', 'iframe'].forEach(t => document.querySelectorAll(t).forEach(e => e.remove()))
    return (document.body?.innerText || '').trim()
  }).catch(() => '')
  const elements = await extractInteractiveElements(page).catch(() => [])
  const content = String(bodyText || '')
  return {
    ok: true,
    title,
    url,
    content: content.length > maxChars ? content.slice(0, maxChars) + '\n…' : content,
    content_length: content.length,
    interactive: elements,
    hint: 'Interactive elements listed above — use their CSS selector with click/fill. Call action=snapshot anytime to refresh page state.',
  }
}

export async function execBrowserAct(args = {}, context = {}) {
  throwIfAborted(context.signal)
  const action = String(args.action || 'snapshot').trim().toLowerCase()
  const timeoutMs = Math.max(3000, Math.min(Number(args.timeout_ms || 20000), 45000))

  try {
    if (action === 'close') {
      await closeSession()
      return webJson({ ok: true, tool: 'browser_act', action, closed: true, hint: 'Browser session closed.' })
    }

    const s = await getOrCreateSession()
    const { page } = s
    page.setDefaultTimeout(timeoutMs)
    page.setDefaultNavigationTimeout(timeoutMs)

    switch (action) {
      case 'navigate': {
        const url = normalizeWebUrl(args.url)
        if (!url) return webJson({ ok: false, tool: 'browser_act', action, error: 'missing or invalid url' })
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
        await page.waitForLoadState('networkidle', { timeout: Math.min(timeoutMs, 8000) }).catch(() => {})
        const snap = await snapshot(page, { maxChars: args.max_chars })
        return webJson({ ...snap, action, ok: true, hint: snap.hint + ' (navigated)' })
      }

      case 'click': {
        const sel = String(args.selector || '').trim()
        if (!sel) return webJson({ ok: false, tool: 'browser_act', action, error: 'missing selector' })
        await page.locator(sel).first().waitFor({ state: 'visible', timeout: timeoutMs })
        await page.locator(sel).first().click({ timeout: timeoutMs })
        await page.waitForTimeout(600)
        const snap = await snapshot(page, { maxChars: args.max_chars })
        return webJson({ ...snap, action, ok: true })
      }

      case 'fill': {
        const sel = String(args.selector || '').trim()
        const val = String(args.value ?? '')
        if (!sel) return webJson({ ok: false, tool: 'browser_act', action, error: 'missing selector' })
        const loc = page.locator(sel).first()
        await loc.waitFor({ state: 'visible', timeout: timeoutMs })
        await loc.click({ timeout: timeoutMs })
        await loc.fill(val, { timeout: timeoutMs })
        const snap = await snapshot(page, { maxChars: args.max_chars })
        return webJson({ ...snap, action, ok: true })
      }

      case 'press': {
        const key = String(args.key || 'Enter')
        await page.keyboard.press(key, { timeout: timeoutMs })
        await page.waitForTimeout(500)
        const snap = await snapshot(page, { maxChars: args.max_chars })
        return webJson({ ...snap, action, ok: true, key })
      }

      case 'select': {
        const sel = String(args.selector || '').trim()
        const val = String(args.value ?? '')
        if (!sel) return webJson({ ok: false, tool: 'browser_act', action, error: 'missing selector' })
        const loc = page.locator(sel).first()
        await loc.waitFor({ state: 'attached', timeout: timeoutMs })
        await loc.selectOption(val, { timeout: timeoutMs })
        const snap = await snapshot(page, { maxChars: args.max_chars })
        return webJson({ ...snap, action, ok: true })
      }

      case 'wait': {
        const ms = Math.min(Number(args.wait_ms || 1000), 30000)
        await page.waitForTimeout(ms)
        const snap = await snapshot(page, { maxChars: args.max_chars })
        return webJson({ ...snap, action, ok: true, waited_ms: ms })
      }

      case 'screenshot': {
        const base = String(args.screenshot_name || 'browser').replace(/[^\w-]/g, '_')
        const dir = ensureScreenshotDir()
        const filePath = path.join(dir, base + '-' + Date.now() + '.png')
        await page.screenshot({ path: filePath, fullPage: false })
        const rel = path.relative(paths.sandboxDir, filePath).split(path.sep).join('/')
        return webJson({
          ok: true, tool: 'browser_act', action, screenshot_path: 'sandbox/' + rel,
          title: (await page.title()).trim(), url: page.url(),
          hint: 'Screenshot saved. Open it at sandbox/' + rel + ' (or read_file) to see the page visually.',
        })
      }

      case 'snapshot':
      default: {
        const snap = await snapshot(page, { maxChars: args.max_chars })
        return webJson({ ...snap, action: 'snapshot', ok: true })
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') throw err
    if (err?.name === 'TimeoutError') {
      return webJson({ ok: false, tool: 'browser_act', action, error: 'action timed out', hint: 'The page did not respond in time. Try action=snapshot to see current state, or wait/navigate again.' })
    }
    invalidateSharedBrowser()
    await closeSession().catch(() => {})
    return webJson({ ok: false, tool: 'browser_act', action, error: err.message || String(err), hint: 'Browser session ended. Start again with action=navigate.' })
  }
}
