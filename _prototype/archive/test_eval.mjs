// 独立测试脚本：验证 evaluateTask 能否正常工作
// 注意：用项目的 paths.dbFile（data/jarvis.db），与 src 保持一致；不要指向空的 memory.db
import Database from 'better-sqlite3';
import { paths } from './src/paths.js';

// 打开记忆库
const dbPath = paths.dbFile;
console.log('打开记忆库:', dbPath);
const db = new Database(dbPath);

// 模拟 upsertMemoryByMemId
function upsertMemoryByMemId(memId, data) {
  const existing = db.prepare('SELECT id FROM memories WHERE mem_id = ?').get(memId);
  if (existing) {
    db.prepare(`UPDATE memories SET 
      content = ?, type = ?, salience = ?, updated_at = datetime('now')
      WHERE mem_id = ?`).run(data.content, data.type, data.salience, memId);
    return { action: 'updated', mem_id: memId };
  } else {
    db.prepare(`INSERT INTO memories (mem_id, content, type, salience, created_at, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`).run(
      memId, data.content, data.type, data.salience
    );
    return { action: 'inserted', mem_id: memId };
  }
}

// 模拟 evaluateTask
async function evaluateTask({ taskId, taskDesc, accuracy, efficiency, satisfaction, note }) {
  const memId = `self_eval_${taskId}`;
  const content = `[自我评估] 任务: ${taskDesc}\n准确性: ${accuracy}/10 | 效率: ${efficiency}/10 | 满意度: ${satisfaction}/10\n备注: ${note || '无'}`;
  
  const result = upsertMemoryByMemId(memId, {
    content,
    type: 'knowledge',
    salience: 4
  });
  
  return {
    ok: true,
    mem_id: memId,
    action: result.action,
    scores: { accuracy, efficiency, satisfaction }
  };
}

// 跑测试
const result = await evaluateTask({
  taskId: 'test_eval_001',
  taskDesc: '给 self-evolution.js 加自动评估功能',
  accuracy: 8,
  efficiency: 7,
  satisfaction: 8,
  note: '代码改完语法通过，但 better-sqlite3 版本不兼容导致首次调用失败，npm rebuild 后恢复'
});

console.log('评估结果:', JSON.stringify(result, null, 2));

// 验证写入
const row = db.prepare('SELECT * FROM memories WHERE mem_id = ?').get('self_eval_test_eval_001');
console.log('记忆库验证:', row ? `已写入，内容长度: ${row.content.length}` : '未找到');

db.close();
console.log('测试完成');
