// command-palette.js —— 全局命令面板（ZeroClaw Command Palette 思路，vanilla JS 复刻）
//
// Ctrl+K / Ctrl+Shift+P 唤出；输入过滤；↑↓ 选择；Enter 执行；Esc 关闭。
// app.js 通过 initCommandPalette(commands) 注册命令列表，每个命令：
//   { id, title, group, keywords, icon, run() }
//
// 面板 DOM 由本模块创建并挂到 body，样式见 styles.css（.command-palette-*）。

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}

let commands = []
let paletteEl = null
let inputEl = null
let listEl = null
let visible = false
let activeIndex = 0

function ensureDom() {
  if (paletteEl) return
  const wrap = document.createElement('div')
  wrap.className = 'command-palette-overlay'
  wrap.innerHTML = `
    <div class="command-palette" role="dialog" aria-modal="true" aria-label="命令面板">
      <div class="command-palette-input-row">
        <span class="command-palette-cmd-icon">⌘</span>
        <input class="command-palette-input" placeholder="输入命令或搜索页面 / 面板 / 操作…" autocomplete="off" spellcheck="false" />
        <span class="command-palette-esc">ESC</span>
      </div>
      <div class="command-palette-list"></div>
      <div class="command-palette-empty" hidden>没有匹配的命令</div>
    </div>`
  wrap.addEventListener('mousedown', (e) => {
    if (e.target === wrap) close()
  })
  inputEl = wrap.querySelector('.command-palette-input')
  listEl = wrap.querySelector('.command-palette-list')
  const emptyEl = wrap.querySelector('.command-palette-empty')
  inputEl.addEventListener('input', () => {
    activeIndex = 0
    render(filtered())
    emptyEl.hidden = filtered().length > 0
  })
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); return }
    if (e.key === 'Enter') { e.preventDefault(); execute(filtered()[activeIndex]); return }
  })
  document.body.appendChild(wrap)
  paletteEl = wrap
}

function filtered() {
  const q = String(inputEl?.value || '').trim().toLowerCase()
  if (!q) return commands
  return commands.filter(c => {
    const hay = `${c.title} ${c.keywords || ''} ${c.group || ''}`.toLowerCase()
    return q.split(/\s+/).every(part => hay.includes(part))
  })
}

function move(delta) {
  const items = filtered()
  if (!items.length) return
  activeIndex = (activeIndex + delta + items.length) % items.length
  render(items)
  listEl?.querySelectorAll('.command-palette-item')[activeIndex]?.scrollIntoView({ block: 'nearest' })
}

function execute(cmd) {
  if (!cmd) return
  close()
  try { cmd.run?.() } catch (err) { console.warn('[command-palette] run failed:', err?.message || err) }
}

function render(items) {
  if (!listEl) return
  if (!items.length) { listEl.innerHTML = ''; return }
  listEl.innerHTML = items.map((c, i) => `
    <button class="command-palette-item ${i === activeIndex ? 'active' : ''}" data-idx="${i}" type="button">
      <span class="command-palette-icon">${c.icon || '•'}</span>
      <span class="command-palette-title">${escHtml(c.title)}</span>
      <span class="command-palette-group">${escHtml(c.group || '')}</span>
    </button>`).join('')
  listEl.querySelectorAll('.command-palette-item').forEach(btn => {
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault()
      const cmd = filtered()[Number(btn.dataset.idx)]
      execute(cmd)
    })
  })
}

export function openPalette() {
  ensureDom()
  visible = true
  paletteEl.classList.add('open')
  document.body.classList.add('command-palette-open')
  if (inputEl) {
    inputEl.value = ''
    inputEl.focus()
  }
  activeIndex = 0
  render(filtered())
  const emptyEl = paletteEl.querySelector('.command-palette-empty')
  if (emptyEl) emptyEl.hidden = true
}

export function closePalette() {
  if (!paletteEl) return
  visible = false
  paletteEl.classList.remove('open')
  document.body.classList.remove('command-palette-open')
}

export function isPaletteOpen() {
  return visible
}

export function initCommandPalette(cmds = []) {
  commands = Array.isArray(cmds) ? cmds : []
  ensureDom()
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey
    const isK = e.key === 'k' || e.key === 'K'
    const isShiftP = e.shiftKey && (e.key === 'p' || e.key === 'P')
    if ((mod && isK) || (mod && e.shiftKey && isK) || (mod && isShiftP)) {
      e.preventDefault()
      if (visible) closePalette()
      else openPalette()
      return
    }
    if (e.key === 'Escape' && visible) {
      closePalette()
    }
  })
  return { openPalette, closePalette, isPaletteOpen }
}
