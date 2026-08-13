// src/memory/conversation-import-loop.js
// 自动定时：把对话记录（conversations 表）按线程聚合，转成"对话"记忆。
// - source_ref = session_import_* → 图谱归类为"对话"（白色节点）
// - 幂等：已存在 conv_thread_* 的线程跳过，可重复跑
// - 用应用自身 getDB()：桌面端 / 开发模式各自作用于当前库
import { getDB } from '../db.js'

const RUN_INTERVAL_MS = 30 * 60 * 1000  // 30 分钟
const FIRST_DELAY_MS = 5 * 60 * 1000    // 启动 5 分钟后再首次运行

function importConversationsAsMemories() {
  const db = getDB()
  const threads = db.prepare('SELECT id, label FROM threads ORDER BY id').all()
  const getMsgs = db.prepare('SELECT role, content, timestamp FROM conversations WHERE thread_id = ? ORDER BY id')
  const exists = db.prepare('SELECT id FROM memories WHERE mem_id = ?')
  const insert = db.prepare(`
    INSERT INTO memories (event_type, content, detail, title, mem_id, entities, concepts, tags, links, source_ref, timestamp, salience)
    VALUES (@event_type, @content, @detail, @title, @mem_id, @entities, @concepts, @tags, @links, @source_ref, @timestamp, @salience)
  `)

  let inserted = 0
  for (const th of threads) {
    const msgs = getMsgs.all(th.id)
    if (!msgs.length) continue
    const memId = `conv_thread_${th.id}`
    if (exists.get(memId)) continue

    const content = msgs.map(m => `${m.role === 'user' ? '用户' : '小白龙'}: ${m.content}`).join('\n')
    let title = (th.label || '').trim()
    if (!title) {
      const firstUser = msgs.find(m => m.role === 'user')
      title = (firstUser?.content || '').slice(0, 40)
    }
    if (!title) title = '对话记录'
    const lastTs = msgs[msgs.length - 1].timestamp || new Date().toISOString()

    insert.run({
      event_type: 'conversation',
      content,
      detail: content,
      title,
      mem_id: memId,
      entities: '[]', concepts: '[]', tags: '[]', links: '[]',
      source_ref: `session_import_${th.id}`,
      timestamp: lastTs,
      salience: 3,
    })
    inserted++
  }

  // 有新增才重建全文索引（memories_fts 触发器不覆盖手工 INSERT）
  if (inserted > 0) {
    try { db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')") } catch (err) { console.warn('[对话导入] FTS 重建失败:', err.message) }
    console.log(`[对话导入] 新增 ${inserted} 条对话记忆`)
  }
  return inserted
}

async function tick() {
  try {
    importConversationsAsMemories()
  } catch (err) {
    console.error('[对话导入] 失败:', err?.message || err)
  }
}

let started = false
let timer = null

export function startConversationImportLoop() {
  if (started) return
  started = true
  setTimeout(() => {
    tick()
    timer = setInterval(tick, RUN_INTERVAL_MS)
  }, FIRST_DELAY_MS)
  console.log(`[对话导入] 已注册，${FIRST_DELAY_MS / 60000} 分钟后首次运行，之后每 ${RUN_INTERVAL_MS / 60000} 分钟一次`)
}

export function stopConversationImportLoop() {
  if (timer) { clearInterval(timer); timer = null }
  started = false
}
