// with-states.js —— 借鉴 Radium「状态感知样式」思路的零依赖工具（非 React）
// Radium 通过 HOC 给 React 组件注入 :hover/:focus/:active 状态并合并进 style 对象；
// 本模块给原生 DOM 元素提供等价能力：监听交互事件 → 写入空格分隔的
// data-state 属性（hover/focus/active），样式层用 [data-state~="hover"] 等选择器消费。
// 之所以用 ~= 子串匹配：data-state 还承载语义状态（busy/empty/open…），互不冲突。
//
// 用法：
//   import { withStates } from "./with-states.js";
//   const off = withStates(el, { hover: true, focus: true, active: true });
//   // 之后 el.getAttribute("data-state") → "hover" / "focus active" / ""
//   off();  // 卸载监听并清除状态
//
// 附带 Radium 风格样式工具：
//   mergeStyles(...objs)          —— 后项覆盖前项（与 tokens.js 同款，此处再导出）
//   styleObjectToCss(selector, o) —— 把 JS 样式对象编译成 CSS 文本（等价 Radium css-rule-set-to-string）

const BOUND = new WeakMap();

function bind(target, type, handler) {
  target.addEventListener(type, handler);
  return () => target.removeEventListener(type, handler);
}

export function withStates(el, opts = {}) {
  if (!el) return () => {};
  if (BOUND.has(el)) return BOUND.get(el);

  const states = new Set();
  const emit = () => {
    el.setAttribute("data-state", Array.from(states).join(" "));
  };
  const add = (s) => { states.add(s); emit(); };
  const drop = (s) => { states.delete(s); emit(); };

  const cleanup = [];
  if (opts.hover !== false) {
    cleanup.push(bind(el, "mouseenter", () => add("hover")));
    cleanup.push(bind(el, "mouseleave", () => drop("hover")));
  }
  if (opts.focus !== false) {
    cleanup.push(bind(el, "focusin", () => add("focus")));
    cleanup.push(bind(el, "focusout", () => drop("focus")));
  }
  if (opts.active !== false) {
    cleanup.push(bind(el, "pointerdown", () => add("active")));
    cleanup.push(bind(window, "pointerup", () => drop("active")));
    cleanup.push(bind(el, "pointercancel", () => drop("active")));
  }

  const off = () => { cleanup.forEach(fn => fn()); BOUND.delete(el); };
  BOUND.set(el, off);
  return off;
}

// 借鉴 Radium 样式对象合并：浅合并，数组/对象取末项（与 tokens.js mergeStyles 一致，此处保留本模块自足）
export function mergeStyles(...objs) {
  return Object.assign({}, ...objs.filter(Boolean));
}

// JS 样式对象 → CSS 文本（属性 camelCase → kebab-case；数字自动补 px 的规则与浏览器一致）
function toKebab(name) {
  return name.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
}
function styleValue(name, value) {
  if (typeof value === "number" && !/^(zIndex|opacity|flex|lineHeight|fontWeight|zoom)$/.test(name)) {
    return `${value}px`;
  }
  return String(value);
}

export function styleObjectToCss(selector, styleObj, opts = {}) {
  const lines = Object.entries(styleObj || {})
    .map(([k, v]) => `  ${toKebab(k)}: ${styleValue(k, v)};`)
    .join("\n");
  const states = opts.states;
  if (!states || !states.length) {
    return `${selector} {\n${lines}\n}`;
  }
  // Radium 风格：把 :hover/:focus/:active 状态直接写在同一个 style 对象里 → 展开成多个选择器
  const base = styleObj || {};
  const out = [`${selector} {\n${lines}\n}`];
  states.forEach(s => {
    const st = base[s];
    if (!st) return;
    const sub = Object.entries(st).map(([k, v]) => `  ${toKebab(k)}: ${styleValue(k, v)};`).join("\n");
    out.push(`${selector}[data-state~="${s}"] {\n${sub}\n}`);
  });
  return out.join("\n\n");
}
