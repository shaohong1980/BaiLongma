// knowledge/parsers.js —— 文档解析器（零外部依赖）
//
// 支持格式：
//   文本类：.txt .md .markdown .json .csv .log .html .xml .yaml .yml .ini
//   代码类：.js .ts .py .java .c .cpp .go .rs .sh .ps1
//   Open XML：.docx (Word) .xlsx (Excel) .pptx (PowerPoint) —— 内置最小 ZIP 解压 + XML 文本提取
//   PDF：.pdf —— 内置文本流提取器（BT...ET 块，Tj/TJ 操作符），覆盖文本型 PDF
//
// 设计原则：
//   1. 零依赖：只用 Node.js 内置模块（fs/zlib），不引入 pdf-parse/mammoth/xlsx 等重型库
//   2. 容错优先：任何解析失败都返回 { ok:false, error }，不抛异常，不阻塞知识库导入
//   3. 统一输出：{ text, metadata: { format, pages?, sheets?, chars } }
//   4. 文本提取后由 chunker 负责分块，parser 只负责"把文件变成纯文本"

import fs from 'fs'
import path from 'path'
import zlib from 'zlib'

const TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.json', '.csv', '.log',
  '.html', '.htm', '.xml', '.yaml', '.yml', '.ini', '.conf',
  '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.c', '.cpp', '.h',
  '.go', '.rs', '.sh', '.bash', '.ps1', '.bat', '.cmd', '.sql', '.r',
])

const OPENXML_EXTS = {
  '.docx': 'word',
  '.xlsx': 'excel',
  '.pptx': 'powerpoint',
}

// ─── 最小 ZIP 读取器 ───────────────────────────────────────────────
// 只支持读取（不写），扫描 local file headers，用 zlib.inflateRawSync 解压 deflate 数据。
// 不支持加密、不支持 ZIP64、不支持数据描述符（大部分 Open XML 文件不用这些）。
function readZipEntries(buffer) {
  const entries = new Map()
  let offset = 0
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)

  while (offset + 4 <= buffer.length) {
    const sig = view.getUint32(offset, true)
    if (sig !== 0x04034b50) break // local file header signature

    const method = view.getUint16(offset + 8, true)
    const compressedSize = view.getUint32(offset + 18, true)
    const nameLen = view.getUint16(offset + 26, true)
    const extraLen = view.getUint16(offset + 28, true)

    const nameStart = offset + 30
    const name = buffer.toString('utf8', nameStart, nameStart + nameLen)
    const dataStart = nameStart + nameLen + extraLen
    const dataEnd = dataStart + compressedSize

    if (dataEnd <= buffer.length) {
      const compressed = buffer.subarray(dataStart, dataEnd)
      try {
        let content
        if (method === 0) {
          content = compressed // stored (no compression)
        } else if (method === 8) {
          content = zlib.inflateRawSync(compressed) // deflate
        } else {
          content = null // unsupported compression
        }
        if (content) entries.set(name, content)
      } catch {
        // 单个条目解压失败不影响其他条目
      }
    }

    offset = dataEnd
    // 某些 ZIP 在数据后有 data descriptor（signature 0x08074b50 + 12 bytes）
    if (offset + 4 <= buffer.length && view.getUint32(offset, true) === 0x08074b50) {
      offset += 16
    }
  }
  return entries
}

