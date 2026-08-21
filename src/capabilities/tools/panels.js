// panels.js —— 面板 / 界面控制工具（自 src/capabilities/executor.js 拆出）
// 职责：hotspot / worldcup / typhoon / bagua / map / 文档面板 / 人物卡片 的模式控制。
import { emitEvent } from "../../events.js"
import { setHotspotPanelState, getHotspotPanelState } from "../../hotspots.js"
import { setWorldcupPanelState, getWorldcupPanelState } from "../../worldcup.js"
import { setTyphoonPanelState, getTyphoonPanelState } from "../../typhoon.js"
import { setBaguaPanelState, getBaguaPanelState } from "../../bagua.js"
import { setPersonCardPanelState, getPersonCardPanelState, getPersonCard } from "../../person-cards.js"
import { setDocPanelState } from "../../docs.js"
import { getMapServiceSettings } from "../../map-service.js"
import path from 'path'
import { SANDBOX_ROOT, isPathInside } from '../sandbox.js'

function toolJson(payload) {
  return JSON.stringify(payload, null, 2)
}

export function execHotspotMode(args = {}) {
  const action = String(args.action || 'status').trim().toLowerCase()
  if (!['show', 'open', 'hide', 'close', 'toggle', 'status'].includes(action)) {
    return JSON.stringify({ ok: false, tool: 'hotspot_mode', error: 'unsupported action' })
  }

  let nextActive = null
  if (action === 'show' || action === 'open') nextActive = true
  if (action === 'hide' || action === 'close') nextActive = false
  if (action === 'toggle') nextActive = !getHotspotPanelState().active

  const state = typeof nextActive === 'boolean'
    ? setHotspotPanelState({ active: nextActive, source: 'agent_tool' })
    : getHotspotPanelState()

  if (typeof nextActive === 'boolean') {
    emitEvent('hotspot_mode', {
      action: state.active ? 'show' : 'hide',
      active: state.active,
      reason: typeof args.reason === 'string' ? args.reason : '',
    })
    emitEvent('action', {
      tool: 'hotspot_mode',
      summary: state.active ? '打开热点面板' : '关闭热点面板',
      detail: args.reason || '',
    })
  }

  return JSON.stringify({ ok: true, tool: 'hotspot_mode', state })
}

export function execWorldcupMode(args = {}) {
  const action = String(args.action || 'status').trim().toLowerCase()
  if (!['show', 'open', 'hide', 'close', 'toggle', 'status'].includes(action)) {
    return JSON.stringify({ ok: false, tool: 'worldcup_mode', error: 'unsupported action' })
  }

  let nextActive = null
  if (action === 'show' || action === 'open') nextActive = true
  if (action === 'hide' || action === 'close') nextActive = false
  if (action === 'toggle') nextActive = !getWorldcupPanelState().active

  const state = typeof nextActive === 'boolean'
    ? setWorldcupPanelState({ active: nextActive, source: 'agent_tool' })
    : getWorldcupPanelState()

  if (typeof nextActive === 'boolean') {
    emitEvent('worldcup_mode', {
      action: state.active ? 'show' : 'hide',
      active: state.active,
      reason: typeof args.reason === 'string' ? args.reason : '',
    })
    emitEvent('action', {
      tool: 'worldcup_mode',
      summary: state.active ? '打开世界杯面板' : '关闭世界杯面板',
      detail: args.reason || '',
    })
  }

  return JSON.stringify({ ok: true, tool: 'worldcup_mode', state })
}

export function execTyphoonMode(args = {}) {
  const action = String(args.action || 'status').trim().toLowerCase()
  if (!['show', 'open', 'hide', 'close', 'toggle', 'status'].includes(action)) {
    return JSON.stringify({ ok: false, tool: 'typhoon_mode', error: 'unsupported action' })
  }
  let nextActive = null
  if (action === 'show' || action === 'open') nextActive = true
  if (action === 'hide' || action === 'close') nextActive = false
  if (action === 'toggle') nextActive = !getTyphoonPanelState().active
  const state = typeof nextActive === 'boolean'
    ? setTyphoonPanelState({ active: nextActive, source: 'agent_tool' })
    : getTyphoonPanelState()
  if (typeof nextActive === 'boolean') {
    emitEvent('typhoon_mode', { action: state.active ? 'show' : 'hide', active: state.active, reason: typeof args.reason === 'string' ? args.reason : '' })
    emitEvent('action', { tool: 'typhoon_mode', summary: state.active ? '打开台风监测面板' : '关闭台风监测面板', detail: args.reason || '' })
  }
  return JSON.stringify({ ok: true, tool: 'typhoon_mode', state })
}

