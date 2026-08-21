// knowledge/store.js —— 知识库存储与检索
//
// 数据表：
//   knowledge_docs    : 文档元数据（id, name, path, format, size, chunks, status, created_at）
//   knowledge_chunks  : 分块内容（id, doc_id, chunk_index, text, metadata_json, embedding BLOB, embedding_dim）
//   knowledge_chunks_fts : FTS5 全文索引（trigram，中文子串可搜）
//
// 检索策略：混合检索
//   1. FTS5 全文检索 → top N 候选
//   2. 对候选计算向量余弦相似度（如果有 embedding）
//   3. 融合排序：score = 0.6 * normalized_fts + 0.4 * vector_sim
//   4. embedding 不可用时退化为纯 FTS5

import { getDB } from '../db.js'
import { computeEmbedding, isEmbeddingConfigured } from '../embedding.js'

const VECTOR_WEIGHT = 0.4
const FTS_WEIGHT = 0.6
const DEFAULT_SEARCH_LIMIT = 8
const MAX_FTS_CANDIDATES = 30

// 注：knowledge_docs / knowledge_chunks / FTS5 索引的表结构统一在 src/db/schema.js 初始化，
// 此处不再重复建表（避免双份定义漂移）。若某入口在 schema.js 未运行前用到本模块，
// 请先确保 initializeSchema(db) 已执行。

// ─── 工具函数 ──────────────────────────────────────────────────────
function generateDocId(name) {
  const safe = String(name || 'doc').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return `kb_${safe}_${Date.now().toString(36)}`
}

