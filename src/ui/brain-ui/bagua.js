// bagua.js —— 「易经 · 易学看板」控制器
// 职责：开/关全屏看板（与其它全屏模式互斥）、渲染六十四卦网格与卦象详情、
// 六爻起卦、太极八卦画布动画、时钟与跑马灯、状态上报。
// AI 对话调取：用户说「易经/八卦/六十四卦/太极/卜卦/起卦」等 → 前端关键词打开；
// 后端 Agent 也可经 bagua_mode 工具 emit bagua_mode 事件打开。

import { apiUrl } from './api-client.js';
import { setHotspotMode, moveVoicePanel, restoreVoicePanel } from './hotspot.js';
import { setWorldcupMode } from './worldcup.js';
import { setTyphoonMode } from './typhoon.js';
import { setPersonCardMode } from './person-card.js';
import { setDocPanelMode } from './doc.js';
import { TRIGRAMS, HEXAGRAMS, castHexagram } from './iching-data.js';
import { themeColors } from './ui-preferences.js';

const $ = (id) => document.getElementById(id);
const ESC = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

let bgActive = false;
let clockTimer = null;
let rafId = null;
let rotateAngle = 0;
let selectedN = 1;
let isDragging = false;
let lastPtr = { x: 0, y: 0 };

// ── 状态上报 / 模式切换 ──────────────────────────────────────────────────────
function reportBaguaState(visible, source = 'brain-ui') {
  fetch(apiUrl('/bagua-state'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ active: !!visible, source }),
  }).catch(() => {});
}

function setPanelVisible(visible, source = 'brain-ui') {
  bgActive = visible;
  document.body.classList.toggle('bagua-mode', visible);
  window.dispatchEvent(new CustomEvent('bailongma:bagua-mode', { detail: { active: visible } }));
  reportBaguaState(visible, source);
}

export function setBaguaMode(visible, { source = 'brain-ui' } = {}) {
  const next = !!visible;
  if (bgActive === next) { reportBaguaState(next, source); return; }
  if (!next) {
    setPanelVisible(false, source);
    if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    restoreVoicePanel();
  } else {
    // 互斥：关闭其它全屏模式
    setHotspotMode(false, { source: 'bagua_open' });
    setWorldcupMode(false, { source: 'bagua_open' });
    setTyphoonMode(false, { source: 'bagua_open' });
    setPersonCardMode(false, { source: 'bagua_open' });
    setDocPanelMode(false, { source: 'bagua_open' });
    for (const mode of ['video-mode', 'image-mode', 'music-mode']) document.body.classList.remove(mode);

    setPanelVisible(true, source);
    moveVoicePanel($('chat-area'), { prepend: true });
    renderTrigramLegend();
    renderHexagramGrid();
    showHexagramDetail(selectedN);
    startClock();
    startCanvas();
  }
}

export function toggleBagua(source = 'brain-ui') {
  setBaguaMode(!bgActive, { source });
}

// 暴露给其它面板互斥用
export function isBaguaActive() { return bgActive; }

// ── 八卦图例 ────────────────────────────────────────────────────────────────
function renderTrigramLegend() {
  const el = $('bg-trigram-legend');
  if (!el) return;
  el.innerHTML = TRIGRAMS.map(t => `
    <div class="bg-trig-item" data-tr="${t.name}">
      <span class="bg-trig-sym">${t.sym}</span>
      <span class="bg-trig-name">${t.name}</span>
      <span class="bg-trig-nature">${t.nature}</span>
      <span class="bg-trig-meta">五行${t.element} · ${t.family} · ${t.virtue}</span>
    </div>`).join('');
}

// ── 六十四卦网格 ────────────────────────────────────────────────────────────
function renderHexagramGrid() {
  const grid = $('bg-hexagram-grid');
  if (!grid) return;
  grid.innerHTML = HEXAGRAMS.map(h => `
    <button class="bg-hex-cell${h.n === selectedN ? ' active' : ''}" data-n="${h.n}" type="button" title="${h.name} · 第${h.n}卦">
      <span class="bg-hex-sym">${h.sym}</span>
      <span class="bg-hex-name">${h.name}</span>
      <span class="bg-hex-n">${String(h.n).padStart(2, '0')}</span>
    </button>`).join('');
  grid.querySelectorAll('.bg-hex-cell').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedN = Number(btn.dataset.n) || 1;
      grid.querySelectorAll('.bg-hex-cell').forEach(b => b.classList.toggle('active', Number(b.dataset.n) === selectedN));
      showHexagramDetail(selectedN);
    });
  });
}

