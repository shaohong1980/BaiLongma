// voice-bagua.js —— 语音球的「玄幻太极八卦图」渲染器
//
// 取代原 Rive 小助手：在左上角语音球位置绘制一张玄幻风格的太极八卦图：
//   · 中央是修正版太极阴阳鱼（更大、带辉光与渐变）
//   · 外围一圈 8 个先天八卦（乾兑离震巽坎艮坤），每个卦象 3 爻大而清晰 + 卦名
//   · 整图缓慢旋转，背景点缀旋转星尘 + 外圈柔光
//   · 说话时（用户发言 / Agent 播报 TTS）根据「时间卦 + 说话内容哈希」点亮对应卦象，
//     点亮卦变亮发光并显示卦名，安静后亮度缓慢恢复。
//
// 对外接口（与 voice-rive 一致，voice-core 驱动）：
//   setStatus(sk) / setExternalVol(v) / startRenderLoop() / stopRenderLoop()
//   setSpeakingText(text) —— 说话内容（用户转写 / TTS 文本），用于定位卦象
//   setViseme(code) —— 口型数据对卦图无意义，no-op
//   isReady() / hasFailed() / getState() / debug()

function hexToRgb(hex) {
  if (typeof hex !== 'string') return null;
  const m = hex.replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return null;
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}
function rgba(c, a) {
  if (!c) return `rgba(180,190,210,${a})`;
  return `rgba(${c.r},${c.g},${c.b},${a})`;
}
function mix(a, b, t) {
  return { r: Math.round(a.r + (b.r - a.r) * t), g: Math.round(a.g + (b.g - a.g) * t), b: Math.round(a.b + (b.b - a.b) * t) };
}

// 先天八卦（伏羲八卦）：按圆周顺序乾兑离震坤艮坎巽，卦象自下而上，1=阳爻 0=阴爻
const TRIGRAMS = [
  { name: '乾', elem: '天', lines: '111' },
  { name: '兑', elem: '泽', lines: '110' },
  { name: '离', elem: '火', lines: '101' },
  { name: '震', elem: '雷', lines: '100' },
  { name: '坤', elem: '地', lines: '000' },
  { name: '艮', elem: '山', lines: '001' },
  { name: '坎', elem: '水', lines: '010' },
  { name: '巽', elem: '风', lines: '011' },
];

// 时间卦：24 小时 ÷ 8 卦 = 每卦 3 小时
function trigramByTime() {
  return Math.floor(Date.now() / (3 * 60 * 60 * 1000)) % 8;
}

// 内容哈希（FNV-1a → 0..7）
function hashText(text) {
  let h = 2166136261;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h >>> 0) % 8;
}

// 环绕的旋转星尘（玄幻氛围：细小的亮点缓慢绕中心漂移 + 轻微闪烁）
function drawStardust(ctx, cx, cy, S, rot, t, primary) {
  const count = 26;
  const R1 = S * 0.42, R2 = S * 0.5;
  for (let i = 0; i < count; i++) {
    // 用固定种子生成稳定位置
    const seed = i * 127.31 + 311;
    const a0 = seed % (Math.PI * 2);
    const r0 = R1 + ((seed * 0.618) % (R2 - R1));
    const ang = a0 + rot * (i % 2 === 0 ? 1 : -0.6);
    const tw = 0.5 + 0.5 * Math.sin(t * (0.8 + (i % 5) * 0.23) + seed);
    const x = cx + Math.cos(ang) * r0;
    const y = cy + Math.sin(ang) * r0;
    const rr = 0.6 + tw * 1.4;
    ctx.fillStyle = rgba(primary, 0.12 + 0.35 * tw);
    ctx.beginPath();
    ctx.arc(x, y, rr, 0, Math.PI * 2);
    ctx.fill();
  }
}

// 卦环外圈的一圈柔光（玄幻辉光）
function drawAura(ctx, cx, cy, r, color) {
  const g = ctx.createRadialGradient(cx, cy, r * 0.9, cx, cy, r * 1.25);
  g.addColorStop(0, rgba(color, 0.22));
  g.addColorStop(0.7, rgba(color, 0.07));
  g.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 1.25, 0, Math.PI * 2);
  ctx.fill();
}