export function execBaguaMode(args = {}) {
  const action = String(args.action || 'status').trim().toLowerCase()
  if (!['show', 'open', 'hide', 'close', 'toggle', 'status'].includes(action)) {
    return JSON.stringify({ ok: false, tool: 'bagua_mode', error: 'unsupported action' })
  }
  let nextActive = null
  if (action === 'show' || action === 'open') nextActive = true
  if (action === 'hide' || action === 'close') nextActive = false
  if (action === 'toggle') nextActive = !getBaguaPanelState().active
  const state = typeof nextActive === 'boolean'
    ? setBaguaPanelState({ active: nextActive, source: 'agent_tool' })
    : getBaguaPanelState()
  if (typeof nextActive === 'boolean') {
    emitEvent('bagua_mode', { action: state.active ? 'show' : 'hide', active: state.active, reason: typeof args.reason === 'string' ? args.reason : '' })
    emitEvent('action', { tool: 'bagua_mode', summary: state.active ? '打开易经易学看板' : '关闭易经易学看板', detail: args.reason || '' })
  }
  return JSON.stringify({ ok: true, tool: 'bagua_mode', state })
}

// map_mode：对话里打开高德地图面板（show/hide/toggle/status）
// 高德 Key/安全密钥未配置时返回引导提示，不报错——让模型直接引导用户去设置页。
export function execMapMode(args = {}) {
  const action = String(args.action || 'status').trim().toLowerCase()
  if (!['show', 'open', 'hide', 'close', 'toggle', 'status'].includes(action)) {
    return JSON.stringify({ ok: false, tool: 'map_mode', error: 'unsupported action' })
  }

  const settings = getMapServiceSettings()
  const opening = (action === 'show' || action === 'open' || action === 'toggle')

  if (opening && !settings.configured) {
    return JSON.stringify({
      ok: false,
      tool: 'map_mode',
      error: 'map_not_configured',
      map: settings,
      guidance: '高德地图还没配置好。请让用户到「设置 → 高级功能 → 地图服务」填写 Web 端 Key 和 安全密钥（securityJsCode）后，再让我打开地图。',
    })
  }

  const payload = {
    active: action === 'show' || action === 'open' || (action === 'toggle' && true),
    action: action === 'show' || action === 'open' ? 'show' : (action === 'hide' || action === 'close' ? 'hide' : action),
    location: typeof args.location === 'string' ? args.location.trim() : '',
    title: typeof args.title === 'string' ? args.title.trim() : '',
    zoom: Number.isFinite(Number(args.zoom)) ? Number(args.zoom) : undefined,
    markers: Array.isArray(args.markers) ? args.markers.map(m => String(m)).slice(0, 20) : [],
    keyword: typeof args.keyword === 'string' ? args.keyword.trim() : '',
    reason: typeof args.reason === 'string' ? args.reason : '',
  }

  // toggle：读取面板状态做切换（无本地状态表，直接按当前 emit 判断；前端幂等处理）
  if (action === 'toggle') {
    // 前端 map-panel 维护实际开关状态；后端 toggle 一律发 show 让前端切换。
    payload.active = true
    payload.action = 'show'
  }

  emitEvent('map_mode', payload)
  emitEvent('action', {
    tool: 'map_mode',
    summary: payload.action === 'hide' ? '关闭地图面板' : `打开地图${payload.location ? '：' + payload.location : ''}`,
    detail: [payload.title, payload.keyword, (payload.markers || []).join(',')].filter(Boolean).join(' | ') || payload.reason,
  })
  return JSON.stringify({ ok: true, tool: 'map_mode', state: { active: payload.active, location: payload.location, configured: settings.configured } })
}