// 爻线渲染：六爻自下而上，1=阳爻(实线) 0=阴爻(断线)
function renderLines(lines) {
  const bits = String(lines || '');
  const rows = [];
  for (let i = 0; i < 6; i++) {
    const bit = bits[5 - i]; // 自上而下展示
    const label = ['初', '二', '三', '四', '五', '上'][i];
    const isYang = bit === '1';
    rows.push(`
      <div class="bg-line-row">
        <span class="bg-line-pos">${label}</span>
        <span class="bg-line-visual">${isYang
          ? '<span class="bg-line yang"></span>'
          : '<span class="bg-line yin"></span>'}</span>
      </div>`);
  }
  return rows.join('');
}

function trigMeta(name) {
  const t = TRIGRAMS.find(x => x.name === name);
  return t || { sym: '☯', nature: '—', element: '—', family: '—', dirLater: '—' };
}

function showHexagramDetail(nOrHex) {
  const empty = $('bg-detail-empty');
  const detail = $('bg-detail');
  if (!detail) return;
  const h = typeof nOrHex === 'object' ? nOrHex : (HEXAGRAMS[(Number(nOrHex) || 1) - 1] || HEXAGRAMS[0]);
  const upper = trigMeta(h.upper);
  const lower = trigMeta(h.lower);
  $('bg-detail-sym').textContent = h.sym;
  $('bg-detail-name').textContent = h.name;
  $('bg-detail-meta').textContent = `第 ${h.n} 卦 · ${h.upper}上${h.lower}下 · 卦气五行${h.element}`;
  $('bg-detail-lines').innerHTML = renderLines(h.lines);
  $('bg-detail-tags').innerHTML = `
    <span class="bg-tag">上卦 ${upper.sym} ${h.upper} · ${upper.nature}</span>
    <span class="bg-tag">下卦 ${lower.sym} ${h.lower} · ${lower.nature}</span>
    <span class="bg-tag">五行 ${h.element}</span>
    <span class="bg-tag">方位 上${upper.dirLater} / 下${lower.dirLater}</span>`;
  $('bg-detail-judgment').textContent = h.judgment;
  if (empty) empty.hidden = true;
  detail.hidden = false;
}

// ── 六爻起卦 ────────────────────────────────────────────────────────────────
function castAndShow() {
  const result = castHexagram();
  const box = $('bg-cast-result');
  const movingText = result.moving.length
    ? result.moving.map(m => `${['初','二','三','四','五','上'][m.pos]}爻动`).join(' · ')
    : '六爻皆静（无动爻）';
  box.innerHTML = `
    <div class="bg-cast-symbols">
      <div class="bg-cast-col">
        <div class="bg-cast-sym">${result.hexagram.sym}</div>
        <div class="bg-cast-name">本卦 · ${result.hexagram.name}</div>
        <div class="bg-cast-n">第 ${result.hexagram.n} 卦</div>
      </div>
      <div class="bg-cast-arrow">→</div>
      <div class="bg-cast-col">
        <div class="bg-cast-sym">${result.changed.sym}</div>
        <div class="bg-cast-name">变卦 · ${result.changed.name}</div>
        <div class="bg-cast-n">第 ${result.changed.n} 卦</div>
      </div>
    </div>
    <div class="bg-cast-lines">${renderLines(result.binary)}</div>
    <div class="bg-cast-moving">${movingText}</div>`;
  // 详情切到本卦，动爻标注
  selectedN = result.hexagram.n;
  const grid = $('bg-hexagram-grid');
  grid.querySelectorAll('.bg-hex-cell').forEach(b => b.classList.toggle('active', Number(b.dataset.n) === selectedN));
  showHexagramDetail(result.hexagram);
  // 播放下落动画
  box.classList.remove('bg-cast-pop');
  void box.offsetWidth;
  box.classList.add('bg-cast-pop');
}

// ── 太极八卦画布 ────────────────────────────────────────────────────────────
function hexToRgb(hex) {
  if (typeof hex !== 'string') return { r: 120, g: 150, b: 210 };
  const m = hex.replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return { r: 120, g: 150, b: 210 };
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}
function rgba(c, a) { return `rgba(${c.r},${c.g},${c.b},${a})`; }

const TAIJI_COLOR = hexToRgb('#4f8cff');
const TAIJI_ACCENT = hexToRgb('#ffb86c');

function drawRing(ctx, cx, cy, r, color, width, alpha) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = rgba(color, alpha);
  ctx.lineWidth = width;
  ctx.stroke();
}