function cosineSimilarity(aBuf, bBuf) {
  if (!aBuf || !bBuf) return 0
  const a = new Float32Array(aBuf.buffer, aBuf.byteOffset, aBuf.byteLength / 4)
  const b = new Float32Array(bBuf.buffer, bBuf.byteOffset, bBuf.byteLength / 4)
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

// 转义 LIKE 通配符（% _ 和 ESCAPE 字符本身）
function escapeLike(text = '') {
  return String(text).replace(/[\\%_]/g, (c) => '\\' + c)
}

// ─── 文档导入 ──────────────────────────────────────────────────────
export async function ingestDocument({ name, sourcePath = '', text, format = 'text', metadata = {}, chunks = [] }) {
  const db = getDB()
  const docId = generateDocId(name)

  // 写入文档元数据
  db.prepare(`
    INSERT INTO knowledge_docs (id, name, source_path, format, size, chars, chunks, status, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?)
  `).run(docId, name, sourcePath, format, metadata.size || 0, text.length, chunks.length, JSON.stringify(metadata))

  // 写入分块（批量）
  const insertChunk = db.prepare(`
    INSERT INTO knowledge_chunks (id, doc_id, chunk_index, text, metadata_json)
    VALUES (?, ?, ?, ?, ?)
  `)

  const insertMany = db.transaction((chunkList) => {
    for (const chunk of chunkList) {
      insertChunk.run(chunk.id, docId, chunk.index, chunk.text, JSON.stringify(chunk.metadata || {}))
    }
  })
  insertMany(chunks)

  // 后台计算 embedding（fire-and-forget，不阻塞导入返回）
  if (isEmbeddingConfigured() && chunks.length > 0) {
    computeChunkEmbeddings(docId, chunks).catch(err => {
      console.warn(`[knowledge] embedding 计算失败: ${err.message}`)
    })
  }

  return {
    ok: true,
    doc_id: docId,
    name,
    chunks: chunks.length,
    chars: text.length,
    message: `文档已导入：${name}（${chunks.length} 个分块，${text.length} 字符）`,
  }
}

// 批量计算分块的 embedding 并写回
async function computeChunkEmbeddings(docId, chunks) {
  const db = getDB()
  const updateStmt = db.prepare(`
    UPDATE knowledge_chunks SET embedding = ?, embedding_dim = ? WHERE id = ?
  `)
  for (const chunk of chunks) {
    try {
      const buf = await computeEmbedding(chunk.text, { isQuery: false })
      if (buf) {
        updateStmt.run(buf, buf.length / 4, chunk.id)
      }
    } catch {
      // 单个分块 embedding 失败不影响其他
    }
  }
  console.log(`[knowledge] 文档 ${docId} 的 ${chunks.length} 个分块 embedding 计算完成`)
}

// ─── 混合检索 ──────────────────────────────────────────────────────
export async function searchKnowledge(query, { limit = DEFAULT_SEARCH_LIMIT, docId = null } = {}) {
  const db = getDB()
  const q = String(query || '').trim()
  if (!q) return { ok: true, results: [], total: 0 }

  // 1. FTS5 全文检索（trigram 要求每个 token ≥3 字符；中文双字词极常见，短 token 用 LIKE 兜底）
  let ftsResults = []
  const compactQuery = q.replace(/[\s,，。.!！?？、；;]+/g, '')  // 去空格/标点，让中文连续子串也能被 trigram 覆盖
  const queryTokens = q.split(/[\s,，。.!！?？、；;]+/g).map(t => t.trim()).filter(t => t.length > 0)
  if (compactQuery.length >= 3) {
    try {
      const ftsSql = docId
        ? `SELECT c.rowid as rowid, c.id, c.doc_id, c.chunk_index, c.text, c.metadata_json, c.embedding, c.embedding_dim,
                  bm25(knowledge_chunks_fts) as fts_score
           FROM knowledge_chunks_fts
           JOIN knowledge_chunks c ON c.rowid = knowledge_chunks_fts.rowid
           WHERE knowledge_chunks_fts MATCH ? AND c.doc_id = ?
           ORDER BY fts_score ASC LIMIT ?`
        : `SELECT c.rowid as rowid, c.id, c.doc_id, c.chunk_index, c.text, c.metadata_json, c.embedding, c.embedding_dim,
                  bm25(knowledge_chunks_fts) as fts_score
           FROM knowledge_chunks_fts
           JOIN knowledge_chunks c ON c.rowid = knowledge_chunks_fts.rowid
           WHERE knowledge_chunks_fts MATCH ?
           ORDER BY fts_score ASC LIMIT ?`
      // trigram 匹配短语时用引号包裹整个紧凑串，避免空格被当成 token 分隔后丢弃短 token
      const ftsQuery = queryTokens.length > 1 ? `"${compactQuery}"` : compactQuery
      ftsResults = docId
        ? db.prepare(ftsSql).all(ftsQuery, docId, MAX_FTS_CANDIDATES)
        : db.prepare(ftsSql).all(ftsQuery, MAX_FTS_CANDIDATES)
    } catch {
      ftsResults = []
    }
  }

  // FTS 无结果或查询太短：按 token 做 OR LIKE 兜底（中文双字词 / 分词后子串都能命中）
  if (ftsResults.length === 0 && queryTokens.length > 0) {
    const likePatterns = queryTokens.map(t => `%${escapeLike(t)}%`)
    const likeWhere = likePatterns.map(() => 'text LIKE ?').join(' OR ')
    const likeSql = docId
      ? `SELECT rowid, id, doc_id, chunk_index, text, metadata_json, embedding, embedding_dim, 0 as fts_score
         FROM knowledge_chunks WHERE (${likeWhere}) AND doc_id = ? ORDER BY rowid DESC LIMIT ?`
      : `SELECT rowid, id, doc_id, chunk_index, text, metadata_json, embedding, embedding_dim, 0 as fts_score
         FROM knowledge_chunks WHERE (${likeWhere}) ORDER BY rowid DESC LIMIT ?`
    const params = docId ? [...likePatterns, docId, MAX_FTS_CANDIDATES] : [...likePatterns, MAX_FTS_CANDIDATES]
    ftsResults = db.prepare(likeSql).all(...params)
  }

  // 兜底最后一层：仍无结果时退化为整串子串匹配（用户可能复制了整段原文）
  if (ftsResults.length === 0 && compactQuery) {
    const likeSql = docId
      ? `SELECT rowid, id, doc_id, chunk_index, text, metadata_json, embedding, embedding_dim, 0 as fts_score
         FROM knowledge_chunks WHERE text LIKE ? AND doc_id = ? ORDER BY rowid DESC LIMIT ?`
      : `SELECT rowid, id, doc_id, chunk_index, text, metadata_json, embedding, embedding_dim, 0 as fts_score
         FROM knowledge_chunks WHERE text LIKE ? ORDER BY rowid DESC LIMIT ?`
    ftsResults = docId
      ? db.prepare(likeSql).all(`%${compactQuery}%`, docId, MAX_FTS_CANDIDATES)
      : db.prepare(likeSql).all(`%${compactQuery}%`, MAX_FTS_CANDIDATES)
  }

  // FTS 无候选但向量可用：向量独立召回兜底（中文语义查询的关键路径，修复"语义搜不到"）
  if (ftsResults.length === 0 && isEmbeddingConfigured()) {
    let vecQuery = null
    try { vecQuery = await computeEmbedding(q, { isQuery: true }) } catch { vecQuery = null }
    if (vecQuery) {
      const dim = vecQuery.length / 4
      const vecRows = docId
        ? db.prepare(`SELECT rowid, id, doc_id, chunk_index, text, metadata_json, embedding, embedding_dim
                      FROM knowledge_chunks WHERE doc_id = ? AND embedding IS NOT NULL AND embedding_dim = ?`).all(docId, dim)
        : db.prepare(`SELECT rowid, id, doc_id, chunk_index, text, metadata_json, embedding, embedding_dim
                      FROM knowledge_chunks WHERE embedding IS NOT NULL AND embedding_dim = ?`).all(dim)
      const vecScored = vecRows
        .map(row => ({ row, sim: cosineSimilarity(vecQuery, row.embedding) }))
        .filter(x => x.sim > 0)
        .sort((a, b) => b.sim - a.sim)
        .slice(0, limit)
      if (vecScored.length > 0) {
        const results = vecScored.map(({ row, sim }) => ({
          id: row.id, doc_id: row.doc_id, chunk_index: row.chunk_index, text: row.text,
          metadata: safeParseJson(row.metadata_json),
          scores: { fts: 0, fts_normalized: 0, vector: Number(sim.toFixed(4)), combined: Number((VECTOR_WEIGHT * sim).toFixed(4)) },
        }))
        return { ok: true, query: q, total: results.length, returned: results.length, vector_enabled: true, results }
      }
    }
    return { ok: true, results: [], total: 0, query: q }
  }

  if (ftsResults.length === 0) {
    return { ok: true, results: [], total: 0, query: q }
  }

  // 2. 向量相似度（如果 query embedding 可用且候选有 embedding）
  let queryEmbedding = null
  const hasEmbeddings = ftsResults.some(r => r.embedding && r.embedding_dim)
  if (hasEmbeddings && isEmbeddingConfigured()) {
    try {
      queryEmbedding = await computeEmbedding(q, { isQuery: true })
    } catch {
      queryEmbedding = null
    }
  }

  // 3. 融合排序
  const maxFtsScore = Math.max(...ftsResults.map(r => Math.abs(Number(r.fts_score) || 0)), 1)
  const scored = ftsResults.map(row => {
    const ftsNorm = 1 - (Math.abs(Number(row.fts_score) || 0) / maxFtsScore) // bm25 越小越好，归一化到 [0,1]
    let vecSim = 0
    if (queryEmbedding && row.embedding && row.embedding_dim === queryEmbedding.length / 4) {
      vecSim = cosineSimilarity(queryEmbedding, row.embedding)
    }
    const combined = FTS_WEIGHT * ftsNorm + VECTOR_WEIGHT * vecSim
    return {
      id: row.id,
      doc_id: row.doc_id,
      chunk_index: row.chunk_index,
      text: row.text,
      metadata: safeParseJson(row.metadata_json),
      scores: {
        fts: Number(row.fts_score) || 0,
        fts_normalized: Number(ftsNorm.toFixed(4)),
        vector: Number(vecSim.toFixed(4)),
        combined: Number(combined.toFixed(4)),
      },
    }
  })

  scored.sort((a, b) => b.scores.combined - a.scores.combined)
  const results = scored.slice(0, limit)

  return {
    ok: true,
    query: q,
    total: scored.length,
    returned: results.length,
    vector_enabled: !!queryEmbedding,
    results,
  }
}

function safeParseJson(str) {
  try { return JSON.parse(str) } catch { return {} }
}

// ─── 文档管理 ──────────────────────────────────────────────────────
export function listKnowledgeDocs({ limit = 50, offset = 0 } = {}) {
  const db = getDB()
  const docs = db.prepare(`
    SELECT id, name, source_path, format, size, chars, chunks, status, error, created_at, updated_at
    FROM knowledge_docs
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset)
  const total = db.prepare('SELECT COUNT(*) AS c FROM knowledge_docs').get().c
  return { ok: true, docs, total, limit, offset }
}

export function getKnowledgeDoc(docId) {
  const db = getDB()
  const doc = db.prepare('SELECT * FROM knowledge_docs WHERE id = ?').get(docId)
  if (!doc) return null
  const chunks = db.prepare(`
    SELECT id, chunk_index, text, metadata_json, embedding IS NOT NULL as has_embedding
    FROM knowledge_chunks WHERE doc_id = ? ORDER BY chunk_index ASC
  `).all(docId)
  return { ...doc, metadata: safeParseJson(doc.metadata), chunks }
}

export function deleteKnowledgeDoc(docId) {
  const db = getDB()
  const doc = db.prepare('SELECT id, name FROM knowledge_docs WHERE id = ?').get(docId)
  if (!doc) return { ok: false, error: `文档不存在: ${docId}` }
  // FTS trigger 会自动删除索引；chunks 因 ON DELETE CASCADE 自动删除
  db.prepare('DELETE FROM knowledge_docs WHERE id = ?').run(docId)
  return { ok: true, deleted: docId, name: doc.name, message: `已删除文档：${doc.name}` }
}

export function getKnowledgeStats() {
  const db = getDB()
  const docCount = db.prepare('SELECT COUNT(*) AS c FROM knowledge_docs').get().c
  const chunkCount = db.prepare('SELECT COUNT(*) AS c FROM knowledge_chunks').get().c
  const embeddedCount = db.prepare('SELECT COUNT(*) AS c FROM knowledge_chunks WHERE embedding IS NOT NULL').get().c
  const totalChars = db.prepare('SELECT COALESCE(SUM(chars), 0) AS s FROM knowledge_docs').get().s
  return {
    ok: true,
    docs: docCount,
    chunks: chunkCount,
    embedded_chunks: embeddedCount,
    embedding_coverage: chunkCount > 0 ? Number((embeddedCount / chunkCount * 100).toFixed(1)) : 0,
    total_chars: totalChars,
  }
}
