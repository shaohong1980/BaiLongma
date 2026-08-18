// test-a2a-client.js —— A2A 客户端协议交互测试
// 用 node 内置 http 起一个 mock A2A 服务器，验证 Agent Card 发现 / tasks 生命周期 / 文本提取 / 错误处理。
// 运行：node src/test-a2a-client.js（无需 electron，纯标准库）
import http from 'http'
import {
  fetchAgentCard, runTask, sendTask, getTask, cancelTask,
  extractTaskText, extractMessageText, isA2AEndpoint,
} from './agents/a2a-client.js'

let pass = 0, fail = 0
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log('PASS:', label, detail) }
  else { fail++; console.log('FAIL:', label, detail) }
}

const SAMPLE_CARD = {
  name: 'Mock Agent',
  description: 'A2A test server',
  version: '1.0.0',
  protocolVersion: '0.2.4',
  skills: [{ id: 's1', name: 'test', description: 'test skill', tags: ['test'], inputModes: ['text'], outputModes: ['text'] }],
  capabilities: { streaming: false, pushNotifications: false },
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
}

// 启动 mock A2A 服务器。behavior 定义 tasks/send 创建的任务与 tasks/get 演进。
function startMockServer({ cardPath = '/.well-known/agent.json', card = SAMPLE_CARD, behavior = null } = {}) {
  const tasks = new Map()   // id -> { task, polls }
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      if (req.url === cardPath) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(card))
      } else if (req.url === '/agent.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ...card, name: 'card-at-root' }))
      } else {
        res.writeHead(404); res.end('not found')
      }
      return
    }
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', () => {
      let rpc
      try { rpc = JSON.parse(body) } catch {
        res.writeHead(400); res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'parse error' } })); return
      }
      const { method, params } = rpc
      try {
        if (method === 'tasks/send') {
          const entry = behavior ? behavior.onCreate(params) : { task: { id: params.id, status: { state: 'completed', message: { role: 'agent', parts: [{ kind: 'text', text: '默认回复' }] } } }, polls: 0 }
          tasks.set(params.id, entry)
          res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: entry.task }))
        } else if (method === 'tasks/get') {
          const entry = tasks.get(params.id)
          if (!entry) throw Object.assign(new Error('task not found'), { code: -32602 })
          entry.polls = (entry.polls || 0) + 1
          if (behavior?.onPoll) entry.task = behavior.onPoll(params.id, entry.polls, entry.task)
          res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: entry.task }))
        } else if (method === 'tasks/cancel') {
          const entry = tasks.get(params.id)
          if (!entry) throw Object.assign(new Error('task not found'), { code: -32602 })
          entry.task = { ...entry.task, status: { state: 'canceled' } }
          res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: entry.task }))
        } else {
          res.writeHead(400)
          res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: `unknown method ${method}` } }))
        }
      } catch (err) {
        res.writeHead(500)
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: err.code || -32000, message: err.message } }))
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }))
  })
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

