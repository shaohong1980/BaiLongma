// smoke-reminders.mjs —— 提醒会话绑定冒烟测试（隔离临时库，Electron-as-node 运行）
// 用法：npm run smoke:reminders
import os from 'os'
import path from 'path'
import fs from 'fs'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-remind-test-'))
process.env.BAILONGMA_USER_DIR = tmp

const { createReminder, getReminderById, getDueReminders, cancelReminder } = await import('../src/db.js')
const { execManageReminder } = await import('../src/capabilities/tools/reminders.js')

let pass = 0, fail = 0
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓', name) }
  else { fail++; console.log('  ✗', name, extra) }
}

const dueAt = new Date(Date.now() + 60000).toISOString()
const r1 = createReminder({ userId: 'ID:000001', dueAt, task: '复盘进展', systemMessage: '[REMINDER] 复盘', conversationRef: 'ID:000001' })
const id1 = Number(r1.lastInsertRowid)
check('conversation_ref stored', getReminderById(id1).conversation_ref === 'ID:000001')

const out = await execManageReminder({ action: 'create', kind: 'once', task: '发日报', due_at: new Date(Date.now() + 120000).toISOString(), target_id: 'ID:000001', conversation_ref: 'ID:000001' })
check('tool create ok', String(out).includes('提醒已创建'), String(out))
const id2 = Number(String(out).match(/#(\d+)/)?.[1] || 0)
check('tool conversation_ref stored', getReminderById(id2)?.conversation_ref === 'ID:000001')

const dueFuture = getDueReminders(new Date(Date.now() + 180000).toISOString(), 20)
check('getDueReminders works', Array.isArray(dueFuture) && dueFuture.length >= 2)

const listed = await execManageReminder({ action: 'list' })
check('tool list ok', String(listed).includes('共') && String(listed).includes('条待触发'))

const cancel = await execManageReminder({ action: 'cancel', id: id2 })
check('tool cancel ok', String(cancel).includes('已取消'))

const rec = createReminder({ userId: 'ID:000001', dueAt, task: '每周回顾', systemMessage: '[REMINDER] 周回顾', recurrenceType: 'weekly', recurrenceConfig: { time: '09:00', weekday: 1 }, conversationRef: 'ID:000001' })
check('recurring + conversation_ref stored', getReminderById(Number(rec.lastInsertRowid))?.conversation_ref === 'ID:000001')

try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
console.log(`\nreminders conversation-binding: ${pass}/${pass+fail} passed`)
process.exit(fail ? 1 : 0)
