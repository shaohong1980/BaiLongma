// F2 验证：办公室/三省六部图模式（resume 错误路径 + 模块加载）
import { resumeOfficeGraph } from './multi-agent/room.js'
import { resumeEdictGraph, runEdictGraph } from './multi-agent/task-flow.js'
import { officeCommand } from './multi-agent/room.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✔ ' + m) } else { fail++; console.log('  ✘ ' + m) } }

console.log('[1] 图模式函数已导出')
ok(typeof officeCommand === 'function', 'officeCommand 存在')
ok(typeof runEdictGraph === 'function', 'runEdictGraph 存在')
ok(typeof resumeOfficeGraph === 'function', 'resumeOfficeGraph 存在')
ok(typeof resumeEdictGraph === 'function', 'resumeEdictGraph 存在')

console.log('[2] resume 未知线程应抛错')
try { await resumeOfficeGraph('no-such-office-thread'); ok(false, 'office 未知线程应抛错') }
catch (e) { ok(/未知办公室图线程/.test(String(e.message)), 'office 未知线程抛错 => ' + String(e.message).slice(0, 24)) }
try { await resumeEdictGraph('no-such-edict-thread'); ok(false, 'edict 未知线程应抛错') }
catch (e) { ok(/未知流水线图线程/.test(String(e.message)), 'edict 未知线程抛错 => ' + String(e.message).slice(0, 24)) }

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
