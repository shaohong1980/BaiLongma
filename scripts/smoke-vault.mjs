// smoke-vault.mjs —— vault ReMe 双写冒烟测试（隔离临时库，Electron-as-node 运行）
// 用法：npm run smoke:vault  （等价 ELECTRON_RUN_AS_NODE=1 electron scripts/smoke-vault.mjs）
import os from 'os'
import path from 'path'
import fs from 'fs'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-vault-test-'))
process.env.BAILONGMA_USER_DIR = tmp

const { insertMemory, getMemoryByMemId, getMemoriesByEntity } = await import('../src/db.js')
const { exportVault, importVaultEdits, getVaultStatus } = await import('../src/memory/vault.js')

let pass = 0, fail = 0
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓', name) }
  else { fail++; console.log('  ✗', name, extra) }
}

insertMemory({ mem_id: 'test_mem_1', event_type: 'fact', title: '用户喜欢喝美式咖啡', content: '用户每天早上都喝一杯美式咖啡', detail: '用户每天早上都喝一杯美式咖啡', entities: ['id:000001'], salience: 5, visibility: 1 })
insertMemory({ mem_id: 'test_mem_2', event_type: 'fact', title: '用户住北京', content: '用户住在北京市海淀区', detail: '用户住在北京市海淀区', entities: ['id:000001'], salience: 4, visibility: 1 })

const exp = exportVault()
check('export ok', exp.ok === true)
const vaultDir = exp.path
const userFile = fs.readdirSync(vaultDir).find(f => f.includes('用户'))
check('vault has 用户.md', !!userFile)
let userMd = fs.readFileSync(path.join(vaultDir, userFile), 'utf8')
check('user.md has test_mem_1 marker', userMd.includes('<!--mem:test_mem_1-->'))
check('user.md has test_mem_2 marker', userMd.includes('<!--mem:test_mem_2-->'))

const lines = userMd.split(/\r?\n/)
const out = []
let skipBlock = false
for (const line of lines) {
  if (skipBlock) { if (/^-\s/.test(line)) skipBlock = false; else continue }
  if (line.includes('住北京')) { skipBlock = true; continue }
  if (line.includes('美式咖啡')) { out.push(line.replace(/每天早上都喝一杯美式咖啡/, '现在改喝拿铁咖啡了')); continue }
  out.push(line)
}
userMd = out.join('\n')
userMd += '\n- 📌 **新增的测试记忆**（重要度 3）\n  这是一条用户在 vault 里手动加的记忆\n'
fs.writeFileSync(path.join(vaultDir, userFile), userMd, 'utf8')

const imp = importVaultEdits()
check('import ok', imp.ok === true)
check('import updated mem_1', imp.updated.some(u => u.mem_id === 'test_mem_1'))
check('import hidden mem_2', imp.hidden.some(h => h.mem_id === 'test_mem_2'))
check('import inserted new', imp.inserted.length >= 1)
check('import no errors', imp.errors.length === 0)

const m1 = getMemoryByMemId('test_mem_1')
check('mem_1 content updated', m1 && m1.content.includes('拿铁'))
const m2 = getMemoryByMemId('test_mem_2')
check('mem_2 hidden', m2 && m2.visibility === 0)
const related = getMemoriesByEntity('id:000001', 50)
check('new memory visible', related.some(r => r.title.includes('新增的测试记忆')))

const exp2 = exportVault()
const userMd2 = fs.readFileSync(path.join(vaultDir, userFile), 'utf8')
check('re-export has new mem marker', /<!--mem:vault_/.test(userMd2))
check('re-export no stale mem_2 marker', !userMd2.includes('mem:test_mem_2'))

const st = getVaultStatus()
check('status ok', st.ok === true && st.files > 0)

try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
console.log(`\nvault ReMe dual-write: ${pass}/${pass+fail} passed`)
process.exit(fail ? 1 : 0)
