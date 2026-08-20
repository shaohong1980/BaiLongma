// ui-preferences.js —— 界面偏好：图谱物理参数 + 主题色（自 app.js 拆出）
// 纯状态 + 纯函数（读 CSS 变量 / localStorage），不依赖 app.js 的 DOM/canvas。
// physicsSettings / themeColors 是可变状态；app.js 通过 ESM live binding 读取，
// 模块内更新（readPhysicsSettings / refreshThemeColors）后 app.js 立即看到新值。
// 依赖 tokens.js（单向）：refreshThemeColors 用其 readThemeTokens 读取全套语义 token。

import { readThemeTokens } from "./tokens.js";

export const physicsSettings = {
  gravity: 1,
  repulsion: 1.35,
  nodeSize: 1,
};

export let themeColors = {};

const PHYSICS_STORAGE_KEY = "jarvis-brain-ui-physics";

export function readCSSVar(name) {
  return getComputedStyle(document.body).getPropertyValue(name).trim();
}

export function readPhysicsSettings() {
  try {
    const raw = localStorage.getItem(PHYSICS_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.gravity === "number") physicsSettings.gravity = parsed.gravity;
      if (typeof parsed.repulsion === "number") physicsSettings.repulsion = parsed.repulsion;
      if (typeof parsed.nodeSize === "number") physicsSettings.nodeSize = parsed.nodeSize;
    }
  } catch {}
}

export function savePhysicsSettings() {
  try {
    localStorage.setItem(PHYSICS_STORAGE_KEY, JSON.stringify(physicsSettings));
  } catch {}
}

export function refreshThemeColors() {
  // 读取全套语义 + 阴影 token（含原 8 项：cool/warm/nodeLow/nodeHigh/dim/ink2/linkStroke/bg0）
  themeColors = readThemeTokens();
}
