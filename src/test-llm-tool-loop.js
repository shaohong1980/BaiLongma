// runTurn 安全网：callLLM 工具循环测试（stub LLM + stub 工具执行器）
// 覆盖 runTurn 核心最复杂的部分：注入→调用→工具执行→结果回喂→最终回复。
// 运行：node src/test-llm-tool-loop.js
import { callLLM } from './llm.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✔ ' + m) } else { fail++; console.log('  ✘ ' + m) } }

console.log('[1] 纯文本回复（无工具）')
try {
  const r = await callLLM({
    messages: [{ role: 'user', content: '你好' }],
    tools: [],
    maxTokens: 500,
    mustReply: true, localReply: true,
    _streamOnceForTest: async () => ({ content: '你好！有什么可以帮你？', toolCalls: [], aborted: false }),
  })
  ok(!r.aborted && String(r.content || '').includes('你好'), '返回文本回复 => ' + String(r.content).slice(0, 30))
} catch (e) { ok(false, '纯文本异常: ' + e.message) }

console.log('[2] 工具调用 → 执行 → 结果回喂 → 最终回复')
try {
  const responses = [
    { content: '', toolCalls: [{ name: 'read_file', arguments: '{"path":"/tmp/x"}' }], aborted: false },
    { content: '读到了文件内容', toolCalls: [], aborted: false },
  ]
  let toolExecuted = 0
  let seenToolResultInMessages = false
  const r = await callLLM({
    messages: [{ role: 'user', content: '读一下 /tmp/x' }],
    tools: ['read_file'],
    maxTokens: 500,
    mustReply: true, localReply: true,
    _streamOnceForTest: async ({ messages }) => {
      // 第二轮应已带工具结果回喂
      if (responses.length === 1 && JSON.stringify(messages).includes('文件内容')) seenToolResultInMessages = true
      return responses.shift()
    },
    _executeToolForTest: async (_name, _args) => { toolExecuted++; return '文件内容' },
  })
  ok(toolExecuted === 1, '工具被调用 1 次 => ' + toolExecuted)
  ok(seenToolResultInMessages, '工具结果已回喂到下一轮 messages')
  ok(!r.aborted && String(r.content || '').includes('读到了'), '最终回复基于工具结果 => ' + String(r.content).slice(0, 30))
} catch (e) { ok(false, '工具循环异常: ' + e.message) }

console.log('[3] 工具失败 → 模型如实说明（不声称成功）')
try {
  const responses = [
    { content: '', toolCalls: [{ name: 'read_file', arguments: '{"path":"/nonexist"}' }], aborted: false },
    { content: '抱歉，文件不存在，无法读取', toolCalls: [], aborted: false },
  ]
  const r = await callLLM({
    messages: [{ role: 'user', content: '读 /nonexist' }],
    tools: ['read_file'],
    maxTokens: 500,
    mustReply: true, localReply: true,
    _streamOnceForTest: async () => responses.shift(),
    _executeToolForTest: async () => '{"ok":false,"error":"ENOENT: 文件不存在"}',
  })
  ok(!r.aborted && String(r.content || '').includes('不存在'), '失败如实说明 => ' + String(r.content).slice(0, 30))
} catch (e) { ok(false, '工具失败异常: ' + e.message) }

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
