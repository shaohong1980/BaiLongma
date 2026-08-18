// bagua.js —— 服务端「易经 · 易学看板」面板状态与运行时上下文
// 看板内容（太极 / 八卦 / 六十四卦 / 卦辞 / 起卦）全在前端 bagua-panel 自渲染，
// 这里只维护「面板是否打开」的状态，供 executor（bagua_mode 工具）与 /bagua-state 路由消费；
// 面板打开或用户提及易学主题时，把易学上下文喂给主模型，让它知道可以调 bagua_mode 打开看板。

const PANEL_CONTEXT_TTL_MS = 60 * 60 * 1000
let panelState = { active: false, updatedAtMs: 0, openedAtMs: 0, openEventPending: false, source: 'startup' }
let panelActiveUntilMs = 0

export function setBaguaPanelState({ active, source = 'unknown' } = {}) {
  if (typeof active !== 'boolean') return getBaguaPanelState()
  const now = Date.now()
  const justOpened = active && !panelState.active
  panelState = {
    active,
    updatedAtMs: now,
    openedAtMs: justOpened ? now : (active ? panelState.openedAtMs : 0),
    openEventPending: justOpened ? true : (active ? panelState.openEventPending : false),
    source,
  }
  panelActiveUntilMs = active ? now + PANEL_CONTEXT_TTL_MS : 0
  return getBaguaPanelState()
}

export function getBaguaPanelState() {
  const now = Date.now()
  const remaining = Math.max(0, panelActiveUntilMs - now)
  const justOpened = panelState.active && panelState.openEventPending
  return {
    ...panelState,
    updatedAt: panelState.updatedAtMs ? new Date(panelState.updatedAtMs).toISOString() : null,
    openedAt: panelState.openedAtMs ? new Date(panelState.openedAtMs).toISOString() : null,
    justOpened,
    contextActive: panelState.active,
    contextTtlSeconds: panelState.active ? Math.round(remaining / 1000) : 0,
  }
}

export function consumeBaguaPanelOpenEvent() {
  const state = getBaguaPanelState()
  if (!state.justOpened) return null
  panelState = { ...panelState, openEventPending: false }
  return { openedAt: state.openedAt, source: state.source }
}

const BAGUA_QUERY_RE = /易经|周易|八卦|六十四卦|64\s?卦|太极|阴阳|五行|卜卦|起卦|摇卦|六爻|乾|坤|震|巽|坎|离|艮|兑/i

export async function buildBaguaRuntimeContext(message = '') {
  const state = getBaguaPanelState()
  if (!state.contextActive && !BAGUA_QUERY_RE.test(String(message || ''))) return ''

  const openEvent = consumeBaguaPanelOpenEvent()
  const panelLine = openEvent
    ? `Panel event: The I Ching dashboard was just opened at ${openEvent.openedAt}. This is a one-time opening event and has now been acknowledged.`
    : state.active
      ? `Panel state: The I Ching dashboard is currently open. It was opened at ${state.openedAt}; do not treat this as a new opening event.`
      : 'Panel state: The I Ching dashboard is not currently open; context was included because the user asked about I Ching / the Book of Changes.'

  const trigrams = '乾☰天(健·父) 兑☱泽(悦·少女) 离☲火(丽·中女) 震☳雷(动·长男) 巽☴风(入·长女) 坎☵水(险·中男) 艮☶山(止·少男) 坤☷地(顺·母)'
  return `## I Ching Dashboard Context\n${panelLine}\nYou have a bagua_mode tool that opens an I Ching dashboard (Taiji · Eight Trigrams · 64 Hexagrams · divination) inside the UI. Use bagua_mode(action="show") when the user wants to view the bagua, cast a hexagram, or ask about I Ching; close it with action="hide" when asked.\nEight trigrams (先天): ${trigrams}\nThe 64 hexagrams each carry a classic judgment (卦辞); the dashboard shows them interactively. Do not fabricate hexagram texts the dashboard can show — point the user to it instead of inventing long verbatim passages.`
}
