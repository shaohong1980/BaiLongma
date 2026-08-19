// 内部事件总线：SSE 客户端管理 + 事件广播
const sseClients = new Set()

// 服务端订阅者（进程内监听，非 SSE）：type → Set<handler(data, type)>
// 用于 A2A 等服务端组件在进程内订阅 agent 出站事件，不依赖 SSE 连接。
const serverHandlers = new Map()

/**
 * 服务端订阅某类事件。返回取消订阅函数。
 * @param {string} type
 * @param {(data: any, type: string) => void} handler
 * @returns {() => void}
 */
export function subscribeEvent(type, handler) {
  if (!serverHandlers.has(type)) serverHandlers.set(type, new Set())
  serverHandlers.get(type).add(handler)
  return () => {
    serverHandlers.get(type)?.delete(handler)
    if (serverHandlers.get(type)?.size === 0) serverHandlers.delete(type)
  }
}

// 新客户端连上时需立即补发的"粘性"事件（如启动自检音效）
const stickyEvents = new Map()  // type → { data, ts }

export function setStickyEvent(type, data) {
  stickyEvents.set(type, { data, ts: new Date().toISOString() })
}

export function clearStickyEvent(type) {
  stickyEvents.delete(type)
}

// 发送所有待补发事件给指定 SSE 客户端（连接建立时调用）
export function flushStickyEvents(res) {
  for (const [type, { data, ts }] of stickyEvents) {
    try { res.write(`data: ${JSON.stringify({ type, data, ts })}\n\n`) } catch (_) {}
  }
}

export function addSSEClient(res) {
  sseClients.add(res)
}

export function removeSSEClient(res) {
  sseClients.delete(res)
}

export function emitEvent(type, data) {
  const payload = JSON.stringify({ type, data, ts: new Date().toISOString() })
  if (sseClients.size > 0) {
    for (const res of sseClients) {
      try {
        res.write(`data: ${payload}\n\n`)
      } catch (_) {
        sseClients.delete(res)
      }
    }
  }
  const handlers = serverHandlers.get(type)
  if (handlers && handlers.size > 0) {
    for (const h of handlers) {
      try { h(data, type) } catch (_) {}
    }
  }
}
