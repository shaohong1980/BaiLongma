import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { paths } from '../paths.js'

const __filename = fileURLToPath(import.meta.url)

// 纯 JSON 文件存储，不依赖 better-sqlite3。
// 用 paths.dataDir 而不是 __dirname 硬编码：paths.dataDir 尊重 BAILONGMA_USER_DIR（测试隔离），
// 且在打包后的 Electron 里指向可写的 userData/data（应用目录是只读的，硬编码路径会写失败）。
const DATA_DIR = paths.dataDir
const STATE_FILE = join(DATA_DIR, 'self_evolution_state.json')
const MEMORY_FILE = join(DATA_DIR, 'self_evolution_memories.json')

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
}

function readJsonFile(filePath, fallback = null) {
  try {
    if (!existsSync(filePath)) return fallback
    return JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch {
    return fallback
  }
}

function writeJsonFile(filePath, data) {
  ensureDataDir()
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
}

// ========== 本地存储层（替代 db.js） ==========

function getConfig(key) {
  const state = readJsonFile(STATE_FILE, {})
  return state[key] ?? null
}

function setConfig(key, value) {
  const state = readJsonFile(STATE_FILE, {})
  state[key] = value
  writeJsonFile(STATE_FILE, state)
}

// 自进化记忆文件的上限：超过就裁掉最旧的（每个 mem_id 只留一份，按写入时间近似用数组顺序）。
// 之前这个文件无限增长——每次任务自评都 push，`state.recent` 有 24 条上限但这里没有。
const MAX_EVOLUTION_MEMORIES = 200

function upsertMemoryByMemId(memory) {
  const memories = readJsonFile(MEMORY_FILE, [])
  const idx = memories.findIndex(m => m.mem_id === memory.mem_id)
  if (idx >= 0) {
    memories[idx] = { ...memories[idx], ...memory }
  } else {
    memories.push(memory)
  }
  // 裁剪上限：保留最近 MAX_EVOLUTION_MEMORIES 条（数组按追加顺序，新条目在后）
  if (memories.length > MAX_EVOLUTION_MEMORIES) {
    memories.splice(0, memories.length - MAX_EVOLUTION_MEMORIES)
  }
  writeJsonFile(MEMORY_FILE, memories)
}

// ========== 原有逻辑（不变） ==========

const STATE_KEY = 'self_evolution_state_v1'
const STATE_VERSION = 1
const MAX_RECENT = 24
const PROMPT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

const ACTIONABLE_TAGS = new Set([
  'kind:procedure',
  'kind:constraint',
  'kind:failure_lesson',
  'kind:policy',
])

const ACTIONABLE_EVENT_TYPES = new Set([
  'self_constraint',
])

const ACTIONABLE_MEM_ID_RE = /^(procedure|constraint|policy|lesson|rule)_/i

function defaultState() {
  return {
    version: STATE_VERSION,
    enabled: true,
    total_events: 0,
    learned_count: 0,
    last_at: null,
    recent: [],
  }
}

function safeJsonArray(value) {
  if (Array.isArray(value)) return value
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function safeJsonObject(value) {
  if (!value) return null
  if (typeof value === 'object') return value
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function normalizeState(raw) {
  const parsed = safeJsonObject(raw) || {}
  const recent = Array.isArray(parsed.recent) ? parsed.recent : []
  return {
    ...defaultState(),
    ...parsed,
    version: STATE_VERSION,
    enabled: parsed.enabled !== false,
    total_events: Math.max(0, Number(parsed.total_events) || 0),
    learned_count: Math.max(0, Number(parsed.learned_count) || 0),
    recent: recent
      .filter(entry => entry && entry.mem_id)
      .slice(0, MAX_RECENT),
  }
}

function saveState(state) {
  const normalized = normalizeState(state)
  normalized.recent = normalized.recent.slice(0, MAX_RECENT)
  setConfig(STATE_KEY, JSON.stringify(normalized))
  return normalized
}

function truncate(text, max = 220) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max - 1)}...` : value
}

function tagKind(tags = []) {
  const kindTag = tags.find(tag => String(tag).startsWith('kind:'))
  if (!kindTag) return ''
  return String(kindTag).slice('kind:'.length)
}

function memoryToEntry(memory, source = {}) {
  const tags = safeJsonArray(memory.tags).map(String)
  const kind = tagKind(tags)
    || (memory.event_type === 'self_constraint' ? 'constraint' : '')
    || ((memory.mem_id || '').match(ACTIONABLE_MEM_ID_RE)?.[1] || 'policy').toLowerCase()
  return {
    mem_id: memory.mem_id || source.mem_id || `row:${memory.id}`,
    kind,
    action: source.action || 'observed',
    title: truncate(memory.title || memory.content || source.title || 'Self-evolution update', 96),
    content: truncate(memory.content || source.content || '', 240),
    salience: Number(memory.salience || source.salience || 3),
    tags,
    learned_at: new Date().toISOString(),
  }
}

export function getSelfEvolutionState() {
  return normalizeState(getConfig(STATE_KEY))
}

export function getSelfEvolutionSnapshot({ maxRecent = MAX_RECENT } = {}) {
  const state = getSelfEvolutionState()
  return {
    enabled: state.enabled,
    version: state.version,
    total_events: state.total_events,
    learned_count: state.learned_count,
    last_at: state.last_at,
    recent: state.recent.slice(0, Math.max(0, Math.min(Number(maxRecent) || MAX_RECENT, MAX_RECENT))),
  }
}

export function resetSelfEvolutionState() {
  return saveState(defaultState())
}

export function isSelfEvolutionMemory(memory = {}) {
  if (!memory || typeof memory !== 'object') return false
  const tags = safeJsonArray(memory.tags).map(String)
  if (tags.some(tag => ACTIONABLE_TAGS.has(tag))) return true
  if (ACTIONABLE_EVENT_TYPES.has(memory.event_type || memory.type)) return true
  return ACTIONABLE_MEM_ID_RE.test(memory.mem_id || '')
}

export async function recordSelfEvolutionFromMemories(memories = [], { emitEvent = null } = {}) {
  if (!Array.isArray(memories) || memories.length === 0) return []

  const state = getSelfEvolutionState()
  if (state.enabled === false) return []

  const learned = []
  const seen = new Set()

  for (const item of memories) {
    const memId = item?.mem_id || item?.id
    if (!memId || seen.has(memId)) continue
    seen.add(memId)

    let full = null
    try {
      // 输入是 recognizer 写入 SQLite 的记忆；须从 SQLite 读完整行（含 tags/content），
      // 才能正确派生 kind。不能用自己的 JSON 存储（self_evolution_memories.json）——
      // 那里只存 self_evaluated 的条目，读不到 recognizer 提取的记忆，会导致回退到
      // 稀疏的 item 而丢失 kind:* 标签（kind 退化成 mem_id 的粗糙匹配）。
      const { getMemoryByMemId: getSqliteMemory } = await import('../db.js')
      full = getSqliteMemory(memId)
    } catch {}
    const memory = full || item
    if (!isSelfEvolutionMemory(memory)) continue
    learned.push(memoryToEntry(memory, item))
  }

  if (learned.length === 0) return []

  const now = new Date().toISOString()
  const byId = new Map()
  for (const entry of learned) byId.set(entry.mem_id, entry)
  for (const entry of state.recent) {
    if (!byId.has(entry.mem_id)) byId.set(entry.mem_id, entry)
  }

  const nextRecent = [...byId.values()]
    .sort((a, b) => String(b.learned_at || '').localeCompare(String(a.learned_at || '')))
    .slice(0, MAX_RECENT)

  const nextState = saveState({
    ...state,
    total_events: state.total_events + learned.length,
    learned_count: nextRecent.length,
    last_at: now,
    recent: nextRecent,
  })

  if (typeof emitEvent === 'function') {
    emitEvent('self_evolution', {
      count: learned.length,
      entries: learned,
      summary: getSelfEvolutionSnapshot({ maxRecent: 5 }),
    })
  }

  return learned.map(entry => ({ ...entry, total_events: nextState.total_events }))
}

export function formatSelfEvolutionForPrompt({
  maxRecent = 3,
  maxAgeMs = PROMPT_MAX_AGE_MS,
} = {}) {
  const state = getSelfEvolutionState()
  if (state.enabled === false || state.recent.length === 0) return ''

  const cutoff = Date.now() - maxAgeMs
  const recent = state.recent
    .filter(entry => {
      if (!entry?.learned_at) return true
      const t = Date.parse(entry.learned_at)
      return Number.isNaN(t) || t >= cutoff
    })
    .slice(0, Math.max(1, Math.min(Number(maxRecent) || 3, 8)))

  if (recent.length === 0) return ''

  const lines = recent.map(entry => {
    const title = entry.title ? `${entry.title}: ` : ''
    return `- [${entry.kind || 'policy'}] ${entry.mem_id}: ${title}${entry.content || ''}`
  })

  return [
    'Self-evolution loop is active. It stores reusable procedures, constraints, and failure lessons as long-term policy memories. It does not rewrite source code or change permissions by itself.',
    'Recent behavior updates:',
    ...lines,
    'Use this as provenance. Turn-specific guidance still comes from <active-policies> when a learned policy matches the current situation.',
  ].join('\n')
}

// ========== 自我评估自动化 ==========

const EVAL_MEM_ID_PREFIX = 'self_eval_';
const EVAL_MAX_HISTORY = 50;

export function evaluateTask({ taskId, taskDesc, accuracy, efficiency, satisfaction, note } = {}) {
  if (!taskId || !taskDesc) return null;

  const state = getSelfEvolutionState();
  if (state.enabled === false) return null;

  const a = Math.max(1, Math.min(10, Math.round(Number(accuracy) || 5)));
  const e = Math.max(1, Math.min(10, Math.round(Number(efficiency) || 5)));
  const s = Math.max(1, Math.min(10, Math.round(Number(satisfaction) || 5)));
  const avg = Math.round((a + e + s) / 3);
  const now = new Date().toISOString();
  const safeId = taskId.replace(/[^a-zA-Z0-9_\u4e00-\u9fff-]/g, '_').slice(0, 80);
  const memId = EVAL_MEM_ID_PREFIX + safeId;

  const reflection = note || (
    avg >= 8 ? '任务完成良好，策略有效，可复用。' :
    avg >= 5 ? '任务基本完成，有优化空间。' :
    '任务完成度偏低，需调整策略。'
  );

  const content = [
    '【任务评估】' + truncate(taskDesc, 120),
    '准确性:' + a + '/10  效率:' + e + '/10  满意度:' + s + '/10  综合:' + avg + '/10',
    '反思: ' + reflection,
  ].join(' | ');

  const memory = {
    mem_id: memId,
    type: 'self_constraint',
    event_type: 'self_constraint',
    title: '任务评估: ' + truncate(taskDesc, 60),
    content: content,
    salience: avg >= 7 ? 4 : avg >= 4 ? 3 : 2,
    tags: ['kind:policy', 'self_evaluation', 'auto'],
    detail: JSON.stringify({
      taskId,
      taskDesc: truncate(taskDesc, 200),
      scores: { accuracy: a, efficiency: e, satisfaction: s, average: avg },
      reflection,
      evaluated_at: now,
    }),
  };

  try {
    upsertMemoryByMemId(memory);
  } catch (err) {
    console.error('[self-evolution] evaluateTask upsert failed:', err.message);
    return null;
  }

  const entry = memoryToEntry(memory, { action: 'self_evaluated' });
  const byId = new Map();
  byId.set(entry.mem_id, entry);
  for (const e of state.recent) {
    if (!byId.has(e.mem_id)) byId.set(e.mem_id, e);
  }
  const nextRecent = [...byId.values()]
    .sort((a, b) => String(b.learned_at || '').localeCompare(String(a.learned_at || '')))
    .slice(0, MAX_RECENT);

  saveState({
    ...state,
    total_events: state.total_events + 1,
    learned_count: nextRecent.length,
    last_at: now,
    recent: nextRecent,
  });

  return { mem_id: memId, scores: { accuracy: a, efficiency: e, satisfaction: s, average: avg } };
}

export function getRecentEvaluations({ limit = 10 } = {}) {
  const state = getSelfEvolutionState();
  return state.recent
    .filter(e => e.mem_id && e.mem_id.startsWith(EVAL_MEM_ID_PREFIX))
    .slice(0, Math.max(1, Math.min(Number(limit) || 10, EVAL_MAX_HISTORY)));
}

// 任务完成时自动触发自我评估（live 路径统一入口）。
// 原来自动评估只写在 test-only 的 task-manager.js 里，主流程（index.js 的 onCompleteTask /
// CLEAR_TASK）从未真正调用——这里抽出共享入口，让 evaluateTask 在真实任务完成时生效。
// best-effort：任何失败吞掉，绝不影响任务收尾。
export function triggerTaskSelfEval(taskDesc, reason) {
  try {
    const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const result = evaluateTask({
      taskId,
      taskDesc: taskDesc || '(未命名任务)',
      accuracy: 5,
      efficiency: 5,
      satisfaction: 5,
      note: `自动评估（原因: ${reason || '任务完成'}）。审视分身尚未介入，默认中等分，后续可由审视分身覆盖。`,
    })
    if (result) {
      console.log(`[self-evolution] 自动评估完成: ${result.mem_id} | 综合 ${result.scores.average}/10`)
    }
    return result
  } catch (err) {
    console.error('[self-evolution] 自动评估失败:', err.message)
    return null
  }
}

// ========== 测试入口 ==========

export async function runTest() {
  console.log('=== self-evolution 测试（JSON 存储模式）===\n');

  // 1. 测试 evaluateTask
  console.log('[1] 测试 evaluateTask...');
  const result = evaluateTask({
    taskId: 'test_001',
    taskDesc: '测试任务：验证自我评估写入',
    accuracy: 8,
    efficiency: 7,
    satisfaction: 9,
    note: '手动测试，一切正常。',
  });

  if (result) {
    console.log('  ✅ evaluateTask 成功');
    console.log('  mem_id:', result.mem_id);
    console.log('  scores:', JSON.stringify(result.scores));
  } else {
    console.log('  ❌ evaluateTask 返回 null');
  }

  // 2. 测试 getRecentEvaluations
  console.log('\n[2] 测试 getRecentEvaluations...');
  const evals = getRecentEvaluations({ limit: 5 });
  console.log('  最近评估记录数:', evals.length);
  evals.forEach((e, i) => {
    console.log(`  [${i + 1}] ${e.mem_id} | ${e.title || '(无标题)'}`);
  });

  // 3. 测试 getSelfEvolutionSnapshot
  console.log('\n[3] 测试 getSelfEvolutionSnapshot...');
  const snap = getSelfEvolutionSnapshot({ maxRecent: 5 });
  console.log('  enabled:', snap.enabled);
  console.log('  total_events:', snap.total_events);
  console.log('  learned_count:', snap.learned_count);
  console.log('  last_at:', snap.last_at);

  console.log('\n=== 测试完成 ===');
}

// 直接运行时执行测试
if (process.argv[1] === __filename) {
  runTest().catch(err => {
    console.error('测试失败:', err);
    process.exit(1);
  });
}
