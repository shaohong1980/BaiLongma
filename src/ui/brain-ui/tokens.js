// tokens.js —— Brain UI 设计 Token 的 JS 镜像
// · CSS 侧唯一事实源是 design-tokens.css；本模块给 canvas/three/d3 等
//   无法读 CSS 变量的绘图层提供 JS 侧统一入口。
// · 借鉴 Radium 的设计思想：token 集中管理、程序化合并、状态感知。
//   但保持零 React 依赖，纯 ES Module。
// · 依赖方向：ui-preferences.js → tokens.js（单向），tokens.js 自包含。

export function readCSSVar(name) {
  return getComputedStyle(document.body).getPropertyValue(name).trim();
}

// —— 主题注册表（与 design-tokens.css 的 [data-theme] 对应；midnight 为默认 :root）——
export const THEMES = {
  midnight: { label: "Midnight Steel", css: "" },
  neon:     { label: "Neon 霓虹",      css: "neon" },
  phosphor: { label: "Phosphor CRT",   css: "phosphor" },
  violet:   { label: "Violet Lab",     css: "violet" },
  rose:     { label: "Rose Dusk",      css: "rose" },
  arctic:   { label: "Arctic",         css: "arctic" },
  sand:     { label: "Warm Sand",      css: "sand" },
};

// —— 语义 token 清单（与 design-tokens.css :root 一一对应）——
export const SEMANTIC_TOKENS = {
  bg0:         "--bg0",
  bg1:         "--bg1",
  bgDeep:      "--bg-deep",
  ink:         "--ink",
  ink2:        "--ink2",
  dim:         "--dim",
  line:        "--line",
  lineStrong:  "--line-strong",
  panel:       "--panel",
  panelRaised: "--panel-raised",
  consoleBg:   "--console-bg",
  cool:        "--cool",
  warm:        "--warm",
  ok:          "--ok",
  warn:        "--warn",
  danger:      "--danger",
  nodeLow:     "--node-low",
  nodeHigh:    "--node-high",
  glowHalo:    "--glow-halo",
  glowTint1:   "--glow-tint1",
  glowTint2:   "--glow-tint2",
  linkStroke:  "--link-stroke",
};

export const SHADOW_TOKENS = {
  shadowSoft:    "--shadow-soft",
  shadowConsole: "--shadow-console",
  shadowPop:     "--shadow-pop",
  shadowInset:   "--shadow-inset",
};

export const ALL_TOKENS = { ...SEMANTIC_TOKENS, ...SHADOW_TOKENS };

// 读取当前主题下全部 token（运行时，从 computed style）
export function readThemeTokens() {
  const out = {};
  for (const [key, cssVar] of Object.entries(ALL_TOKENS)) {
    out[key] = readCSSVar(cssVar);
  }
  return out;
}

// —— 颜色工具（Radium 式纯函数，供 canvas / three / d3 使用）——
export function hexToRgb(hex) {
  if (typeof hex !== "string") return { r: 0, g: 0, b: 0 };
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map(c => c + c).join("");
  const num = parseInt(h, 16);
  if (Number.isNaN(num)) return { r: 0, g: 0, b: 0 };
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

export function parseCssColor(css) {
  const s = String(css || "").trim();
  if (s.startsWith("#")) return { ...hexToRgb(s), a: 1 };
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(",").map(x => parseFloat(x.trim()));
    return { r: p[0] || 0, g: p[1] || 0, b: p[2] || 0, a: p.length > 3 ? p[3] : 1 };
  }
  return { r: 0, g: 0, b: 0, a: 1 };
}

export function rgba(c, a) {
  return `rgba(${c.r},${c.g},${c.b},${a})`;
}

export function withAlpha(cssColor, a) {
  return rgba(parseCssColor(cssColor), a);
}

// 线性混合两个 CSS 颜色；t=0 → a，t=1 → b
export function mix(a, b, t) {
  const ca = parseCssColor(a), cb = parseCssColor(b);
  return {
    r: Math.round(ca.r + (cb.r - ca.r) * t),
    g: Math.round(ca.g + (cb.g - ca.g) * t),
    b: Math.round(ca.b + (cb.b - ca.b) * t),
    a: ca.a + (cb.a - ca.a) * t,
  };
}

// 借鉴 Radium 的样式对象合并：后项覆盖前项（浅合并，遇数组取末项）
export function mergeStyles(...objs) {
  return Object.assign({}, ...objs.filter(Boolean));
}
