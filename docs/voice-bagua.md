# 语音球 · 玄幻太极八卦图（voice-bagua）

## 概述

左上角的角色形象（原先是 Rive 小助手/语音球）被替换为一张 **玄幻风格的太极八卦图**，作为语音助手的「脸」：

- 中央是**标准太极阴阳鱼**（修正版，S 曲线两半圆圆心在大圆竖直半径中点 `(0, ±r/2)`），带辉光、渐变，缓慢自转。
- 外围一圈 **8 个先天八卦**（乾☰兑☱离☲震☳巽☴坎☵艮☶坤☷），每个卦象 3 爻大而清晰，并标注卦名。
- 整图缓慢旋转，背景点缀旋转星尘 + 外圈柔光。
- **说话时**（用户发言 / Agent 播报 TTS），按「时间卦 + 说话内容哈希」算出对应卦象并点亮（爻线变亮、光晕、显示「卦名 · 五行」），安静后亮度缓慢恢复。

> 原 `voice-rive.js`（Rive 小助手）仍保留，供悬浮球窗口（`voice-orb.html`）使用；主窗口改用本渲染器。

---

## 文件清单

| 文件 | 作用 |
|---|---|
| `src/ui/brain-ui/voice-bagua.js` | **核心渲染器**：绘制太极八卦图 + 说话点亮逻辑（本文档主体） |
| `src/ui/brain-ui/voice-panel.js` | 编排层：组装 voice-core + 渲染器；转发状态/音量/说话内容 |
| `src/ui/brain-ui/launch-color.js` | 启动配色：16 套配色，每次启动随机选一套（避免与上次重复） |
| `src/ui/brain-ui/styles.css` | `#voice-canvas` 尺寸（`min(300px, 88%)`）、圆形裁剪 `border-radius: 50%` |
| `src/ui/brain-ui/app.js` | TTS 播报时把说话文本推给渲染器（`window.bailongmaVoice.setSpeakingText`） |

---

## 架构与数据流

```
voice-core.js（会话引擎：麦克风/ASR/TTS 打断）
    │ 每帧
    ├─ renderer.setStatus(sk)        状态：idle/listening/recognizing/speaking/...
    ├─ renderer.setExternalVol(vol)  音量 0..1
    └─ renderer.startRenderLoop()    启动 rAF 绘制循环

voice-panel.js（编排）
    ├─ core.setOnTranscript(...) → renderer.setSpeakingText(msg)  用户转写内容
    └─ window.bailongmaVoice.setSpeakingText(text)                 Agent TTS 文本

app.js（TTS 文本注入）
    └─ startTTSVisemeLoop() → window.bailongmaVoice.setSpeakingText(ttsVisemeText())
```

渲染器与 voice-rive 接口完全一致，voice-core 的会话逻辑（麦克风、ASR、TTS 打断、barge-in）不受影响，只是「脸」换了。

---

## 渲染器接口（`createVoiceBagua`）

`src/ui/brain-ui/voice-bagua.js` 导出 `createVoiceBagua({ canvas, primaryColor, secondaryColor })`，返回：

| 方法 | 说明 |
|---|---|
| `setStatus(sk)` | 设置语音状态（驱动说话判定） |
| `setExternalVol(v)` | 设置音量 0..1 |
| `setSpeakingText(text)` | 喂入说话内容（用户转写 / TTS 文本），用于计算卦象 |
| `setViseme(code)` | 口型数据，卦图不需要，no-op |
| `startRenderLoop()` / `stopRenderLoop()` | 启动/停止 rAF 绘制循环 |
| `isReady()` / `hasFailed()` / `getState()` | 状态查询（始终 ready） |
| `debug()` | 调试：返回 `{ sk, lastVol, litIndex, litIntensity, textHash }` |

---

## 绘制细节

### 太极（`drawTaiji`）
标准构造，两个 S 曲线半圆的**圆心在大圆竖直半径中点 `(0, -r/2)` 与 `(0, r/2)`**：

1. 右半阳（亮色）、左半阴（暗色）。
2. 圆心 `(0,-r/2)` 的右半圆 → 黑鱼头（右上）；圆心 `(0,r/2)` 的左半圆 → 白鱼头（左下）。
3. 鱼眼（白点在黑鱼头、黑点在白鱼头）。
4. 外缘用辅色辉光描边 + 背后柔光。

颜色跟随启动配色：**阴 = 主色压暗**（`mix(primary, 深色, 0.5)`）、**阳 = 辅色提亮**（`mix(secondary, 暖白, 0.55)`），每次启动色调不同。

### 八卦（`drawTrigram`）
8 个先天八卦按圆周排布，卦象自内（初爻）向外（上爻）径向排布：
- 每爻是一段**垂直于半径的短线**；阳爻整段、阴爻断开两段。
- 阴爻缺口必须明显（`gap = segLen * 0.34`），且爻线用 `lineCap='butt'`（平头），否则圆头会把缺口填上、8 卦看起来一样。
- 爻线带 `shadowBlur` 微光；点亮时用辅色、更亮、光晕更大。

