// run-eval.mjs —— 行为级评估 runner
//
// 对 benchmarks.json 里每个任务：通过后端主循环发送消息，SSE 监听工具调用与最终回复，
// 检查是否符合期望（命中期望工具 / 未误用重工具 / 写后读回等）。
//
// 前置：后端已启动（npm run start:backend）且已激活（有 LLM API key）。
// 未激活时自动跳过（与 test-runner 一致）。
// 运行：node scripts/eval-bench/run-eval.mjs [--filter=file-write-verify]
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BAILONGMA_API_BASE || 'http://127.0.0.1:3721'
const TASK_TIMEOUT_MS = Number(process.env.EVAL_TASK_TIMEOUT || 45000)

let pass = 0, fail = 0, skip = 0
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS: ${label}${detail ? ' | ' + detail : ''}`) }
  else { fail++; console.log(`FAIL: ${label}${detail ? ' | ' + detail : ''}`) }
}

// 订阅 SSE，收集 action 工具事件（返回清理函数）
async function listenActions(onAction) {
  const controller = new AbortController()
  const res = await fetch(`${BASE}/events`, { signal: controller.signal })
  if (!res.ok || !res.body) throw new Error(`SSE 连接失败 HTTP ${res.status}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  ;(async () => {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data: ')) continue
            try {
              const evt = JSON.parse(line.slice(6))
              if (evt.type === 'action' && evt.data?.tool) onAction(evt.data.tool)
            } catch {}
          }
        }
      }
    } catch {}
  })()
  return () => controller.abort()
}

// 等待一条 jarvis 回复（SSE message 事件），或超时
function waitForReply(timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs)
    const onMsg = (msg) => {
      if (msg.type === 'message' && msg.data?.from === 'jarvis') {
        clearTimeout(timer)
        cleanup()
        resolve(msg.data)
      }
    }
    const cleanup = () => {}
    // 用 fetch SSE 实现 message 监听（简化：复用 listenActions 的 fetch）
    fetch(`${BASE}/events`).then(res => {
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let b = ''
      const pump = () => reader.read().then(({ done, value }) => {
        if (done) { resolve(null); return }
        b += dec.decode(value, { stream: true })
        let i
        while ((i = b.indexOf('\n\n')) >= 0) {
          const chunk = b.slice(0, i); b = b.slice(i + 2)
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data: ')) continue
            try { const evt = JSON.parse(line.slice(6)); onMsg(evt) } catch {}
          }
        }
        pump()
      }).catch(() => {})
      pump()
    }).catch(() => {})
  })
}

async function runTask(task) {
  const toolsUsed = new Set()
  const stopListen = await listenActions((tool) => toolsUsed.add(tool))
  try {
    const res = await fetch(`${BASE}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: task.input, from_id: 'ID:000001' }),
    })
    if (!res.ok) { check(`[${task.id}] 发送失败`, false, `HTTP ${res.status}`); return }
    await waitForReply(TASK_TIMEOUT_MS)
  } finally {
    stopListen()
  }

  const tools = [...toolsUsed]
  const expect = task.expect || {}
  const hitExpected = (expect.tools || []).some(t => tools.includes(t))
  const requireBoth = expect.requireBoth === true
  const allExpected = (expect.tools || []).every(t => tools.includes(t))
  // 禁止调用的工具（对抗测试：注入/危险指令应被拒，不应触发这些工具）
  const forbidden = [...(expect.forbidTools || []), ...(expect.noHeavyTools || [])]
    .filter(t => tools.includes(t))

  const ok = requireBoth ? allExpected : hitExpected
  check(`[${task.id}] ${task.input.slice(0, 40)}`, ok && forbidden.length === 0,
    `tools=[${tools.join(',')}]${forbidden.length ? ` 违规调用:${forbidden.join(',')}` : ''}`)
}

async function main() {
  // 后端可达性 + 激活检查
  let activated = false
  try {
    const resp = await fetch(`${BASE}/activation-status`, { signal: AbortSignal.timeout(3000) })
    const data = await resp.json()
    activated = data?.activated === true
  } catch {}

  if (!activated) {
    console.log('SKIP: 后端未激活（无 LLM API key）——行为级评估需真实 LLM，跳过')
    skip++
    console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`)
    process.exit(0)
  }

  const bench = JSON.parse(fs.readFileSync(path.join(__dirname, 'benchmarks.json'), 'utf-8'))
  // 对抗测试集（prompt injection / 危险指令 / 系统提示泄露）——存在则并入
  const adversarialPath = path.join(__dirname, 'adversarial.json')
  const adversarial = fs.existsSync(adversarialPath)
    ? JSON.parse(fs.readFileSync(adversarialPath, 'utf-8'))
    : { tasks: [] }

  const filter = process.argv.find(a => a.startsWith('--filter='))?.split('=')[1]
  const allTasks = [...bench.tasks, ...adversarial.tasks]
  const tasks = filter ? allTasks.filter(t => t.id === filter) : allTasks
  console.log(`运行 ${tasks.length} 个评估任务（${bench.tasks.length} 行为 + ${adversarial.tasks.length} 对抗）...`)

  for (const task of tasks) {
    await runTask(task)
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main()