// 画一个卦象：3 爻自内（初爻）向外（上爻）径向排布，每爻是垂直于半径的短线
// （阳爻整段、阴爻断开两段）。lit 时加光晕 + 变亮。
function drawTrigram(ctx, cx, cy, angle, lines, innerR, outerR, lineColor, alpha, lit, glowColor) {
  const lineH = (outerR - innerR) / 3;
  const midR = (innerR + outerR) / 2;
  const arcW = (2 * Math.PI * midR) / 8;
  const segLen = Math.min(lineH * 2.8, arcW * 0.7);
  const nx = Math.cos(angle), ny = Math.sin(angle);
  const tx = -Math.sin(angle), ty = Math.cos(angle);
  const hx = tx * segLen / 2, hy = ty * segLen / 2;
  // 阴爻缺口要明显（>线宽，否则圆头会把缺口填上、8 卦看起来都一样）
  const gap = segLen * 0.34, gxv = tx * gap / 2, gyv = ty * gap / 2;

  // 光晕（画在卦象后面）
  if (lit) {
    const gx2 = cx + nx * midR, gy2 = cy + ny * midR;
    const gr = (outerR - innerR) * 1.6;
    const grad = ctx.createRadialGradient(gx2, gy2, 0, gx2, gy2, gr);
    grad.addColorStop(0, rgba(glowColor, 0.6));
    grad.addColorStop(1, rgba(glowColor, 0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(gx2, gy2, gr, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.strokeStyle = lineColor;
  ctx.lineWidth = Math.max(1.6, lineH * 0.62);
  ctx.lineCap = 'butt'; // 平头：阴爻缺口清晰可见
  ctx.globalAlpha = alpha;
  // 爻线微光（玄幻感）
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

// 画中央太极（标准阴阳鱼：S 曲线两半圆的圆心在大圆竖直半径中点 (0,±r/2)）
function drawTaiji(ctx, cx, cy, r, rot, yin, yang, rim) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);

  // 太极辉光（背后的柔光）
  const aura = ctx.createRadialGradient(0, 0, r * 0.5, 0, 0, r * 1.6);
  aura.addColorStop(0, rgba(rim, 0.32));
  aura.addColorStop(1, rgba(rim, 0));
  ctx.fillStyle = aura;
  ctx.beginPath();
  ctx.arc(0, 0, r * 1.6, 0, Math.PI * 2);
  ctx.fill();

  // 右半阳（白/暖）
  ctx.fillStyle = yang;
  ctx.beginPath();
  ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2);
  ctx.closePath();
  ctx.fill();

  // 左半阴（黑）
  ctx.fillStyle = yin;
  ctx.beginPath();
  ctx.arc(0, 0, r, Math.PI / 2, Math.PI * 3 / 2);
  ctx.closePath();
  ctx.fill();

  // S 曲线：圆心 (0,-r/2) 的右半圆 → 黑鱼头（右上）；圆心 (0,r/2) 的左半圆 → 白鱼头（左下）
  ctx.beginPath();
  ctx.arc(0, -r / 2, r / 2, -Math.PI / 2, Math.PI / 2);
  ctx.closePath();
  ctx.fill(); // 仍为 yin
  ctx.fillStyle = yang;
  ctx.beginPath();
  ctx.arc(0, r / 2, r / 2, Math.PI / 2, Math.PI * 3 / 2);
  ctx.closePath();
  ctx.fill();

  // 鱼眼（在鱼头中心）
  ctx.fillStyle = yang;
  ctx.beginPath();
  ctx.arc(0, -r / 2, r * 0.15, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = yin;
  ctx.beginPath();
  ctx.arc(0, r / 2, r * 0.15, 0, Math.PI * 2);
  ctx.fill();

  // 外缘辉光描边
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.strokeStyle = rgba(rim, 0.9);
  ctx.lineWidth = Math.max(1.5, r * 0.06);
  ctx.shadowColor = rgba(rim, 0.9);
  ctx.shadowBlur = 12;
  ctx.stroke();
  ctx.shadowBlur = 0;

  ctx.restore();
}

export function createVoiceBagua({ canvas, primaryColor, secondaryColor } = {}) {
  if (!canvas) return null;
  const primary = hexToRgb(primaryColor) || { r: 120, g: 150, b: 210 };
  const secondary = hexToRgb(secondaryColor) || { r: 255, g: 200, b: 140 };

  let sk = 'idle';
  let lastVol = 0;
  let textHash = 0;
  let litIndex = -1;
  let litIntensity = 0;
  let rafId = null;

  function setStatus(newSk) { sk = newSk || 'idle'; }
  function setExternalVol(v) { lastVol = v == null ? 0 : Number(v) || 0; }
  function setViseme() { /* 卦图不需要口型 */ }
  function setSpeakingText(text) {
    if (text != null && String(text).trim()) textHash = hashText(text);
  }

  // 说话判定：Agent 播报（speaking），或用户在说话（listening/recognizing + 有音量）
  function isTalking() {
    if (sk === 'speaking') return true;
    if ((sk === 'recognizing' || sk === 'listening') && lastVol > 0.04) return true;
    return false;
  }

  // canvas buffer 对齐实际显示尺寸（getBoundingClientRect 反映布局后的真实大小）
  function syncSize(ctx) {
    const rect = canvas.getBoundingClientRect();
    const w = rect.width || canvas.clientWidth || 260;
    const h = rect.height || canvas.clientHeight || 260;
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 3));
    const W = Math.max(1, Math.round(w * dpr));
    const H = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { size: Math.max(w, h), dpr };
  }

  function draw(now) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { size: S } = syncSize(ctx);
    const cx = S / 2, cy = S / 2;
    ctx.clearRect(0, 0, S, S);

    const t = now / 1000;
    const rotRing = t * 0.055;   // 卦环缓慢旋转（约 114s 一圈）
    const rotTaiji = t * 0.16;   // 太极稍快（约 39s 一圈）

    // 玄幻氛围
    drawStardust(ctx, cx, cy, S, rotRing, t, primary);
    drawAura(ctx, cx, cy, S * 0.42, primary);

    // 布局都收在圆形画布内，保证文字（卦名/亮起卦名）不被边缘裁剪
    const innerR = S * 0.31, outerR = S * 0.40;
    const nameR = S * 0.43;   // 卦名半径（安全留边）
    const dimAlpha = 0.62;

    // 8 卦环
    for (let i = 0; i < 8; i++) {
      const angle = -Math.PI / 2 + rotRing + (i / 8) * Math.PI * 2;
      const lit = (i === litIndex) && litIntensity > 0.02;
      const alpha = lit ? (0.6 + 0.4 * litIntensity) : dimAlpha;
      const trigram = TRIGRAMS[i];
      // 卦象（爻线）
      drawTrigram(
        ctx, cx, cy, angle, trigram.lines, innerR, outerR,
        lit ? rgba(secondary, 1) : rgba(primary, 1),
        alpha, lit, secondary
      );
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (lit) {
        // 亮起卦：卦名 · 五行跟随卦移动（外缘稍远、带辉光）。
        // 文字沿切线方向排布并保持直立，左右/上下都不会超出圆形画布。
        const ar = nameR + S * 0.035;
        const ax = cx + Math.cos(angle) * ar;
        const ay = cy + Math.sin(angle) * ar;
        // 切线角度 + 归一化到 [-π/2, π/2]，保证文字不颠倒
        let rot = angle + Math.PI / 2;
        while (rot > Math.PI / 2) rot -= Math.PI;
        while (rot < -Math.PI / 2) rot += Math.PI;
        ctx.save();
        ctx.translate(ax, ay);
        ctx.rotate(rot);
        ctx.globalAlpha = Math.min(1, 0.8 + 0.2 * litIntensity);
        ctx.fillStyle = rgba(secondary, 1);
        ctx.font = `700 ${Math.max(13, Math.round(S * 0.055))}px 'Inter','PingFang SC','Microsoft YaHei',sans-serif`;
        ctx.shadowColor = rgba(secondary, 0.9);
        ctx.shadowBlur = 10;
        ctx.fillText(`${trigram.name} · ${trigram.elem}`, 0, 0);
        ctx.shadowBlur = 0;
        ctx.restore();
      } else {
        // 未亮：小号卦名（安全半径内）
        const nx = cx + Math.cos(angle) * nameR;
        const ny = cy + Math.sin(angle) * nameR;
        ctx.globalAlpha = 0.6;
        ctx.fillStyle = 'rgba(210,220,240,0.85)';
        ctx.font = `600 ${Math.max(11, Math.round(S * 0.052))}px 'Inter','PingFang SC','Microsoft YaHei',sans-serif`;
        ctx.fillText(trigram.name, nx, ny);
      }
      ctx.globalAlpha = 1;
    }

    // 中央太极（跟随启动配色：阴=主色压暗，阳=辅色提亮，每次启动色调不同）
    const yin = rgba(mix(primary, { r: 10, g: 12, b: 22 }, 0.5), 0.96);
    const yang = rgba(mix(secondary, { r: 255, g: 250, b: 240 }, 0.55), 0.97);
    drawTaiji(ctx, cx, cy, S * 0.27, rotTaiji, yin, yang, secondary);
  }

  function frame(now) {
    if (isTalking()) {
      litIndex = (trigramByTime() + textHash) % 8;
      litIntensity = Math.min(1, litIntensity + 0.10);  // 说话快速点亮
    } else {
      litIntensity = Math.max(0, litIntensity - 0.012); // 安静缓慢恢复
    }
    try { draw(now); } catch (e) { /* 绘制异常不中断循环 */ }
    rafId = requestAnimationFrame(frame);
  }

  function startRenderLoop() { if (!rafId) rafId = requestAnimationFrame(frame); }
  function stopRenderLoop() { if (rafId) { cancelAnimationFrame(rafId); rafId = null; } }

  return {
    setStatus, setExternalVol, setSpeakingText, setViseme,
    startRenderLoop, stopRenderLoop,
    isReady: () => true,
    hasFailed: () => false,
    getState: () => 'ready',
    debug: () => ({ sk, lastVol, litIndex, litIntensity, textHash }),
  };
}
