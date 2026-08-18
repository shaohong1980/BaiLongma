// window-layout.cjs —— 终端流窗口布局算法（自 electron/main.cjs 拆出）
// 纯计算函数：不依赖 Electron screen / BrowserWindow / mainWindow 全局，可单独测试。

const TERMINAL_STREAM_DEFAULT_WIDTH = 560

const TERMINAL_STREAM_DEFAULT_HEIGHT = 830

const TERMINAL_STREAM_MIN_WIDTH = 420

const TERMINAL_STREAM_MIN_HEIGHT = 420

const TERMINAL_STREAM_GAP = 16

const TERMINAL_STREAM_MARGIN = 12

const MAIN_WINDOW_SIDECAR_MIN_WIDTH = 900

const MAIN_WINDOW_SIDECAR_MIN_HEIGHT = 600


function clampNumber(value, min, max) {
  if (max < min) return min
  return Math.max(min, Math.min(max, value))
}
function rectRight(rect) {
  return rect.x + rect.width
}
function rectBottom(rect) {
  return rect.y + rect.height
}
function rectOverlapArea(a, b) {
  if (!a || !b) return 0
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  const x2 = Math.min(rectRight(a), rectRight(b))
  const y2 = Math.min(rectBottom(a), rectBottom(b))
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
}
function roundBounds(bounds) {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  }
}
function fitBoundsToWorkArea(bounds, workArea) {
  const width = clampNumber(
    Math.round(bounds.width || TERMINAL_STREAM_DEFAULT_WIDTH),
    Math.min(TERMINAL_STREAM_MIN_WIDTH, workArea.width),
    workArea.width
  )
  const height = clampNumber(
    Math.round(bounds.height || TERMINAL_STREAM_DEFAULT_HEIGHT),
    Math.min(TERMINAL_STREAM_MIN_HEIGHT, workArea.height),
    workArea.height
  )
  const x = clampNumber(
    Math.round(bounds.x ?? (workArea.x + workArea.width - width - TERMINAL_STREAM_MARGIN)),
    workArea.x,
    workArea.x + workArea.width - width
  )
  const y = clampNumber(
    Math.round(bounds.y ?? (workArea.y + TERMINAL_STREAM_MARGIN)),
    workArea.y,
    workArea.y + workArea.height - height
  )
  return { x, y, width, height }
}
function parseTerminalRequestedBounds(payload = {}) {
  const raw = payload && typeof payload.bounds === 'object' && payload.bounds
    ? payload.bounds
    : payload
  const out = {}
  for (const key of ['x', 'y', 'width', 'height']) {
    const value = Number(raw?.[key])
    if (Number.isFinite(value)) out[key] = value
  }
  return Object.keys(out).length > 0 ? out : null
}
function candidateFromRegion(region, desired, anchor = {}) {
  if (!region || region.width < TERMINAL_STREAM_MIN_WIDTH || region.height < TERMINAL_STREAM_MIN_HEIGHT) return null
  const width = Math.min(desired.width, region.width)
  const height = Math.min(desired.height, region.height)
  return fitBoundsToWorkArea({
    x: anchor.x ?? region.x,
    y: anchor.y ?? region.y,
    width,
    height,
  }, region)
}
function candidateForPlacement(placement, workArea, desired) {
  const width = Math.min(desired.width, workArea.width)
  const height = Math.min(desired.height, workArea.height)
  const cx = workArea.x + Math.round((workArea.width - width) / 2)
  const cy = workArea.y + Math.round((workArea.height - height) / 2)
  const right = workArea.x + workArea.width - width - TERMINAL_STREAM_MARGIN
  const bottom = workArea.y + workArea.height - height - TERMINAL_STREAM_MARGIN
  const left = workArea.x + TERMINAL_STREAM_MARGIN
  const top = workArea.y + TERMINAL_STREAM_MARGIN
  const key = String(placement || '').toLowerCase()

  if (key === 'right') return fitBoundsToWorkArea({ x: right, y: cy, width, height }, workArea)
  if (key === 'left') return fitBoundsToWorkArea({ x: left, y: cy, width, height }, workArea)
  if (key === 'bottom') return fitBoundsToWorkArea({ x: cx, y: bottom, width, height }, workArea)
  if (key === 'top') return fitBoundsToWorkArea({ x: cx, y: top, width, height }, workArea)
  if (key === 'top-left') return fitBoundsToWorkArea({ x: left, y: top, width, height }, workArea)
  if (key === 'top-right') return fitBoundsToWorkArea({ x: right, y: top, width, height }, workArea)
  if (key === 'bottom-left') return fitBoundsToWorkArea({ x: left, y: bottom, width, height }, workArea)
  if (key === 'bottom-right') return fitBoundsToWorkArea({ x: right, y: bottom, width, height }, workArea)
  if (key === 'center') return fitBoundsToWorkArea({ x: cx, y: cy, width, height }, workArea)
  return null
}
function scoreTerminalCandidate(bounds, blockers, mainBounds) {
  const totalOverlap = blockers.reduce((sum, blocker) => sum + rectOverlapArea(bounds, blocker), 0)
  const mainOverlap = rectOverlapArea(bounds, mainBounds)
  const area = Math.max(1, bounds.width * bounds.height)
  return (mainOverlap * 20) + (totalOverlap * 4) - (area / 1000)
}
function terminalFreeRegionCandidates(workArea, desired, mainBounds) {
  if (!mainBounds) return []
  const gap = TERMINAL_STREAM_GAP
  const regions = [
    {
      region: {
        x: rectRight(mainBounds) + gap,
        y: workArea.y,
        width: rectRight(workArea) - rectRight(mainBounds) - gap,
        height: workArea.height,
      },
      anchor: { x: rectRight(mainBounds) + gap, y: mainBounds.y },
    },
    {
      region: {
        x: workArea.x,
        y: workArea.y,
        width: mainBounds.x - workArea.x - gap,
        height: workArea.height,
      },
      anchor: { x: mainBounds.x - gap - desired.width, y: mainBounds.y },
    },
    {
      region: {
        x: workArea.x,
        y: rectBottom(mainBounds) + gap,
        width: workArea.width,
        height: rectBottom(workArea) - rectBottom(mainBounds) - gap,
      },
      anchor: { x: mainBounds.x, y: rectBottom(mainBounds) + gap },
    },
    {
      region: {
        x: workArea.x,
        y: workArea.y,
        width: workArea.width,
        height: mainBounds.y - workArea.y - gap,
      },
      anchor: { x: mainBounds.x, y: mainBounds.y - gap - desired.height },
    },
  ]

  return regions
    .map(item => candidateFromRegion(item.region, desired, item.anchor))
    .filter(Boolean)
}

module.exports = { TERMINAL_STREAM_DEFAULT_WIDTH, TERMINAL_STREAM_DEFAULT_HEIGHT, TERMINAL_STREAM_MIN_WIDTH, TERMINAL_STREAM_MIN_HEIGHT, TERMINAL_STREAM_GAP, TERMINAL_STREAM_MARGIN, MAIN_WINDOW_SIDECAR_MIN_WIDTH, MAIN_WINDOW_SIDECAR_MIN_HEIGHT, clampNumber, rectRight, rectBottom, rectOverlapArea, roundBounds, fitBoundsToWorkArea, parseTerminalRequestedBounds, candidateFromRegion, candidateForPlacement, scoreTerminalCandidate, terminalFreeRegionCandidates }
