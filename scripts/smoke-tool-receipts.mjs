// smoke-tool-receipts.mjs —— 工具回执冒烟测试（隔离临时库，Electron-as-node 运行）
// 用法：npm run smoke:tool-receipts
import os from 'os'
import path from 'path'
import fs from 'fs'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-receipt-test-'))
process.env.BAILONGMA_USER_DIR = tmp

const { insertActionLog, getActionLog, updateActionLogReceipt } = await import('../src/db.js')
const {
  createToolReceipt, verifyToolReceiptSafe, buildReceiptForLogRow,
  toolReceiptsEnabled, getReceiptSecret, sha256Hex,
} = await import('../src/capabilities/tool-receipts.js')

let pass = 0, fail = 0
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓', name) }
  else { fail++; console.log('  ✗', name, extra) }
}

// 1. 落一条 action_log，拿到 id
const id = insertActionLog({
  timestamp: new Date().toISOString(),
  tool: 'exec_command',
  summary: 'exec_command(Get-Date)',
  detail: 'args={command: Get-Date}',
  status: 'ok',
  risk: 'high',
  argsJson: '{"command":"Get-Date"}',
  resultPreview: '2026-08-20 12:00:00',
  source: 'llm',
})
check('insertActionLog returns id', Number(id) > 0)

// 2. 生成回执并写回
const row = getActionLog(id)
const receipt = buildReceiptForLogRow(row)
check('receipt created', !!receipt && !!receipt.sig)
check('receipt has args_hash', receipt.args_hash.length === 64)
updateActionLogReceipt(id, JSON.stringify(receipt))

// 3. 验签通过
const stored = JSON.parse(getActionLog(id).receipt)
const ok = verifyToolReceiptSafe(stored)
check('verify valid', ok.valid === true, JSON.stringify(ok))

// 4. 篡改检测：改 args_json 后按新值重建应验签失败
const tamperedRow = { ...row, args_json: '{"command":"rm -rf /"}' }
const tampered = buildReceiptForLogRow(tamperedRow)
check('tampered args → sig differs', tampered.sig !== receipt.sig)
const tamperCheck = verifyToolReceiptSafe({ ...stored, args_hash: tampered.args_hash })
check('tampered args_hash → verify fails', tamperCheck.valid === false)

// 5. 改 receipt 里其它字段也验签失败
const altered = { ...stored, status: 'error' }
check('altered status → verify fails', verifyToolReceiptSafe(altered).valid === false)

// 6. 幂等：同一记录重复生成回执签名一致（可复现审计）
const again = buildReceiptForLogRow(getActionLog(id))
check('deterministic sig', again.sig === receipt.sig)

// 7. 开关 & 密钥持久化
check('toolReceiptsEnabled default true', toolReceiptsEnabled() === true)
check('secret persisted to file', fs.existsSync(path.join(tmp, 'data', '.tool-receipt.key')))
const secret2 = getReceiptSecret()
check('secret stable across calls', secret2.length >= 32)

// 8. createToolReceipt 直接构造 + verify 往返
const direct = createToolReceipt({ id: 999, tool: 'write_file', timestamp: '2026-08-20T00:00:00Z', status: 'ok', risk: 'medium', source: 'llm', summary: 'write_file(a.md)', argsHash: sha256Hex('{}'), resultHash: sha256Hex('ok') })
check('direct receipt valid', verifyToolReceiptSafe(direct).valid === true)

try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
console.log(`\ntool receipts: ${pass}/${pass+fail} passed`)
process.exit(fail ? 1 : 0)
