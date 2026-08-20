# Brain UI 设计 Token 体系

> 由「方案二：设计 Token 驱动的 UI 重构」落地。借鉴 FormidableLabs/radium 的
> 「集中管理 + 程序化合并 + 状态感知样式」设计思想，但保持零 React 依赖。

## 架构

```
design-tokens.css      ← 唯一事实源（语义/主题 token，CSS 侧）
        │  @import
        ▼
styles.css             ← 组件层样式，一律引用 var(--*)
        │
        ▼
tokens.js              ← JS 镜像（canvas/three/d3 无法读 CSS 变量，走这里）
        ▲
ui-preferences.js      ← themeColors 运行时状态（refreshThemeColors 读全套 token）
        ▲
memory-graph-core.js / bagua.js / knowledge-sphere.js / app.js … 绘图层
```

## 文件职责

| 文件 | 职责 |
|------|------|
| `design-tokens.css` | `:root`（midnight 默认）+ 6 套主题（neon/phosphor/violet/rose/arctic/sand）的语义 token |
| `styles.css`        | 组件样式 + 布局 token（`--sphere-size/--kanban-width/--media-panel-width` 等不随主题变） |
| `tokens.js`         | 主题注册表 `THEMES`、token 清单 `SEMANTIC_TOKENS/SHADOW_TOKENS`、`readThemeTokens()`、颜色工具 `hexToRgb/parseCssColor/rgba/withAlpha/mix/mergeStyles` |
| `ui-preferences.js` | `themeColors`（ESM live binding）+ `refreshThemeColors()` 读全套 token |
| `with-states.js`    | 借鉴 Radium「状态感知样式」：监听 hover/focus/active → 写 `data-state` 属性 |

## 语义色 token（核心）

| 分组 | token | 含义 |
|------|-------|------|
| 背景 | `--bg0` `--bg1` `--bg-deep` | 面板底 / 面板底二 / 全局最底 |
| 文字 | `--ink` `--ink2` `--dim` | 主 / 次 / 弱 |
| 描边 | `--line` `--line-strong` | 分隔线 / 强调描边 |
| 面板 | `--panel` `--panel-raised` `--console-bg` | 面板 / 抬升 / 控制台底色 |
| 强调 | `--cool` `--warm` | 品牌冷 / 暖色 |
| 语义 | `--ok` `--warn` `--danger` | 成功 / 警告 / 危险 |
| 图谱 | `--node-low` `--node-high` | 节点低 / 高重要度 |
| 辉光 | `--glow-halo` `--glow-tint1` `--glow-tint2` `--link-stroke` | 记忆球辉光与连线 |
| 阴影 | `--shadow-soft` `--shadow-console` `--shadow-pop` `--shadow-inset` | 阴影层级 |

## canvas 与 DOM 配色统一

- `ui-preferences.js` 的 `refreshThemeColors()` 每次切主题后读取全部 token。
- `memory-graph-core.js` 的 `resolveNodeColor(type)`：语义主色（self/conversation/
  knowledge/system/task_complete/behavioral_constraint）跟随主题 token，
  其余走固定分类调色板保住多色区分度；`renderLegend` 与其共用，图例颜色一致。
- `bagua.js` 太极画布每帧从 `themeColors.cool/warm` 取色，切主题即时生效。

## with-states 用法

```js
import { withStates } from "./with-states.js";
const off = withStates(btnEl); // 写入 data-state="hover/focus/active"
off();                          // 卸载
```

样式侧用 `[data-state~="hover"]` 子串匹配，与语义状态（busy/empty/open…）不冲突。
当前接入点：`physics-toggle` / `reset-view-btn`（图谱控制按钮，聚焦环用 `--cool` token）。

## 注意事项

- 新增语义色必须先在 `design-tokens.css` 定义，再在 `tokens.js` 的 `SEMANTIC_TOKENS` 登记；
- 布局/尺寸 token（不随主题变化）留在 `styles.css` 组件作用域，勿放入 `design-tokens.css`；
- 不要在组件样式里直接写语义色魔数，引用 `var(--*)` 即可同时获得主题适配。
