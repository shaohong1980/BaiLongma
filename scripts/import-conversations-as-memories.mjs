// scripts/import-conversations-as-memories.mjs
// 把桌面端 jarvis.db 的对话记录按线程聚合，存成"对话"记忆。
// - source_ref = session_import_*  → 图谱里自动归为"对话"（白色）
// - 已存在的 conv_thread_* 记忆会跳过（幂等，可重复跑）
// 用法：ELECTRON_RUN_AS_NODE=1 electron scripts/import-conversations-as-memories.mjs [DB路径]
import Database from 'better-sqlite3';

const DB_PATH = process.argv[2] || 'C:/Users/1/AppData/Roaming/Bailongma/data/jarvis.db';
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const threads = db.prepare('SELECT id, topic, label FROM threads ORDER BY id').all();
const insert = db.prepare(`
  INSERT INTO memories (event_type, content, detail, title, mem_id, entities, concepts, tags, links, source_ref, timestamp, salience)
  VALUES (@event_type, @content, @detail, @title, @mem_id, @entities, @concepts, @tags, @links, @source_ref, @timestamp, @salience)
`);
const getMsgs = db.prepare('SELECT role, content, timestamp FROM conversations WHERE thread_id = ? ORDER BY id');
const exists = db.prepare('SELECT id FROM memories WHERE mem_id = ?');

let inserted = 0, skipped = 0, noMsgs = 0;
for (const th of threads) {
  const msgs = getMsgs.all(th.id);
  if (!msgs.length) { noMsgs++; continue; }

  const memId = `conv_thread_${th.id}`;
  if (exists.get(memId)) { skipped++; continue; }

  // 内容：完整对话按顺序拼接
  const content = msgs.map(m => `${m.role === 'user' ? '用户' : '小白龙'}: ${m.content}`).join('\n');
  // 标题：线程 label 优先，否则取第一条用户消息前 40 字
  let title = (th.label || '').trim();
  if (!title) {
    const firstUser = msgs.find(m => m.role === 'user');
    title = (firstUser?.content || '').slice(0, 40);
  }
  if (!title) title = '对话记录';
  const lastTs = msgs[msgs.length - 1].timestamp || new Date().toISOString();

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
  });
  inserted++;
}

// 重建全文检索索引（外部内容表需要）
db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");

console.log(`[导入] 完成：新增 ${inserted} 条对话记忆 | 跳过已存在 ${skipped} | 空线程 ${noMsgs}`);
db.close();