// ─── DOCX 解析 ─────────────────────────────────────────────────────
function parseDocx(entries) {
  const docXml = entries.get('word/document.xml')
  if (!docXml) return { ok: false, error: 'docx 中未找到 word/document.xml' }
  const xml = docXml.toString('utf8')
  const paragraphs = []
  const paraRe = /<w:p[\s>][\s\S]*?<\/w:p>/g
  let pm
  while ((pm = paraRe.exec(xml)) !== null) {
    const para = pm[0]
    const texts = []
    const tRe = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g
    let tm
    while ((tm = tRe.exec(para)) !== null) {
      texts.push(tm[1]
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'"))
    }
    const line = texts.join('').trim()
    if (line) paragraphs.push(line)
  }
  const text = paragraphs.join('\n')
  return {
    ok: true,
    text,
    metadata: { format: 'docx', paragraphs: paragraphs.length, chars: text.length },
  }
}

// ─── XLSX 解析 ─────────────────────────────────────────────────────
function parseXlsx(entries) {
  const sharedXml = entries.get('xl/sharedStrings.xml')
  let sharedStrings = []
  if (sharedXml) {
    const xml = sharedXml.toString('utf8')
    const siRe = /<si[\s>][\s\S]*?<\/si>/g
    let sm
    while ((sm = siRe.exec(xml)) !== null) {
      const tMatches = sm[0].match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []
      const text = tMatches.map(t => t.replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'")).join('')
      sharedStrings.push(text)
    }
  }

  const sheets = []
  let sheetIdx = 1
  while (true) {
    const sheetXml = entries.get(`xl/worksheets/sheet${sheetIdx}.xml`)
    if (!sheetXml) break
    const xml = sheetXml.toString('utf8')
    const rows = []
    const rowRe = /<row[\s>][\s\S]*?<\/row>/g
    let rm
    while ((rm = rowRe.exec(xml)) !== null) {
      const cells = []
      const cellRe = /<c[^>]*>([\s\S]*?)<\/c>/g
      let cm
      while ((cm = cellRe.exec(rm[0])) !== null) {
        const cellXml = cm[1]
        const typeMatch = cm[0].match(/ t="([^"]+)"/)
        const type = typeMatch ? typeMatch[1] : 'n'
        const vMatch = cellXml.match(/<v>([\s\S]*?)<\/v>/)
        const isMatch = cellXml.match(/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>[\s\S]*?<\/is>/)
        let value = ''
        if (type === 's' && vMatch) {
          const idx = parseInt(vMatch[1], 10)
          value = sharedStrings[idx] || ''
        } else if (type === 'inlineStr' && isMatch) {
          value = isMatch[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
        } else if (vMatch) {
          value = vMatch[1]
        }
        cells.push(value)
      }
      if (cells.some(c => c.trim())) rows.push(cells.join('\t'))
    }
    sheets.push({ name: `Sheet${sheetIdx}`, rows: rows.length, content: rows.join('\n') })
    sheetIdx++
  }

  if (sheets.length === 0) return { ok: false, error: 'xlsx 中未找到工作表' }

  const text = sheets.map(s => `【${s.name}】\n${s.content}`).join('\n\n')
  return {
    ok: true,
    text,
    metadata: { format: 'xlsx', sheets: sheets.length, sheet_names: sheets.map(s => s.name), chars: text.length },
  }
}

// ─── PPTX 解析 ─────────────────────────────────────────────────────
function parsePptx(entries) {
  const slides = []
  let slideIdx = 1
  while (true) {
    const slideXml = entries.get(`ppt/slides/slide${slideIdx}.xml`)
    if (!slideXml) break
    const xml = slideXml.toString('utf8')
    const texts = []
    const tRe = /<a:t[^>]*>([\s\S]*?)<\/a:t>/g
    let tm
    while ((tm = tRe.exec(xml)) !== null) {
      texts.push(tm[1]
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'"))
    }
    if (texts.length) slides.push({ index: slideIdx, text: texts.join('\n') })
    slideIdx++
  }

  if (slides.length === 0) return { ok: false, error: 'pptx 中未找到幻灯片文本' }

  const text = slides.map(s => `【第${s.index}页】\n${s.text}`).join('\n\n')
  return {
    ok: true,
    text,
    metadata: { format: 'pptx', slides: slides.length, chars: text.length },
  }
}

// ─── PDF 文本提取 ──────────────────────────────────────────────────
function parsePdf(buffer) {
  const text = buffer.toString('latin1')
  const results = []

  const btRe = /BT([\s\S]*?)ET/g
  let bm
  while ((bm = btRe.exec(text)) !== null) {
    const block = bm[1]
    const lineTexts = []

    // Tj: (string) Tj
    const tjRe = /\(((?:\\.|[^\\)])*)\)\s*Tj/g
    let tm
    while ((tm = tjRe.exec(block)) !== null) {
      lineTexts.push(decodePdfString(tm[1]))
    }

    // TJ: [(string) num ...] TJ
    const tjArrRe = /\[([\s\S]*?)\]\s*TJ/g
    let tam
    while ((tam = tjArrRe.exec(block)) !== null) {
      const arrContent = tam[1]
      const strRe = /\(((?:\\.|[^\\)])*)\)/g
      let sm
      while ((sm = strRe.exec(arrContent)) !== null) {
        lineTexts.push(decodePdfString(sm[1]))
      }
    }

    if (lineTexts.length) results.push(lineTexts.join(''))
  }

  if (results.length === 0) {
    return { ok: false, error: 'PDF 中未提取到文本（可能是扫描件/图片型 PDF，需要 OCR）', metadata: { format: 'pdf', chars: 0 } }
  }

  const fullText = results.join('\n')
  return { ok: true, text: fullText, metadata: { format: 'pdf', pages: estimatePdfPages(buffer), chars: fullText.length } }
}

function decodePdfString(s) {
  return s
    .replace(/\\([\\()nrtbf])/g, (_, c) => ({
      '\\': '\\', '(': '(', ')': ')', 'n': '\n', 'r': '\r',
      't': '\t', 'b': '\b', 'f': '\f',
    }[c] || c))
    .replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)))
}

