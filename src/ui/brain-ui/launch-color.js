// launch-color.js —— 助手的「每次启动换色」
//
// 资产 tiny_mascot.riv 有两个颜色输入：primaryColor（主色，含头顶球/全身）、
// secondaryColor（辅色）。每次应用启动随机选一组配色，让助手每次启动颜色不同。
// 主窗口启动时生成本次配色并写入 localStorage；悬浮球窗口读取同一值，保证两处一致。
// 失败时不会重复上次的颜色。

const KEY = 'bailongma.voice.launchColor';

// 16 组配色（primary + secondary），资产默认色（黄·橙）放首位。
const PALETTES = [
  ['#f7d145', '#b23c05'], // 黄 · 砖橙（资产默认色）
  ['#4f8cff', '#22c8c8'], // 蓝 · 青
  ['#39d98a', '#a8e063'], // 绿 · 黄绿
  ['#b098f0', '#f2a6d8'], // 紫 · 粉
  ['#f87171', '#f0c866'], // 红 · 金
  ['#2dd4bf', '#ff9f8a'], // 青 · 珊瑚
  ['#6366f1', '#ff9f1c'], // 靛 · 橙
  ['#ff8a5c', '#ffe066'], // 珊瑚橙 · 明黄
  ['#5ad8ff', '#2f54eb'], // 天蓝 · 靛蓝
  ['#73d13d', '#13c2c2'], // 黄绿 · 青
  ['#f759ab', '#b37feb'], // 粉红 · 紫罗兰
  ['#36cfc9', '#fa8c16'], // 青绿 · 橙
  ['#9254de', '#ffc53d'], // 紫 · 金
  ['#40a9ff', '#52c41a'], // 天蓝 · 苹果绿
  ['#eb2f96', '#faad14'], // 品红 · 琥珀
  ['#722ed1', '#13c2c2'], // 深紫 · 青
];

function paletteFor(idx) {
  const i = ((idx % PALETTES.length) + PALETTES.length) % PALETTES.length;
  const p = PALETTES[i];
  return { primaryColor: p[0], secondaryColor: p[1] };
}

/**
 * 主窗口启动时调用：随机选一组配色（避免与上次重复），写入 localStorage 并返回。
 */
export function initLaunchColor() {
  const prev = Number(localStorage.getItem(KEY));
  let idx = Math.floor(Math.random() * PALETTES.length);
  if (Number.isFinite(prev) && idx === prev && PALETTES.length > 1) {
    idx = (idx + 1) % PALETTES.length; // 保证两次启动不同
  }
  try { localStorage.setItem(KEY, String(idx)); } catch (e) { /* 忽略 */ }
  return paletteFor(idx);
}

/**
 * 读取本次启动的配色（悬浮球窗口用，与主窗口保持一致）。
 * 未初始化（主窗口还没生成）时回退到色板第 0 组（默认黄·橙）。
 */
export function getLaunchColor() {
  const v = Number(localStorage.getItem(KEY));
  return paletteFor(Number.isFinite(v) ? v : 0);
}
