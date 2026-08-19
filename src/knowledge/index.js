// knowledge/index.js —— 知识库统一入口
//
// 对外暴露：
//   initKnowledge(db)           : 初始化表结构
//   ingestFile(filePath)        : 从文件导入文档（解析→分块→入库）
//   ingestText({name, text})    : 从纯文本导入
//   search(query, opts)         : 混合检索
//   listDocs(opts)              : 列出文档
//   getDoc(docId)               : 获取文档详情
//   deleteDoc(docId)            : 删除文档
//   getStats()                  : 统计信息

import fs from 'fs'
import path from 'path'
import { parseDocument, getSupportedFormats } from './parsers.js'
import { chunkDocument, DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_OVERLAP } from './chunker.js'
import {
  ingestDocument,
  searchKnowledge,
  listKnowledgeDocs,
  getKnowledgeDoc,
  deleteKnowledgeDoc,
  getKnowledgeStats,
} from './store.js'

// 注：knowledge 表结构统一在 src/db/schema.js 初始化（initializeSchema），
// 这里不再导出 initKnowledgeSchema，避免双份定义漂移。
export { getSupportedFormats, DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_OVERLAP }

// 从文件导入：自动识别格式 → 解析 → 分块 → 入库
export async function ingestFile(filePath, { chunkSize, overlap } = {}) {
  if (!fs.existsSync(filePath)) {
    return { ok: false, error: `文件不存在: ${filePath}` }
  }

  const stat = fs.statSync(filePath)
  if (stat.isDirectory()) {
    return { ok: false, error: '路径是目录，请指定文件' }
  }

  const name = path.basename(filePath)
  const ext = path.extname(filePath).toLowerCase()

  // 解析文档
  const parsed = parseDocument(filePath)
  if (!parsed.ok) {
    return { ok: false, error: parsed.error, name, format: ext }
  }

  // 分块
  const chunks = chunkDocument(parsed.text, {
    format: parsed.metadata.format || ext,
    chunkSize: chunkSize || DEFAULT_CHUNK_SIZE,
    overlap: overlap || DEFAULT_CHUNK_OVERLAP,
    docId: name,
  })

  if (chunks.length === 0) {
    return { ok: false, error: '文档解析后为空，无法导入', name, format: ext }
  }

  // 入库
  return await ingestDocument({
    name,
    sourcePath: filePath,
    text: parsed.text,
    format: parsed.metadata.format || ext,
    metadata: { ...parsed.metadata, size: stat.size },
    chunks,
  })
}

// 从纯文本导入（用户直接粘贴文本或 API 传入）
export async function ingestText({ name, text, format = 'text', sourcePath = '' } = {}) {
  if (!name || !name.trim()) return { ok: false, error: '缺少 name' }
  if (!text || !text.trim()) return { ok: false, error: '缺少 text' }

  const chunks = chunkDocument(text, { format, docId: name })
  if (chunks.length === 0) return { ok: false, error: '文本为空，无法导入' }

  return await ingestDocument({
    name: name.trim(),
    sourcePath,
    text,
    format,
    metadata: { chars: text.length },
    chunks,
  })
}

export async function search(query, opts) {
  return await searchKnowledge(query, opts)
}

export function listDocs(opts) {
  return listKnowledgeDocs(opts)
}

export function getDoc(docId) {
  return getKnowledgeDoc(docId)
}

export function deleteDoc(docId) {
  return deleteKnowledgeDoc(docId)
}

export function getStats() {
  return getKnowledgeStats()
}
