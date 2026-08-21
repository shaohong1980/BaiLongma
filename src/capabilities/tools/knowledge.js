// tools/knowledge.js —— 知识库工具执行器（P0: RAG）
import path from 'path'
import { SANDBOX_ROOT, assertInSandbox, normalizeSandboxPath } from '../sandbox.js'
import { ingestFile, ingestText, search, listDocs, deleteDoc, getStats, getSupportedFormats } from '../../knowledge/index.js'

function toolJson(payload) {
  return JSON.stringify(payload, null, 2)
}

// knowledge_ingest：导入文档（文件或文本）
export async function execKnowledgeIngest(args = {}, _context = {}) {
  const source = String(args.source || '').trim()
  if (!source) return toolJson({ ok: false, tool: 'knowledge_ingest', error: '缺少 source（文件路径或文本内容）' })

  const sourceType = String(args.source_type || 'file').trim()

  try {
    if (sourceType === 'text') {
      const name = String(args.name || '').trim()
      if (!name) return toolJson({ ok: false, tool: 'knowledge_ingest', error: 'source_type=text 时必须提供 name' })
      const format = String(args.format || 'text').trim()
      const result = await ingestText({ name, text: source, format })
      return toolJson(result)
    }

    // file 模式：路径必须在沙箱内
    const filePath = normalizeSandboxPath(source)
    const resolved = path.resolve(SANDBOX_ROOT, filePath)
    assertInSandbox(resolved)

    const result = await ingestFile(resolved, {
      chunkSize: args.chunk_size ? Number(args.chunk_size) : undefined,
    })
    return toolJson(result)
  } catch (err) {
    if (err.message?.includes('沙箱') || err.code === 'EPERM') {
      return toolJson({ ok: false, tool: 'knowledge_ingest', error: err.message, hint: '文件必须在沙箱目录内。请先把文件放到 sandbox/ 下再导入。' })
    }
    return toolJson({ ok: false, tool: 'knowledge_ingest', error: `导入失败: ${err.message}` })
  }
}

// knowledge_search：混合检索
export async function execKnowledgeSearch(args = {}) {
  const query = String(args.query || '').trim()
  if (!query) return toolJson({ ok: false, tool: 'knowledge_search', error: '缺少 query' })

  const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 20)
  const docId = args.doc_id ? String(args.doc_id).trim() : null

  try {
    const result = await search(query, { limit, docId })
    // 格式化输出：每个结果包含文本片段、来源、相似度
    const formatted = {
      ok: true,
      tool: 'knowledge_search',
      query: result.query,
      total: result.total,
      returned: result.returned,
      vector_enabled: result.vector_enabled,
      results: result.results.map(r => ({
        id: r.id,
        doc_id: r.doc_id,
        chunk_index: r.chunk_index,
        score: r.scores.combined,
        text: r.text.slice(0, 1200), // 限制单块长度，避免 token 爆炸
        text_truncated: r.text.length > 1200,
        metadata: r.metadata,
      })),
    }
    if (result.total === 0) {
      formatted.hint = '知识库中未找到相关内容。可用 knowledge_ingest 导入文档，或换个关键词试试。'
    }
    return toolJson(formatted)
  } catch (err) {
    return toolJson({ ok: false, tool: 'knowledge_search', error: `检索失败: ${err.message}` })
  }
}

// knowledge_list：列出文档
export function execKnowledgeList(args = {}) {
  const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 200)
  const offset = Math.max(Number(args.offset) || 0, 0)
  try {
    const result = listDocs({ limit, offset })
    return toolJson({
      ok: true,
      tool: 'knowledge_list',
      total: result.total,
      docs: result.docs.map(d => ({
        id: d.id,
        name: d.name,
        format: d.format,
        chunks: d.chunks,
        chars: d.chars,
        size: d.size,
        status: d.status,
        created_at: d.created_at,
      })),
    })
  } catch (err) {
    return toolJson({ ok: false, tool: 'knowledge_list', error: err.message })
  }
}

// knowledge_delete：删除文档
export function execKnowledgeDelete(args = {}) {
  const docId = String(args.doc_id || '').trim()
  if (!docId) return toolJson({ ok: false, tool: 'knowledge_delete', error: '缺少 doc_id' })
  try {
    const result = deleteDoc(docId)
    return toolJson(result)
  } catch (err) {
    return toolJson({ ok: false, tool: 'knowledge_delete', error: err.message })
  }
}

// knowledge_stats：统计
export function execKnowledgeStats() {
  try {
    const stats = getStats()
    const formats = getSupportedFormats()
    return toolJson({
      ...stats,
      tool: 'knowledge_stats',
      supported_formats: {
        text: formats.text,
        openxml: formats.openxml,
        pdf: formats.pdf,
      },
    })
  } catch (err) {
    return toolJson({ ok: false, tool: 'knowledge_stats', error: err.message })
  }
}
