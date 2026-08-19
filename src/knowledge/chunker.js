// knowledge/chunker.js —— 文档分块器
//
// 分块策略：
//   1. 通用文本：按段落分割 → 合并到目标大小 → 滑动窗口重叠
//   2. 代码文件：按行分割，保持函数/类边界（启发式）
//   3. CSV/表格：按行分割，表头自动附加到每个块
//   4. Markdown：按标题（#/##/###）分割，标题路径附加到每个块
//
// 每个块返回：{ id, text, metadata: { index, start, end, heading_path?, row_range? } }

const DEFAULT_CHUNK_SIZE = 500      // 目标字符数
const DEFAULT_CHUNK_OVERLAP = 100   // 重叠字符数
const CODE_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.c', '.cpp', '.h', '.go', '.rs', '.sh', '.bash', '.ps1', '.sql', '.r'])

function stableChunkId(docId, index) {
  return `${docId}#chunk-${String(index).padStart(4, '0')}`
}

// ─── 通用文本分块（段落 + 滑动窗口）────────────────────────────────
function chunkByParagraph(text, { chunkSize = DEFAULT_CHUNK_SIZE, overlap = DEFAULT_CHUNK_OVERLAP } = {}) {
  // 按空行分割段落
  const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
  const chunks = []
  let current = ''
  let currentStart = 0

  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i]
    if (current.length + para.length + 2 <= chunkSize) {
      current += (current ? '\n\n' : '') + para
    } else {
      if (current) {
        chunks.push({ text: current, start: currentStart, end: currentStart + current.length })
        // 滑动窗口重叠：取当前块末尾 overlap 字符作为下一块的开头
        const overlapText = current.slice(-overlap)
        current = overlapText + '\n\n' + para
        currentStart = Math.max(0, currentStart + current.length - overlap - para.length - 2)
      } else {
        // 单段超过 chunkSize：强制按字符切
        const subChunks = chunkByCharacters(para, chunkSize, overlap)
        for (const sc of subChunks) chunks.push(sc)
        current = ''
      }
    }
  }
  if (current.trim()) chunks.push({ text: current, start: currentStart, end: currentStart + current.length })
  return chunks
}

// 按字符强制切分（超长段落兜底）
function chunkByCharacters(text, chunkSize, overlap) {
  const chunks = []
  let start = 0
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length)
    chunks.push({ text: text.slice(start, end), start, end })
    if (end >= text.length) break
    start = end - overlap
  }
  return chunks
}

// ─── Markdown 分块（按标题层级）────────────────────────────────────
function chunkMarkdown(text, { chunkSize = DEFAULT_CHUNK_SIZE, overlap = DEFAULT_CHUNK_OVERLAP } = {}) {
  const lines = text.split('\n')
  const sections = []
  let currentHeading = []
  let currentLines = []

  const flush = () => {
    if (currentLines.length) {
      sections.push({
        heading_path: currentHeading.filter(Boolean).join(' > '),
        text: currentLines.join('\n').trim(),
      })
      currentLines = []
    }
  }

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/)
    if (headingMatch) {
      flush()
      const level = headingMatch[1].length
      const title = headingMatch[2].trim()
      currentHeading[level - 1] = title
      currentHeading = currentHeading.slice(0, level)
      currentLines.push(line)
    } else {
      currentLines.push(line)
    }
  }
  flush()

  // 每个 section 内再按段落切到 chunkSize
  const chunks = []
  for (const section of sections) {
    if (!section.text) continue
    const subChunks = chunkByParagraph(section.text, { chunkSize, overlap })
    for (const sc of subChunks) {
      chunks.push({
        text: section.heading_path ? `【${section.heading_path}】\n${sc.text}` : sc.text,
        heading_path: section.heading_path,
        start: sc.start,
        end: sc.end,
      })
    }
  }
  return chunks
}