export function execOpenDocPanel(args = {}) {
  const action = String(args.action || 'open').trim().toLowerCase()
  const nextActive = action !== 'close'
  const validTopics = ['voice_asr', 'voice_tts', 'voice_config']

  // 打开时 topic 必填；关闭时 topic 可省略（沿用当前面板已有的 topicId）
  let topic = args.topic ? String(args.topic).trim() : null
  if (nextActive && topic && !validTopics.includes(topic)) {
    if (/asr|识别|麦克风/.test(topic)) topic = 'voice_asr'
    else if (/tts|合成|声音/.test(topic)) topic = 'voice_tts'
    else topic = 'voice_config'
  }

  const state = setDocPanelState({ active: nextActive, topicId: topic, source: 'agent_tool' })

  const effectiveTopic = topic || state.topicId
  emitEvent('doc_panel_mode', {
    action: nextActive ? 'open' : 'close',
    active: nextActive,
    topic: effectiveTopic,
    reason: typeof args.reason === 'string' ? args.reason : '',
  })
  emitEvent('action', {
    tool: 'open_doc_panel',
    summary: nextActive ? `打开文档面板（${effectiveTopic}）` : '关闭文档面板',
    detail: args.reason || '',
  })

  return JSON.stringify({ ok: true, tool: 'open_doc_panel', topic: effectiveTopic, state })
}

export function execPreviewFile(args = {}) {
  const action = String(args.action || 'open').trim().toLowerCase()
  const nextActive = action !== 'close'

  let relPath = ''
  if (nextActive) {
    const raw = String(args.path || '').trim()
    if (!raw) return toolJson({ ok: false, tool: 'preview_file', error: '打开预览需要 path（sandbox 内相对或绝对路径）' })
    // 归一化：相对路径基于 sandbox；绝对路径必须在 sandbox 内
    const candidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(SANDBOX_ROOT, raw)
    if (!isPathInside(SANDBOX_ROOT, candidate)) {
      return toolJson({ ok: false, tool: 'preview_file', error: '只能预览 sandbox 目录内的文件', hint: `sandbox: ${SANDBOX_ROOT}` })
    }
    relPath = path.relative(SANDBOX_ROOT, candidate).replace(/\\/g, '/')
  }

  emitEvent('preview_file_mode', {
    action: nextActive ? 'open' : 'close',
    active: nextActive,
    path: relPath,
    reason: typeof args.reason === 'string' ? args.reason : '',
  })
  emitEvent('action', {
    tool: 'preview_file',
    summary: nextActive ? `预览文件（${relPath}）` : '关闭文件预览',
    detail: args.reason || '',
  })

  return toolJson({ ok: true, tool: 'preview_file', active: nextActive, path: relPath || null })
}

export function execPersonCardMode(args = {}) {
  const action = String(args.action || 'status').trim().toLowerCase()
  if (!['show', 'open', 'hide', 'close', 'update', 'toggle', 'status'].includes(action)) {
    return JSON.stringify({ ok: false, tool: 'person_card_mode', error: 'unsupported action' })
  }

  let nextActive = null
  if (action === 'show' || action === 'open' || action === 'update') nextActive = true
  if (action === 'hide' || action === 'close') nextActive = false
  if (action === 'toggle') nextActive = !getPersonCardPanelState().active

  const name = String(args.name || args.person || '').trim()
  const card = {
    ...(name ? getPersonCard(name) : {}),
    ...(args.card && typeof args.card === 'object' ? args.card : {}),
  }
  if (name) card.name = name
  for (const key of ['title', 'summary', 'image', 'avatar', 'source']) {
    if (typeof args[key] === 'string' && args[key].trim()) card[key] = args[key].trim()
  }
  if (Array.isArray(args.knownFor) || typeof args.knownFor === 'string') card.knownFor = args.knownFor
  if (Array.isArray(args.tags) || typeof args.tags === 'string') card.tags = args.tags
  if (Array.isArray(args.aliases) || typeof args.aliases === 'string') card.aliases = args.aliases

  const state = typeof nextActive === 'boolean'
    ? setPersonCardPanelState({
        active: nextActive,
        source: 'agent_tool',
        card: (card.name || card.summary || card.title) ? card : null,
        name,
      })
    : getPersonCardPanelState()

  if (typeof nextActive === 'boolean') {
    emitEvent('person_card_mode', {
      action: state.active ? 'show' : 'hide',
      active: state.active,
      card: state.card,
      reason: typeof args.reason === 'string' ? args.reason : '',
    })
    emitEvent('action', {
      tool: 'person_card_mode',
      summary: state.active ? `打开人物卡片${state.card?.name ? `：${state.card.name}` : ''}` : '关闭人物卡片',
      detail: args.reason || '',
    })
  }

  return JSON.stringify({ ok: true, tool: 'person_card_mode', state })
}

// ─────────────────────────────────────────────────────────────────────────────
