# 记忆图谱 · 神经网络风格知识图谱（knowledge-sphere）

## 概述

界面中央的记忆图谱（原 D3/SVG 力导向图 → 3D 球体图谱）被进一步改造成**神秘、有机的神经网络风格**：

- 节点 = **神经元胞体**（柔和渐隐、缓慢呼吸、颜色与左侧图例一致）
- 连线 = **弯曲的神经纤维**（二阶贝塞尔，像轴突在云团外缘拱起）
- **神经信号**：亮点沿纤维传播，模拟神经网络放电（自发放电 + 被使用节点放射信号）
- 背景：中心能量核 + 远景星云 + 星尘尘埃，**无机械线框球壳**
- 节点分布为**柔和壳层带**（0.82R–1.12R），形成有机云团而非机械薄壳

WebGL 不可用时自动回退到 2D Canvas 渲染（`KnowledgeSphere2D`，物理与 3D 一致，绘制简化）。

---

## 文件清单

| 文件 | 作用 |
|---|---|
| `src/ui/brain-ui/knowledge-sphere.js` | **核心**：3D 神经网络图谱渲染器（`KnowledgeSphere`）+ 2D 回退（`KnowledgeSphere2D`） |
| `src/ui/brain-ui/app.js` | 数据与交互编排：加载记忆、增量新增、高亮、物理滑杆、SSE 接线 |
| `src/ui/brain-ui/app-shell.js` | `#graph` 元素由 `<svg>` 改为 `<canvas>` |
| `src/ui/brain-ui/styles.css` | `#graph` canvas 全屏样式、触摸/光标 |

---

## 架构与数据流

```
app.js（编排）
  ├─ loadMemories()     拉取 /memories?limit=500 → nodeData/linkData
  ├─ addNewNodes()      SSE memories_written → 增量新增节点
  ├─ initKnowledgeSphere() 动态 import knowledge-sphere.js → KnowledgeSphere
  ├─ highlightNodes()   记忆召回(SSE injector_result)/点击/新记忆 → sphere.highlight()
  └─ applyPhysicsSettings()  引力/斥力/节点大小滑杆 → sphere.setPhysics()

KnowledgeSphere（渲染 + 物理）
  ├─ setData(nodes, links) / addNodes()  数据注入，重建场景
  ├─ highlight(nids, duration)  依次点亮 + 放射神经信号
  ├─ setPhysics(params)  更新引力/斥力/节点大小
  ├─ resetView() / resize() / pause() / resume()
  └─ 自研 3D 力学 + WebGL 渲染循环
```

---

## 渲染器 API（`KnowledgeSphere`）

| 方法 | 说明 |
|---|---|
| `setData(nodes, links, alpha)` | 全量设置节点/连线，重建场景并重启布局 |
| `addNodes(newNodes, links)` | 增量新增节点并重建连线 |
| `highlight(nids, duration)` | 依次点亮节点（先召回的先亮、缓慢恢复），并让被使用节点向相连纤维放射信号 |
| `nudge(nodes)` / `nudgeAll()` | 抽动部分节点（活物感，由 app.js 定时触发） |
| `setPhysics(params)` | 更新 `{ gravity, repulsion, nodeSize }` 并刷新 |
| `refreshVisuals()` | 主题/图例色刷新（shell/核心/星云/节点） |
| `resetView()` | 复位相机角度/距离，重新摊开布局 |
| `pause()` / `resume()` | 页面隐藏时暂停/恢复渲染（省 GPU） |
| `resize(w,h)` | 窗口尺寸对齐 |
| `dispose()` | 释放资源 |

---

## 神经网络视觉细节

### 神经元节点
- 贴图 `makeNeuronTexture`：中心实色、`0.4` 处 0.92、`0.72` 处 0.38、边缘渐隐——像神经元胞体，非机械硬边圆点。
- **缓慢呼吸**：每帧 `breath = 1 + 0.06·sin(...)`，每个节点相位/频率不同（±6%），模拟神经网络安静时的活性，不刺眼。
- 颜色与左侧栏图例一致（`nodeColor` 返回同一套 `NODE_TYPE_COLORS`），核心节点暖色、对话记忆白色。
- 连接度高的节点更大（枢纽神经元）。
- 悬停放大、被使用时放大 + 光晕点亮。

### 神经纤维（连线）
- 每根连线 = **10 段二阶贝塞尔曲线**（`_bezierAt`），控制点 = 中点沿半径外推 `len * 0.26`（`_linkControl`）——纤维在云团外缘拱起。
- 加法混合发光，按连线类型区分亮度：
  - `visual_parent`（父链接）：0.5
  - `visual_random`（视觉随机）：0.16
  - 语义链接：0.34