// ─── 代码文件分块（按行 + 函数边界启发式）──────────────────────────
function chunkCode(text, { chunkSize = DEFAULT_CHUNK_SIZE, overlap = DEFAULT_CHUNK_OVERLAP } = {}) {
  const lines = text.split('\n')
  const chunks = []
  let currentLines = []
  let currentLen = 0

  const isBlockStart = (line) => /^(function|class|def|async\s+function|export\s+function|export\s+class|interface|type\s+\w+\s*=|const\s+\w+\s*=\s*(async\s*)?\()/.test(line.trim())
  const isBlockEnd = (line) => /^(\}|\)|^\s*$)/.test(line.trim()) && currentLen > chunkSize * 0.6

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (currentLen + line.length + 1 > chunkSize && currentLines.length > 0) {
      // 尝试在函数边界切
      let cutIdx = currentLines.length - 1
      for (let j = currentLines.length - 1; j >= Math.max(0, currentLines.length - 10); j--) {
        if (isBlockEnd(currentLines[j])) { cutIdx = j + 1; break }
      }
      const chunkText = currentLines.slice(0, cutIdx).join('\n')
      chunks.push({ text: chunkText, start: 0, end: chunkText.length })
      // 重叠：保留最后 overlap 字符的行
      const overlapLines = []
      let overlapLen = 0
      for (let j = cutIdx - 1; j >= 0 && overlapLen < overlap; j--) {
        overlapLines.unshift(currentLines[j])
        overlapLen += currentLines[j].length + 1
      }
      currentLines = [...overlapLines, line]
      currentLen = overlapLen + line.length + 1
    } else {
      currentLines.push(line)
      currentLen += line.length + 1
    }
    // 函数开头且当前块已有内容：在函数前切（保持函数完整）
    if (isBlockStart(line) && currentLen > chunkSize * 0.5 && currentLines.length > 3) {
      const chunkText = currentLines.slice(0, -1).join('\n')
      if (chunkText.trim()) chunks.push({ text: chunkText, start: 0, end: chunkText.length })
      currentLines = [line]
      currentLen = line.length + 1
    }
  }
  if (currentLines.length) {
    const chunkText = currentLines.join('\n')
    if (chunkText.trim()) chunks.push({ text: chunkText, start: 0, end: chunkText.length })
  }
  return chunks
}

// ─── CSV/表格分块（按行，表头附加）─────────────────────────────────
function chunkCsv(text, { chunkSize = DEFAULT_CHUNK_SIZE } = {}) {
  const lines = text.split('\n').filter(l => l.trim())
  if (lines.length <= 1) return [{ text, start: 0, end: text.length, row_range: 'all' }]

  const header = lines[0]
  const dataRows = lines.slice(1)
  const rowsPerChunk = Math.max(1, Math.floor(chunkSize / (header.length + 50)))
  const chunks = []

  for (let i = 0; i < dataRows.length; i += rowsPerChunk) {
    const batch = dataRows.slice(i, i + rowsPerChunk)
    const chunkText = `${header}\n${batch.join('\n')}`
    chunks.push({
      text: chunkText,
      row_range: `${i + 1}-${i + batch.length}`,
      start: 0,
      end: chunkText.length,
    })
  }
  return chunks
}

// ─── 主入口 ────────────────────────────────────────────────────────
export function chunkDocument(text, { format = 'text', chunkSize = DEFAULT_CHUNK_SIZE, overlap = DEFAULT_CHUNK_OVERLAP, docId = 'doc' } = {}) {
  if (!text || !text.trim()) return []

  let rawChunks
  const ext = format.startsWith('.') ? format : `.${format}`

  if (ext === '.csv') {
    rawChunks = chunkCsv(text, { chunkSize })
  } else if (ext === '.md' || ext === '.markdown') {
    rawChunks = chunkMarkdown(text, { chunkSize, overlap })
  } else if (CODE_EXTS.has(ext)) {
    rawChunks = chunkCode(text, { chunkSize, overlap })
  } else {
    rawChunks = chunkByParagraph(text, { chunkSize, overlap })
  }

  return rawChunks.map((rc, i) => ({
    id: stableChunkId(docId, i),
    index: i,
    text: rc.text,
    metadata: {
      index: i,
      heading_path: rc.heading_path || '',
      row_range: rc.row_range || '',
      char_start: rc.start,
      char_end: rc.end,
      chars: rc.text.length,
    },
  }))
}

export { DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_OVERLAP }
