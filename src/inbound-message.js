import { nowTimestamp } from './time.js'
import { normalizeConversationPartyId, upsertEntity, insertConversation } from './db.js'
import { resolveCanonicalUserId } from './identity.js'
import { enqueueMessage } from './queue.js'
import { emitEvent } from './events.js'

const PRIORITY = {
  user: 100,
  background: 50,
}

// ── 地图意图自动打开（不依赖 LLM 是否调用 map_mode）──────────────────────────
// 只要用户消息明确要求"打开地图 / 定位到某地 / 某地在哪 / 附近有什么"，
// 系统在消息进入主循环前就直接发出 map_mode 事件把面板打开。
// 原因：LLM（尤其 DeepSeek）在对话被污染后常谎称"面板已激活"而不真正调工具，
// 靠提示词不可靠。系统级自动打开能保证面板一定弹出。
const LOCAL_CHANNELS = new Set(['TUI', 'API', 'VOICE', '语音识别', ''])

const MAP_OPEN_INTENT_RE = /打开地图|开启地图|显示地图|看看地图|看下地图|看一下地图|地图打开|打开高德|高德地图|定位到|导航到|地图定位|高德定位|地图看看|看地图|查地图|地图一下|来个地图|在哪|在哪儿|在哪里|附近有|周边有|附近的/
// 排除"谈论地图配置/服务"等不打开面板的请求
const MAP_CONFIG_RE = /地图服务|地图配置|地图怎么|地图能|地图api|地图key|地图设置|地图密钥|高德配置|高德key|高德服务|高德怎么|怎么配|如何配|设置.{0,6}地图|地图.{0,6}设置/

function extractMapLocation(content = '') {
  const m =
    content.match(/定位到\s*([一-龥A-Za-z0-9·\- ]{1,12})/) ||
    content.match(/导航到\s*([一-龥A-Za-z0-9·\- ]{1,12})/) ||
    content.match(/看看\s*([一-龥A-Za-z0-9·\- ]{1,12})/) ||
    content.match(/看下\s*([一-龥A-Za-z0-9·\- ]{1,12})/) ||
    content.match(/打开地图\s*([一-龥A-Za-z0-9·\- ]{1,12})/) ||
    content.match(/地图\s*看看\s*([一-龥A-Za-z0-9·\- ]{1,12})/)
  return m ? m[1].trim() : ''
}

function extractMapKeyword(content = '') {
  const m =
    content.match(/附近(?:有|的|看)?\s*([一-龥A-Za-z0-9·\- ]{1,10})/) ||
    content.match(/周边(?:有|的|看)?\s*([一-龥A-Za-z0-9·\- ]{1,10})/)
  return m ? m[1].trim() : ''
}

function maybeAutoOpenMap(content = '', channel = 'TUI') {
  const ch = String(channel || 'TUI').toUpperCase()
  if (!LOCAL_CHANNELS.has(ch)) return null
  const text = String(content || '').trim()
  if (!text) return null
  if (MAP_CONFIG_RE.test(text)) return null
  if (!MAP_OPEN_INTENT_RE.test(text)) return null
  const location = extractMapLocation(text)
  const keyword = extractMapKeyword(text)
  // 仅 TUI / 语音入口自动打开；触发条件足够明确才发
  emitEvent('map_mode', {
    active: true,
    action: 'show',
    location: location || '',
    keyword: keyword || '',
    title: location ? `地图 · ${location}` : '地图',
    markers: [],
    reason: 'system_auto_open',
  })
  return { location: location || '', keyword: keyword || '' }
}

function resolvePriority(fromId, channel, meta = {}) {
  if (typeof meta.priority === 'number') return meta.priority
  if (meta.queue === 'background') return PRIORITY.background
  if (channel === 'REMINDER' || channel === 'SYSTEM' || normalizeConversationPartyId(fromId) === 'SYSTEM') {
    return PRIORITY.background
  }
  return PRIORITY.user
}

function resolveQueueName(priority, meta = {}) {
  if (meta.queue === 'background') return 'background'
  return priority >= PRIORITY.user ? 'user' : 'background'
}

export function pushMessage(rawFromId, content, channel = 'TUI', meta = {}) {
  const normalizedRaw = normalizeConversationPartyId(rawFromId)
  const canonicalId = resolveCanonicalUserId({ rawFromId: normalizedRaw, channel })
  const externalPartyId = canonicalId !== normalizedRaw ? normalizedRaw : ''
  const timestamp = nowTimestamp()
  const priority = resolvePriority(canonicalId, channel, meta)
  const queueName = resolveQueueName(priority, meta)
  upsertEntity(canonicalId)

  // 地图意图自动打开：本地/语音入口且消息明确要求地图时，系统直接弹面板。
  const mapAuto = maybeAutoOpenMap(content, channel)
  if (mapAuto) {
    meta = { ...meta, map_auto_opened: true, map_auto_location: mapAuto.location, map_auto_keyword: mapAuto.keyword }
  }

  // Persist on arrival so interrupted turns still keep the user message in
  // conversation history for the next context window.
  const conversationId = meta.persist !== false ? insertConversation({
    role: 'user',
    from_id: canonicalId,
    to_id: 'jarvis',
    content,
    timestamp,
    channel: channel || '',
    external_party_id: externalPartyId,
    focus_topic: '',
    thread_id: '',
  }) : 0

  const entry = {
    raw: `[${canonicalId}${externalPartyId ? ` via ${externalPartyId}` : ''}] ${timestamp} [${channel}] ${content}`,
    fromId: canonicalId,
    externalPartyId,
    content,
    timestamp,
    conversationId,
    channel,
    priority,
    queueName,
    ...meta,
  }

  return enqueueMessage(entry, queueName)
}