### 神经信号（放电）
- `_spawnSignal(link, fromEnd)`：在纤维上产生一个沿曲线传播的亮点。
- **自发放电**：约每 260ms 随机点燃一条纤维（`_updateSignals`），信号沿曲线推进、到端消失。
- **被使用节点放射信号**：`highlight()` 时，被点亮节点向相连的最多 4 条纤维发出信号（正/反向各方向）。
- 信号用 `THREE.Points`（最多 26 个）渲染，带发光贴图。

### 神秘背景
- **中心能量核** `coreGlow`：柔和暖色光晕，缓慢呼吸（`opacity 0.09+0.07·sin`）。
- **远景星云** `nebulaGroup`：4 片远离中心的极淡辉光，缓慢旋转。
- **星空** `stars`：2400 颗更小更暗的尘埃点。
- **星尘** `dustGroup`：云团内部 150 颗漂浮粒子，反向缓旋。

---

## 物理与布局

自研轻量 3D 力学（`_stepPhysics`），每帧在 rAF 中积分：

| 力 | 说明 |
|---|---|
| 壳层吸附 | 把节点拉到「柔和壳层带」`0.82R–1.12R`（`targetFactor` 由引力滑杆调节，越大越向球心收缩） |
| 连边弹簧 | 相连节点沿弦拉近，形成有机簇 |
| 软斥力/碰撞 | 节点间距控制（斥力滑杆放大/缩小 `minDist`） |

- **引力滑杆**：控制节点向球心收拢程度（高引力 → 密实内核，低 → 铺满壳层）。
- **斥力滑杆**：控制节点间距（高 → 均匀分布，低 → 扎堆）。
- 布局阶段（`alpha>0`）运行，安静后停止省 CPU；节点多时斥力降频跑。
- 重力还影响自动旋转速度。

---

## 点亮/高亮逻辑

`highlight(nids, duration)`：
- 按传入顺序给每个节点一个延迟（`delay = i * step`），实现**依次点亮**。
- 亮度曲线（`_highlightIntensity`）：快速点亮（≈250ms）→ 保持明亮（45% 时长）→ 二次缓出**缓慢恢复**。
- 触发场景：记忆召回（SSE `injector_result`，10s）、新记忆写入（10s）、点击节点（1.4s）。

---

## 配色

- 图谱颜色来自 CSS 主题变量（`themeColors`：cool / warm / linkStroke 等），随界面主题切换。
- **节点颜色 = 左侧栏图例色**（同一 `NODE_TYPE_COLORS` 调色板），关闭了 WebGL 色调映射（`NoToneMapping`）保证颜色严格一致。
- 核心光晕用 warm、星云用 cool/warm/蓝紫混合。

---

## 集成点（app.js）

| 位置 | 做了什么 |
|---|---|
| `initKnowledgeSphere()` | 动态 import，3D 失败自动回退 2D；暴露 `window.__knowledgeSphere` 调试句柄 |
| `loadMemories()` | 拉取记忆 → `nodeData`/`linkData` → `sphere.setData()` |
| `addNewNodes()` | SSE 新增 → `sphere.addNodes()` + 高亮新节点 |
| `highlightNodes()` | 封装 `sphere.highlight()` |
| 物理滑杆 | `applyPhysicsSettings()` → `sphere.setPhysics()` + 重启布局 |
| 主题切换 | `applyTheme()` → `sphere.refreshVisuals()` |

---

## 自定义参数速查

| 想改什么 | 位置 |
|---|---|
| 神经元呼吸幅度 | `_writeNodeSprites` 里 `breath = 1 + 0.06·sin(...)` |
| 纤维弯曲程度 | `_linkControl` 里 `bulge = len * 0.26` |
| 纤维分段数 | `_rebuildLinks` / `_writeLinkPositions` 里 `SEG = 10` |
| 自发放电频率 | `_updateSignals` 里 `now - this._signalTimer > 260` |
| 信号速度 | `_spawnSignal` 里 `speed: 0.006 + ...` |
| 壳层带厚度 | `_stepPhysics` 里 `0.82 + 0.3·(...)` |
| 球体大小/相机距离 | `_computeRadius` 里 `radius` / `camDist` 公式 |
| 星云数量/位置 | `_buildNebulae` |

---

## 排查要点

- **看不到图谱**：确认 `bailongma-memory-graph-enabled` 为 true（设置里开关）；看控制台 `[graph] 已启用 3D/2D` 日志。
- **颜色与图例不一致**：检查渲染器是否 `NoToneMapping`；节点色走 `nodeColor()`。
- **太机械**：确认无线框 `shell/shell2`、连线是曲线（`SEG>1`）、布局是壳层带（非薄壳）。
- **引力/斥力滑杆无效**：滑杆会重启布局（`alpha=1`），观察 2–3 秒重排；节点已在平衡态时变化不明显属正常。
- **性能**：节点多（>600）时斥力自动降频；页面隐藏会自动暂停渲染。