function estimatePdfPages(buffer) {
  const text = buffer.toString('latin1')
  const matches = text.match(/\/Type\s*\/Page[^s]/g)
  return matches ? matches.length : 1
}

// ─── CSV 解析 ──────────────────────────────────────────────────────
function parseCsv(content) {
  const lines = content.split(/\r?\n/).filter(l => l.trim())
  if (!lines.length) return { ok: true, text: '', metadata: { format: 'csv', rows: 0, columns: 0 } }
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''))
  return { ok: true, text: lines.join('\n'), metadata: { format: 'csv', rows: lines.length - 1, columns: headers.length, headers, chars: content.length } }
}

// ─── 主入口 ────────────────────────────────────────────────────────
export function parseDocument(filePath) {
  if (!fs.existsSync(filePath)) return { ok: false, error: `文件不存在: ${filePath}` }

  const ext = path.extname(filePath).toLowerCase()
  const stat = fs.statSync(filePath)

  if (TEXT_EXTS.has(ext)) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      if (ext === '.csv') return parseCsv(content)
      return { ok: true, text: content, metadata: { format: ext.slice(1) || 'text', chars: content.length, size: stat.size } }
    } catch (err) {
      return { ok: false, error: `读取失败: ${err.message}` }
    }
  }

  if (OPENXML_EXTS[ext]) {
    try {
      const buffer = fs.readFileSync(filePath)
      const entries = readZipEntries(buffer)
      if (entries.size === 0) return { ok: false, error: 'ZIP 解压失败或文件为空' }
      if (ext === '.docx') return parseDocx(entries)
      if (ext === '.xlsx') return parseXlsx(entries)
      if (ext === '.pptx') return parsePptx(entries)
    } catch (err) {
      return { ok: false, error: `${OPENXML_EXTS[ext]} 解析失败: ${err.message}` }
    }
  }

  if (ext === '.pdf') {
    try {
      const buffer = fs.readFileSync(filePath)
      return parsePdf(buffer)
    } catch (err) {
      return { ok: false, error: `PDF 解析失败: ${err.message}` }
    }
  }

  return { ok: false, error: `不支持的格式: ${ext}`, supported_formats: [...TEXT_EXTS, ...Object.keys(OPENXML_EXTS), '.pdf'] }
}

export function getSupportedFormats() {
  return {
    text: [...TEXT_EXTS].sort(),
    openxml: Object.entries(OPENXML_EXTS).map(([ext, name]) => ({ ext, name })),
    pdf: '.pdf',
  }
}