function drawTaiji(ctx, cx, cy, r, rot, yin, yang, rim) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);

  const aura = ctx.createRadialGradient(0, 0, r * 0.5, 0, 0, r * 1.55);
  aura.addColorStop(0, rgba(rim, 0.30));
  aura.addColorStop(1, rgba(rim, 0));
  ctx.fillStyle = aura;
  ctx.beginPath();
  ctx.arc(0, 0, r * 1.55, 0, Math.PI * 2);
  ctx.fill();

  // 左右两半
  ctx.fillStyle = yang;
  ctx.beginPath();
  ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = yin;
  ctx.beginPath();
  ctx.arc(0, 0, r, Math.PI / 2, Math.PI * 3 / 2);
  ctx.closePath();
  ctx.fill();

  // S 曲线双鱼
  ctx.beginPath();
  ctx.arc(0, -r / 2, r / 2, -Math.PI / 2, Math.PI / 2);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = yang;
  ctx.beginPath();
  ctx.arc(0, r / 2, r / 2, Math.PI / 2, Math.PI * 3 / 2);
  ctx.closePath();
  ctx.fill();

  // 鱼眼
  ctx.fillStyle = yang;
  ctx.beginPath();
  ctx.arc(0, -r / 2, r * 0.14, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = yin;
  ctx.beginPath();
  ctx.arc(0, r / 2, r * 0.14, 0, Math.PI * 2);
  ctx.fill();

  // 外缘描边辉光
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.strokeStyle = rgba(rim, 0.85);
  ctx.lineWidth = Math.max(1.4, r * 0.05);
  ctx.shadowColor = rgba(rim, 0.9);
  ctx.shadowBlur = 14;
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.restore();
}