### 玄幻氛围
- `drawStardust`：26 颗星尘绕中心漂移 + 轻微闪烁。
- `drawAura`：卦环外圈一圈径向渐变柔光。
- 爻线 / 太极外缘 / 亮起卦名均带 `shadowBlur` 辉光。

### 布局与边界（都在圆形画布内，文字不被裁剪）
画布 `S × S`（约 314px），中心 `(S/2, S/2)`：

| 元素 | 半径 |
|---|---|
| 太极 | `0.27S` |
| 卦环爻线带 | `0.31S ～ 0.40S` |
| 卦名（8 个小字） | `0.43S` |
| 亮起卦名「卦名 · 五行」 | `0.465S`，**沿切线方向旋转**并归一化到 `[-90°, +90°]` 保持文字直立 |

canvas buffer 通过 `getBoundingClientRect()` 对齐实际显示尺寸（避免高 DPI / 布局差异导致发虚）。

---

## 点亮逻辑

**说话判定**（`isTalking`）：`sk === 'speaking'`（Agent 播报），或 `sk` 为 `recognizing/listening` 且 `lastVol > 0.04`（用户说话）。

**定位卦象**（每帧）：
```
litIndex = (trigramByTime() + hashText(说话内容)) % 8
```
- **时间卦** `trigramByTime()`：24 小时 ÷ 8 卦 = **每卦 3 小时**，随时间缓慢轮换。
- **内容哈希** `hashText()`：FNV-1a 对说话内容取哈希 → 0..7。

**亮度曲线**：
- 说话时 `litIntensity` 快速上升（每帧 +0.10），该卦爻线变亮、外圈光晕出现、显示「卦名 · 五行」。
- 安静后 `litIntensity` 缓慢衰减（每帧 -0.012），亮度慢慢恢复、光晕熄灭。

---

## 配色系统（launch-color.js）

16 套 `[主色, 辅色]` 配色：

```
黄·砖橙  蓝·青  绿·黄绿  紫·粉  红·金  青·珊瑚  靛·橙
珊瑚橙·明黄  天蓝·靛蓝  黄绿·青  粉红·紫罗兰  青绿·橙  紫·金
天蓝·苹果绿  品红·琥珀  深紫·青
```

- `initLaunchColor()`：**每次应用启动随机选一套**，存入 `localStorage['bailongma.voice.launchColor']`，并**避免与上次重复**。
- `getLaunchColor()`：读取本次启动配色（悬浮球窗口等使用）。
- 八卦图用法：爻线/星尘/光晕/外圈用**主色**，太极外缘/亮起卦/亮起卦名用**辅色**，太极阴阳鱼由主/辅色派生。

---

## 集成点

| 位置 | 做了什么 |
|---|---|
| `voice-panel.js` | `createVoiceBagua({ canvas, ...initLaunchColor() })` 替换原 `createVoiceRive`；`core.setOnTranscript` 里 `renderer.setSpeakingText?.(msg)`；`window.bailongmaVoice` 暴露 `setSpeakingText` |
| `app.js` | `startTTSVisemeLoop()` → `window.bailongmaVoice?.setSpeakingText?.(ttsVisemeText())`；`stopTTSVisemeLoop()` → `setSpeakingText('')` |
| `styles.css` | `#voice-canvas { width: min(300px, 88%); aspect-ratio: 1; border-radius: 50% }` |

---

## 自定义参数速查

| 想改什么 | 位置 |
|---|---|
| 卦环/太极转速 | `draw()` 里 `rotRing`、`rotTaiji`（rad/s） |
| 卦环半径、卦名位置 | `innerR`、`outerR`、`nameR`（相对画布 `S`） |
| 点亮 / 恢复速度 | `frame()` 里 `+0.10` / `-0.012` |
| 说话判定音量阈值 | `isTalking()` 里 `lastVol > 0.04` |
| 时间卦周期 | `trigramByTime()` 里 `3 * 60 * 60 * 1000` |
| 配色数量/颜色 | `launch-color.js` 的 `PALETTES` 数组 |
| 画布大小 | `styles.css` 的 `#voice-canvas` 宽度 |

---

## 常见问题排查

- **8 卦看起来都一样**：检查爻线 `lineCap` 是否为 `'butt'`、阴爻缺口 `gap` 是否足够大（圆头 `'round'` 会填平缺口）。
- **文字被圆形裁掉**：检查各元素半径是否都在 `0.5S` 内；亮起卦名必须沿切线旋转（否则左右位置会超界）。
- **每次启动颜色不变**：确认 `initLaunchColor()` 被调用并写入 localStorage；删除 `bailongma.voice.launchColor` 后重启会重新随机。
- **说话不点亮**：确认 `setStatus` / `setExternalVol` 由 voice-core 每帧推送；用户说话内容经 `setSpeakingText` 注入；可看 `debug()` 的 `litIndex`/`litIntensity`。
