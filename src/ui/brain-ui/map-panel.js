// map-panel.js —— 高德地图面板（对话里通过 map_mode 工具打开）
//
// 支持：以城市/地址/坐标定位、多标记点、按关键词搜索周边 POI。
// 事件流：executor 的 map_mode → SSE map_mode → window 'bailongma:map-mode' → 本模块打开/更新/关闭。
import { createMap, MapServiceError, warmUpMapService } from './map-service.js'

const $ = (id) => document.getElementById(id)

let amapHandle = null   // { AMap, map }
let markers = []
let active = false

function clearMarkers(map) {
  if (!map) return
  for (const m of markers) { try { map.remove(m) } catch {} }
  markers = []
}

function setStatus(text, isError = false) {
  const el = $('map-status')
  if (!el) return
  el.textContent = text
  el.classList.toggle('error', !!isError)
}

// 把 "lng,lat" 坐标串解析成 [lng, lat]，失败返回 null
function parseCoords(text = '') {
  const m = String(text || '').trim().match(/^(-?\d+(?:\.\d+)?)\s*[,，\s]\s*(-?\d+(?:\.\d+)?)$/)
  return m ? [Number(m[1]), Number(m[2])] : null
}

async function geocode(AMap, text) {
  const coords = parseCoords(text)
  if (coords) return { lnglat: new AMap.LngLat(coords[0], coords[1]), address: text }
  if (!AMap.Geocoder) return null
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve(null) } }, 8000)
    try {
      const geocoder = new AMap.Geocoder({ radius: 1000, extensions: 'base' })
      geocoder.getLocation(String(text || '').trim(), (status, result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (status === 'complete' && result?.geocodes?.length) {
          const geo = result.geocodes[0]
          resolve({ lnglat: geo.location, address: geo.formattedAddress || text })
        } else {
          resolve(null)
        }
      })
    } catch (err) {
      if (!settled) { settled = true; clearTimeout(timer); resolve(null) }
    }
  })
}

// 搜索周边 POI，返回 [{ name, lnglat, address }]
async function searchPois(AMap, keyword, city) {
  if (!AMap.PlaceSearch) return []
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve([]) } }, 8000)
    try {
      const placeSearch = new AMap.PlaceSearch({ pageSize: 10, city: city || '全国', extensions: 'base' })
      placeSearch.search(String(keyword || '').trim(), (status, result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (status !== 'complete' || !result?.poiList?.pois?.length) return resolve([])
        resolve(result.poiList.pois.map(p => ({
          name: p.name || '',
          lnglat: p.location,
          address: p.pname + p.cityname + p.adname + (p.address || ''),
        })))
      })
    } catch (err) {
      if (!settled) { settled = true; clearTimeout(timer); resolve([]) }
    }
  })
}

