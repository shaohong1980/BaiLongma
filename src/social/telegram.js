// telegram.js —— Telegram Bot 连接器（ZeroClaw 渠道扩展思路）
//
// 入站：Bot API 长轮询 getUpdates（offset 去重 + 30s 长轮询 + 指数退避重连）。
//       文本消息经 pushMessage(fromId=chatId, text, 'telegram', meta) 进主循环。
// 出站：sendTelegram({ chatId }, content) → sendMessage，供 dispatchSocialMessage 路由。
// 配置：环境变量 TELEGRAM_BOT_TOKEN（@BotFather 创建机器人拿到）。
import { requestJson } from './http.js'
import { env } from './utils.js'

const API_BASE = (token) => `https://api.telegram.org/bot${token}`
const POLL_TIMEOUT_S = 30
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 60000

// ── 出站：给某个 chatId 发文本消息 ──
export async function sendTelegram({ chatId }, content) {
  const token = env('TELEGRAM_BOT_TOKEN')
  if (!token) return { ok: false, skipped: true, reason: 'TELEGRAM_BOT_TOKEN not configured' }
  const text = String(content ?? '').trim()
  if (!text) return { ok: false, error: 'empty text' }
  const res = await requestJson(`${API_BASE(token)}/sendMessage`, {
    method: 'POST',
    body: { chat_id: String(chatId), text, disable_web_page_preview: true },
    timeoutMs: 20000,
  })
  if (!res.ok) throw new Error(`Telegram sendMessage failed HTTP ${res.status}: ${res.text}`)
  return { ok: true, platform: 'telegram', messageId: res.data?.result?.message_id || null }
}

// ── 入站：长轮询启动 ──
export function startTelegramConnector({ pushMessage, emitEvent } = {}) {
  const token = env('TELEGRAM_BOT_TOKEN')
  if (!token) return null

  let stopped = false
  let pollTimer = null
  let reconnectTimer = null
  let offset = 0
  let reconnectAttempt = 0

  async function pollOnce() {
    const url = `${API_BASE(token)}/getUpdates?timeout=${POLL_TIMEOUT_S}&offset=${offset}&allowed_updates=["message"]`
    const res = await requestJson(url, { timeoutMs: (POLL_TIMEOUT_S + 5) * 1000 })
    if (stopped) return
    if (!res.ok || !res.data?.ok) {
      throw new Error(`getUpdates failed HTTP ${res.status}: ${res.text}`)
    }
    const updates = Array.isArray(res.data.result) ? res.data.result : []
    for (const update of updates) {
      if (stopped) break
      const msg = update?.message
      if (!msg) continue
      // 只处理文本消息；caption 也算（带媒体的说明文字）
      const text = String(msg.text ?? msg.caption ?? '').trim()
      if (text) {
        const chatId = String(msg.chat?.id ?? '')
        const fromName = msg.from?.first_name
          ? `${msg.from.first_name}${msg.from.last_name ? ' ' + msg.from.last_name : ''}`
          : ''
        // 目标 id 用 chatId（Telegram 私聊/群都用 chat.id 回消息最可靠）
        pushMessage?.(chatId, text, 'telegram', {
          notificationChannel: 'telegram',
          notificationTargetId: `telegram:${chatId}`,
          externalPartyId: chatId,
          telegramChatId: chatId,
          telegramFrom: fromName || chatId,
          telegramChatType: msg.chat?.type || '',
        })
      }
      // 已处理该 update，推进 offset（含非文本，避免重复拉取）
      if (Number(update.update_id) >= offset) offset = Number(update.update_id) + 1
    }
    reconnectAttempt = 0 // 一次成功轮询即复位重连退避
  }

  function schedulePoll(delayMs = 0) {
    if (stopped) return
    pollTimer = setTimeout(async () => {
      try {
        await pollOnce()
        schedulePoll(0)
      } catch (err) {
        if (stopped) return
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS) + Math.random() * 300
        reconnectAttempt++
        emitEvent?.('social_status', { platform: 'telegram', status: 'reconnecting', attempt: reconnectAttempt, delayMs: Math.round(delay), error: err.message })
        schedulePoll(delay)
      }
    }, delayMs)
    pollTimer.unref?.()
  }

  // 启动时先清一次 offset：跳过机器人上线前积压的旧消息（避免把历史全灌进来）
  requestJson(`${API_BASE(token)}/getUpdates?offset=-1`, { timeoutMs: 8000 })
    .catch(() => {})
    .finally(() => schedulePoll(0))

  emitEvent?.('social_status', { platform: 'telegram', status: 'started' })
  console.log('[social] telegram connector started (long-polling)')

  return {
    stop() {
      stopped = true
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null }
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
      emitEvent?.('social_status', { platform: 'telegram', status: 'stopped' })
    },
  }
}