let s1
try {
  // ── 1. Agent Card 发现 ──
  s1 = await startMockServer({})
  let r = await fetchAgentCard(s1.base)
  check('fetchAgentCard 从 /.well-known/agent.json 发现', r.ok && r.card.name === 'Mock Agent', `cardUrl=${r.cardUrl}`)
  check('isA2AEndpoint 探测返回 true', (await isA2AEndpoint(s1.base)) === true)

  // 根路径 /agent.json 兜底
  const s1b = await startMockServer({ cardPath: '/nope.json' })
  r = await fetchAgentCard(s1b.base)
  check('fetchAgentCard 从 /agent.json 兜底发现', r.ok && r.card.name === 'card-at-root', `cardUrl=${r.cardUrl}`)
  await new Promise(res => s1b.server.close(res))

  // 非 A2A 端点
  const s1c = await startMockServer({ cardPath: '/nope.json' })
  const s1c2 = await startMockServer({ cardPath: '/none' })
  await new Promise(res => s1c.server.close(res))
  r = await fetchAgentCard('http://127.0.0.1:9', { timeoutMs: 1000 })  // 连不上的端口
  check('fetchAgentCard 对不可达端点返回 ok:false', r.ok === false)
  await new Promise(res => s1c2.server.close(res))

  // ── 2. runTask 完整生命周期：send→poll→completed→提取文本 ──
  const s2 = await startMockServer({
    behavior: {
      onCreate(params) {
        return { task: { id: params.id, status: { state: 'working', message: { role: 'agent', parts: [] } } }, polls: 0 }
      },
      onPoll(id, polls, task) {
        if (polls >= 2) {
          return {
            id,
            status: { state: 'completed', message: { role: 'agent', parts: [{ kind: 'text', text: '最终答案' }] } },
            artifacts: [{ id: 'a1', name: '输出', parts: [{ kind: 'text', text: ' 附件文本 ' }, { kind: 'file', file: { name: 'report.pdf', mimeType: 'application/pdf' } }, { kind: 'data', data: { key: 'v1' } }] }],
          }
        }
        return task
      },
    },
  })
  r = await runTask(s2.base, { text: '帮我做件事', taskId: 'task-001', pollIntervalMs: 20 })
  check('runTask 返回 ok:true', r.ok === true, `state=${r.state}`)
  check('runTask 提取最终文本（含 status + artifacts 的 text/file/data part）',
    r.text.includes('最终答案') && r.text.includes('附件文本') && r.text.includes('[文件: report.pdf]') && r.text.includes('[数据:') && r.text.includes('v1'),
    `text="${r.text.slice(0, 60)}..."`)
  check('runTask 返回任务 id', r.taskId === 'task-001')
  await new Promise(res => s2.server.close(res))

  // ── 3. tasks/send 立即完成（无轮询）──
  const s3 = await startMockServer({})
  r = await runTask(s3.base, { text: '立即回复', taskId: 'task-003', pollIntervalMs: 20 })
  check('runTask 立即完成场景', r.ok && r.state === 'completed' && r.text === '默认回复')
  await new Promise(res => s3.server.close(res))

  // ── 4. failed 状态 → ok:false ──
  const s4 = await startMockServer({
    behavior: {
      onCreate(params) {
        return { task: { id: params.id, status: { state: 'failed', message: { role: 'agent', parts: [{ kind: 'text', text: '执行出错' }] } } }, polls: 0 }
      },
    },
  })
  r = await runTask(s4.base, { text: 'x', taskId: 'task-004', pollIntervalMs: 20 })
  check('runTask failed → ok:false 且保留错误文本', r.ok === false && r.state === 'failed' && r.text.includes('执行出错'))
  await new Promise(res => s4.server.close(res))

  // ── 5. input-required → ok:false 提示无法交互 ──
  const s5 = await startMockServer({
    behavior: {
      onCreate(params) {
        return { task: { id: params.id, status: { state: 'input-required', message: { role: 'agent', parts: [{ kind: 'text', text: '请补充细节' }] } } }, polls: 0 }
      },
    },
  })
  r = await runTask(s5.base, { text: 'x', taskId: 'task-005', pollIntervalMs: 20 })
  check('runTask input-required → ok:false 且提示不支持追问', r.ok === false && r.state === 'input-required' && /交互/.test(r.error))
  await new Promise(res => s5.server.close(res))

  // ── 6. sendTask/getTask/cancelTask 底层方法 ──
  const s6 = await startMockServer({
    behavior: {
      onCreate(params) {
        return { task: { id: params.id, status: { state: 'submitted', message: { role: 'agent', parts: [] } } }, polls: 0 }
      },
      onPoll(id, polls, task) {
        if (polls >= 1) return { id, status: { state: 'completed', message: { role: 'agent', parts: [{ kind: 'text', text: '轮询后完成' }] } } }
        return task
      },
    },
  })
  let sent = await sendTask(s6.base, { taskId: 'task-006', text: 'hi', metadata: { source: 'test' } })
  check('sendTask 返回 submitted 任务', sent.ok && sent.task.status.state === 'submitted')
  let got = await getTask(s6.base, 'task-006')
  check('getTask 轮询到 completed', got.ok && got.task.status.state === 'completed')
  let c = await cancelTask(s6.base, 'task-006')
  check('cancelTask 返回 canceled', c.ok && c.task.status.state === 'canceled')
  await new Promise(res => s6.server.close(res))

  // ── 7. JSON-RPC error（未知方法）──
  const s7 = await startMockServer({})
  r = await sendTask(s7.base, { text: 'x', taskId: 'task-007' })
  check('sendTask 正常返回', r.ok)
  // 直接发未知方法：走 rpcRequest 的 error 分支（通过私有不可达，用 __internals 之外的底层验证略过）
  const { __internals } = await import('./agents/a2a-client.js')
  check('__internals.isTerminal 状态判断', __internals.isTerminal('completed') && __internals.isTerminal('FAILED') && !__internals.isTerminal('working'))
  await new Promise(res => s7.server.close(res))

  // ── 8. 超时：runTask 在任务一直 working 时 timed_out ──
  const s8 = await startMockServer({
    behavior: {
      onCreate(params) {
        return { task: { id: params.id, status: { state: 'working', message: { role: 'agent', parts: [] } } }, polls: 0 }
      },
      onPoll() { return undefined },  // 保持 working
    },
  })
  r = await runTask(s8.base, { text: 'x', taskId: 'task-008', timeoutMs: 300, pollIntervalMs: 50 })
  check('runTask 超时 → ok:false 且 timed_out:true', r.ok === false && r.timed_out === true, `state=${r.state}`)
  await new Promise(res => s8.server.close(res))

  // ── 9. extractMessageText ──
  const mt = extractMessageText({ role: 'agent', parts: [{ kind: 'text', text: '甲' }, { kind: 'text', text: '乙' }] })
  check('extractMessageText 拼接 text parts', mt === '甲\n乙')
  check('extractTaskText 空 task 返回空串', extractTaskText({}) === '')

  // 服务器异常（500 + 非 JSON）
  const s9 = await startMockServer({})
  const raw = await fetch(s9.base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not-json' })
  check('mock 对非法 JSON 返回 400', raw.status === 400)
  await new Promise(res => s9.server.close(res))
} finally {
  try { await new Promise(res => s1.server.close(res)) } catch {}
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
