// office-memory.js —— 多Agent办公室长期记忆（会议纪要/决策/结论沉淀）
// 每次办公室重要结论写入 data/office-memory.json，后续所有 Agent 的上下文
// 都会注入最近记忆快照，避免"开完会就失忆"。轻量 JSON 文件存储，无外部依赖。
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { paths } from '../paths.js'
import { ingestText, search } from '../knowledge/index.js'
import { insertMemory } from '../db.js'

const MEM_FILE = path.join(paths.dataDir, 'office-memory.json')
const MAX_ITEMS = 100   // 最多保留 100 条，防止无限膨胀

let items = []

function load() {
  try {
    if (fs.existsSync(MEM_FILE)) {
      const raw = JSON.parse(fs.readFileSync(MEM_FILE, 'utf-8'))
      items = Array.isArray(raw) ? raw : []
    }
  } catch { items = [] }
}
function persist() {
  try { fs.mkdirSync(path.dirname(MEM_FILE), { recursive: true }); fs.writeFileSync(MEM_FILE, JSON.stringify(items.slice(-MAX_ITEMS), null, 2), 'utf-8') } catch {}
}

// 记一条办公室记忆：type ∈ decision(决策) | meeting(会议) | result(结论) | fact(事实)
// 向量记忆：同步写 JSON 快照（近期上下文），同时 ingest 进知识库（语义召回）。
export async function remember({ type = 'result', agent = '', content = '' }) {
  const text = String(content || '').trim()
  if (!text) return
  items.push({ ts: new Date().toISOString(), type, agent: String(agent || ''), content: text.slice(0, 2000) })
  items = items.slice(-MAX_ITEMS)
  persist()
  // 向量索引：失败不影响主流程（本地模型未就绪时知识库仍可 FTS 召回）
  try {
    const name = `office-memory-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    await ingestText({ name, text: `[${type}·${agent}] ${text}`, format: 'text' })
  } catch { /* 忽略 */ }

  // 会议对话进主记忆库 → 球形图谱自动出现会议节点（nodeData 来自 /memories）
  try {
    const memId = `office-${type}-${crypto.createHash('sha1').update(String(agent) + text.slice(0, 80)).digest('hex').slice(0, 12)}-${Date.now().toString(36)}`
    insertMemory({
      event_type: 'office',
      title: `${type}·${agent}`,
      content: text,
      mem_id: memId,
      entities: [agent ? `agent:${agent}` : 'agent:office', `topic:${type}`],
      tags: ['office', type, agent || ''],
      source_ref: 'multi-agent-office',
    })
  } catch { /* 忽略 */ }
}

// 语义召回：按当前任务/话题检索全部历史记忆（向量 + FTS 混合），返回最相关几条文本。
export async function searchMemory(query, limit = 4) {
  try {
    const r = await search(String(query || '').trim(), { limit: Math.min(Math.max(Number(limit) || 4, 1), 8) })
    if (!r.ok || !Array.isArray(r.results) || !r.results.length) return ''
    const seen = new Set()
    const out = []
    for (const item of r.results) {
      const t = String(item?.text || '').trim()
      if (!t || seen.has(t)) continue
      seen.add(t)
      out.push(t.slice(0, 600))
      if (out.length >= limit) break
    }
    return out.join('\n')
  } catch { return '' }
}

// 取最近 N 条记忆的文本快照（注入 Agent 上下文用）
export function getMemorySnapshot(limit = 8) {
  const recent = items.slice(-limit)
  if (!recent.length) return ''
  return recent.map(m => `[${m.ts.slice(0, 16).replace('T', ' ')}·${m.type}${m.agent ? '·' + m.agent : ''}] ${m.content}`).join('\n')
}

// P1-5：滚动"会议摘要"——旧消息压缩后只保留这一条，替代直接硬丢弃
export function setSummary(text) {
  const content = String(text || '').trim()
  items = items.filter(m => m.type !== 'summary')          // 替换旧摘要
  if (content) items.push({ ts: new Date().toISOString(), type: 'summary', agent: '会议摘要', content: content.slice(0, 4000) })
  items = items.slice(-MAX_ITEMS)
  persist()
}

// 清空记忆
export function clearMemory() {
  items = []
  persist()
}

load()