async function openMap({ location = '', title = '', zoom, markers: markerNames = [], keyword = '' } = {}) {
  const canvasEl = $('map-canvas')
  const titleEl = $('map-panel-title')
  const panel = $('map-panel')
  if (!canvasEl || !panel) return

  panel.hidden = false
  active = true
  if (titleEl) titleEl.textContent = title || (location ? `地图 · ${location}` : '地图')
  setStatus('地图加载中…')

  try {
    // 强制 reflow + 等一帧，确保面板显示后地图容器已有真实尺寸，避免 0×0 导致初始化失败。
    void canvasEl.offsetHeight
    await new Promise(r => requestAnimationFrame(r))

    if (!amapHandle) {
      amapHandle = await createMap(canvasEl, { center: [116.397, 39.909], zoom: 12, controls: true })
    }
    const { AMap, map } = amapHandle
    try { map.resize() } catch {}
    await new Promise(r => requestAnimationFrame(r))
    try { map.resize() } catch {}

    // 先把地图立起来（默认视野），定位/标点在后台做，失败不影响地图显示。
    const fallbackCenter = map.getCenter()
    clearMarkers(map)
    map.setZoomAndCenter(zoom && zoom >= 3 && zoom <= 18 ? zoom : 4, fallbackCenter, false, 0)

    // 并行：定位主点 + 搜索周边 POI；都带超时与容错，拿不到就跳过。
    const [centerInfo, poiResults] = await Promise.all([
      location ? geocode(AMap, location).catch(() => null) : Promise.resolve(null),
      keyword ? searchPois(AMap, keyword, (typeof location === 'string' && location.trim()) ? location : '').catch(() => []) : Promise.resolve([]),
    ])

    const pinTexts = Array.isArray(markerNames) ? markerNames.map(String).filter(Boolean) : []
    const targetCount = 1 + pinTexts.length + poiResults.length

    // 中心点：主地址 > POI 首个 > 当前视野
    const useCenter = centerInfo?.lnglat || poiResults[0]?.lnglat || fallbackCenter
    const zoomTarget = Number(zoom) && Number(zoom) >= 3 && Number(zoom) <= 18
      ? Number(zoom)
      : (targetCount > 1 ? 13 : (location ? 13 : 4))

    try { map.setZoomAndCenter(zoomTarget, useCenter, false, 300) } catch {}

    // 主标记
    if (centerInfo?.lnglat) {
      markers.push(new AMap.Marker({
        position: centerInfo.lnglat,
        title: centerInfo.address || (typeof location === 'string' ? location : ''),
        label: { content: '<div class="map-pin-main">📍</div>', direction: 'top' },
      }))
    } else if (useCenter && typeof location === 'string' && location.trim()) {
      markers.push(new AMap.Marker({
        position: useCenter,
        title: location,
        label: { content: '<div class="map-pin-main">📍</div>', direction: 'top' },
      }))
    }

    // 额外标记点（逐个容错）
    for (const name of pinTexts) {
      const info = await geocode(AMap, name).catch(() => null)
      if (info?.lnglat) {
        markers.push(new AMap.Marker({
          position: info.lnglat,
          title: name,
          content: '<div class="map-pin">📍</div>',
        }))
      }
    }
    // 周边 POI
    for (const poi of poiResults.slice(0, 10)) {
      if (!poi.lnglat) continue
      markers.push(new AMap.Marker({
        position: poi.lnglat,
        title: poi.name,
        content: '<div class="map-pin">📍</div>',
      }))
    }
    for (const m of markers) { try { map.add(m) } catch {} }

    if (markers.length > 1) {
      try { map.setFitView(markers, false, [80, 80, 80, 80]) } catch {}
    }

    const parts = []
    if (centerInfo?.address) parts.push(`已定位：${centerInfo.address}`)
    if (poiResults.length) parts.push(`周边「${keyword}」找到 ${poiResults.length} 处`)
    if (markers.length) parts.push(`已标 ${markers.length} 个点`)
    setStatus(parts.join(' · ') || '地图已就绪')
  } catch (err) {
    const msg = err instanceof MapServiceError ? err.message : (err?.message || '未知错误')
    console.warn('[MapPanel] 打开地图失败:', err)
    setStatus('打开地图失败：' + msg, true)
  }
}

function closeMap() {
  if (!active) return
  active = false
  const panel = $('map-panel')
  if (panel) panel.hidden = true
  clearMarkers(amapHandle?.map)
  // 复用 map 实例，不销毁；下次打开直接复用
}

export function initMapPanel() {
  $('map-panel-exit')?.addEventListener('click', closeMap)
  const overlay = $('map-panel')
  overlay?.addEventListener('click', (e) => { if (e.target === overlay) closeMap() })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && active) closeMap() })

  // 预热 AMap 核心，让第一次对话打开地图更流畅（不创建实例，失败静默忽略）
  warmUpMapService().catch(() => {})

  window.addEventListener('bailongma:map-mode', (event) => {
    const detail = event.detail || {}
    if (detail.action === 'hide' || detail.active === false) {
      closeMap()
      return
    }
    openMap({
      location: detail.location || '',
      title: detail.title || '',
      zoom: detail.zoom,
      markers: detail.markers || [],
      keyword: detail.keyword || '',
    })
  })
}