function drawTrigramLines(ctx, cx, cy, angle, lines, innerR, outerR, color, alpha, glowColor, lit) {
  const lineH = (outerR - innerR) / 3;
  const midR = (innerR + outerR) / 2;
  const arcW = (2 * Math.PI * midR) / 8;
  const segLen = Math.min(lineH * 2.8, arcW * 0.72);
  const nx = Math.cos(angle), ny = Math.sin(angle);
  const tx = -Math.sin(angle), ty = Math.cos(angle);
  const hx = tx * segLen / 2, hy = ty * segLen / 2;
  const gap = segLen * 0.34, gxv = tx * gap / 2, gyv = ty * gap / 2;

  if (lit) {
    const gx2 = cx + nx * midR, gy2 = cy + ny * midR;
    const gr = (outerR - innerR) * 1.7;
    const grad = ctx.createRadialGradient(gx2, gy2, 0, gx2, gy2, gr);
    grad.addColorStop(0, rgba(glowColor, 0.55));
    grad.addColorStop(1, rgba(glowColor, 0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(gx2, gy2, gr, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.6, lineH * 0.6);
  ctx.lineCap = 'butt';
  ctx.globalAlpha = alpha;
  ctx.shadowColor = lit ? rgba(glowColor, 0.9) : 'rgba(120,150,220,0.35)';
  ctx.shadowBlur = lit ? 10 : 4;

  for (let k = 0; k < 3; k++) {
    const r = innerR + (k + 0.5) * lineH;
    const px = cx + nx * r, py = cy + ny * r;
    if (lines[k] === '1') {
      ctx.beginPath(); ctx.moveTo(px - hx, py - hy); ctx.lineTo(px + hx, py + hy); ctx.stroke();
    } else {
      ctx.beginPath(); ctx.moveTo(px - hx, py - hy); ctx.lineTo(px - gxv, py - gyv); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(px + gxv, py + gyv); ctx.lineTo(px + hx, py + hy); ctx.stroke();
    }
  }
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;
}

function drawStardust(ctx, cx, cy, R, rot, t, color) {
  const count = 30;
  for (let i = 0; i < count; i++) {
    const seed = i * 137.31 + 41;
    const a0 = seed % (Math.PI * 2);
    const r0 = R * 0.5 + ((seed * 0.618) % (R * 0.9 - R * 0.5));
    const ang = a0 + rot * (i % 2 === 0 ? 1 : -0.6);
    const tw = 0.5 + 0.5 * Math.sin(t * (0.8 + (i % 5) * 0.23) + seed);
    const x = cx + Math.cos(ang) * r0;
    const y = cy + Math.sin(ang) * r0;
    ctx.fillStyle = rgba(color, 0.10 + 0.28 * tw);
    ctx.beginPath();
    ctx.arc(x, y, 0.6 + tw * 1.3, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawCanvasFrame(now) {
  const canvas = $('bg-canvas');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const w = rect.width || canvas.clientWidth || 320;
  const h = rect.height || canvas.clientHeight || 320;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const cx = w / 2, cy = h / 2;
  const S = Math.min(w, h);
  const t = now / 1000;

  // 太极配色跟随主题 token（--cool / --warm，读自 design-tokens.css），切主题即时生效
  const taijiColor = themeColors.cool ? hexToRgb(themeColors.cool) : TAIJI_COLOR;
  const taijiAccent = themeColors.warm ? hexToRgb(themeColors.warm) : TAIJI_ACCENT;

  // 背景辉光
  const bg = ctx.createRadialGradient(cx, cy, S * 0.1, cx, cy, S * 0.75);
  bg.addColorStop(0, rgba(taijiColor, 0.10));
  bg.addColorStop(1, rgba(taijiColor, 0));
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  drawStardust(ctx, cx, cy, S * 0.45, rotateAngle + t * 0.05, t, taijiColor);

  // 外圈装饰环
  drawRing(ctx, cx, cy, S * 0.46, taijiColor, 1, 0.18);
  drawRing(ctx, cx, cy, S * 0.445, taijiAccent, 0.6, 0.12);

  // 八卦爻环（先天序顺时针）
  const rot = rotateAngle + t * 0.02;
  const innerR = S * 0.30, outerR = S * 0.42;
  const nameR = S * 0.45;
  for (let i = 0; i < 8; i++) {
    const tr = TRIGRAMS[i];
    const angle = -Math.PI / 2 + rot + (i / 8) * Math.PI * 2;
    const lit = tr.name === '乾' || tr.name === '坤';
    drawTrigramLines(ctx, cx, cy, angle, tr.lines, innerR, outerR,
      lit ? rgba(taijiAccent, 1) : rgba(taijiColor, 1), 0.85, taijiAccent, lit);
    // 卦名 + 自然
    const nx = cx + Math.cos(angle) * nameR;
    const ny = cy + Math.sin(angle) * nameR;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = lit ? 'rgba(255,214,150,0.95)' : 'rgba(214,224,244,0.9)';
    ctx.font = `600 ${Math.max(12, Math.round(S * 0.045))}px 'Inter','PingFang SC','Microsoft YaHei',sans-serif`;
    ctx.shadowColor = rgba(taijiAccent, 0.5);
    ctx.shadowBlur = 8;
    ctx.fillText(tr.name, nx, ny - S * 0.022);
    ctx.font = `500 ${Math.max(9, Math.round(S * 0.032))}px 'Inter','PingFang SC',sans-serif`;
    ctx.fillStyle = 'rgba(160,180,215,0.85)';
    ctx.fillText(tr.nature, nx, ny + S * 0.03);
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  }

  // 中央太极
  const yin = rgba({ r: 14, g: 18, b: 30 }, 0.96);
  const yang = rgba({ r: 250, g: 246, b: 238 }, 0.97);
  drawTaiji(ctx, cx, cy, S * 0.26, rotateAngle * 0.6 + t * 0.12, yin, yang, taijiAccent);
}

function startCanvas() {
  if (rafId) cancelAnimationFrame(rafId);
  const step = (now) => {
    drawCanvasFrame(now);
    rafId = requestAnimationFrame(step);
  };
  rafId = requestAnimationFrame(step);
}

// ── 时钟 / 交互 ─────────────────────────────────────────────────────────────
function updateClock() {
  const el = $('bg-clock');
  if (!el) return;
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  el.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}
function startClock() {
  updateClock();
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = setInterval(updateClock, 1000);
}

function bindCanvasDrag() {
  const canvas = $('bg-canvas');
  if (!canvas) return;
  canvas.addEventListener('pointerdown', (e) => {
    isDragging = true;
    lastPtr = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture?.(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - lastPtr.x;
    rotateAngle += dx * 0.006;
    lastPtr = { x: e.clientX, y: e.clientY };
  });
  const end = () => { isDragging = false; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
}

// 底部跑马灯：内容翻倍实现无缝循环
function renderTicker() {
  const el = $('bg-ticker-inner');
  if (!el || el.dataset.dup) return;
  el.innerHTML = el.innerHTML + el.innerHTML;
  el.dataset.dup = '1';
}

export function initBagua() {
  $('bg-exit-btn')?.addEventListener('click', () => toggleBagua());
  $('bg-cast-btn')?.addEventListener('click', () => castAndShow());
  bindCanvasDrag();
  renderTicker();
  // 顶栏太极八卦图（语音球）点击 → 打开/关闭易学看板
  window.addEventListener('bailongma:bagua-toggle', () => toggleBagua());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && bgActive) setBaguaMode(false);
  });
  // 其它全屏面板打开时，本面板自动退场（互斥）
  window.addEventListener('bailongma:hotspot-mode', (e) => { if (e?.detail?.active && bgActive) setBaguaMode(false); });
  window.addEventListener('bailongma:worldcup-mode', (e) => { if (e?.detail?.active && bgActive) setBaguaMode(false); });
  window.addEventListener('bailongma:typhoon-mode', (e) => { if (e?.detail?.active && bgActive) setBaguaMode(false); });
  window.addEventListener('bailongma:person-card-mode', (e) => { if (e?.detail?.active && bgActive) setBaguaMode(false); });
}
