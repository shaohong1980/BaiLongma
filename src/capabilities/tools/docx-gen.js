// docx-gen.js —— gen_docx 工具：把 Markdown 内容转成排版专业的 Word (.docx)
// 成员先用 write_file/append_file 把内容写成 Markdown（可分段、无字数上限），
// 再调用 gen_docx 转成带封面/目录/多级标题/表格/页眉页码的正式文档。
// 技术栈：docx (npm) —— 生成真正的 OOXML .docx，而非 HTML 伪 .doc。
import fs from 'fs'
import path from 'path'
import { throwIfAborted } from '../abort-utils.js'
import { SANDBOX_ROOT, assertInSandbox, isPathInside, normalizeSandboxPath } from '../sandbox.js'
import { config } from '../../config.js'
import { guardFilePath, DEFAULT_FILE_GUARD } from '../security-guards.js'
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, LevelFormat,
  Table, TableRow, TableCell, WidthType, BorderStyle, AlignmentType, ShadingType,
  PageBreak, Header, Footer, PageNumber, TableOfContents,
} from 'docx'

const BODY_FONT = '宋体'
const HEAD_FONT = '黑体'
const A4 = { width: 11906, height: 16838 }   // twips（1440 = 1 英寸）
const MARGIN = 1440                          // 1 英寸页边距

function toolJson(payload) { return JSON.stringify(payload, null, 2) }

function assertFileNotGuarded(resolved) {
  const mode = config.security?.fileGuard ?? DEFAULT_FILE_GUARD
  if (mode === 'off') return
  const result = guardFilePath(resolved, { mode })
  if (!result.blocked) return
  const inSandbox = isPathInside(SANDBOX_ROOT, resolved)
  const systemCredential = /\.(pem|key|pfx|p12|keyring|keychain)$/i.test(resolved)
    || /(^|[\\/])\.ssh([\\/]|$)/i.test(resolved)
    || /(^|[\\/])SAM$|(^|[\\/])NTUSER\.DAT$/i.test(resolved)
    || /(Login Data|Cookies|Web Data)/i.test(resolved)
    || /(^|[\\/])\.aws([\\/])/.test(resolved)
  if (!inSandbox || systemCredential) {
    throw new Error(`访问被拒绝（FileGuard）：${result.reasons.join('; ')}`)
  }
}

// 解析行内 **加粗** / *斜体* / `代码` 为多个 TextRun
function inlineRuns(text) {
  const runs = []
  const re = /\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`/g
  let last = 0, m
  while ((m = re.exec(text))) {
    if (m.index > last) runs.push(new TextRun({ text: text.slice(last, m.index), font: BODY_FONT, size: 24 }))
    if (m[1] !== undefined) runs.push(new TextRun({ text: m[1], font: HEAD_FONT, bold: true, size: 24 }))
    else if (m[2] !== undefined) runs.push(new TextRun({ text: m[2], font: BODY_FONT, italics: true, size: 24 }))
    else runs.push(new TextRun({ text: m[3], font: 'Consolas', size: 22, shading: { type: ShadingType.CLEAR, fill: 'F0F0F0' } }))
    last = m.index + m[0].length
  }
  if (last < text.length) runs.push(new TextRun({ text: text.slice(last), font: BODY_FONT, size: 24 }))
  return runs.length ? runs : [new TextRun({ text, font: BODY_FONT, size: 24 })]
}

function headingRun(text, level) {
  const size = level === 1 ? 32 : level === 2 ? 28 : 26   // 16pt / 14pt / 13pt
  return new TextRun({ text, font: HEAD_FONT, bold: true, size })
}

function headingLevel(level) {
  if (level <= 1) return HeadingLevel.HEADING_1
  if (level === 2) return HeadingLevel.HEADING_2
  if (level === 3) return HeadingLevel.HEADING_3
  return HeadingLevel.HEADING_4
}

// 解析 Markdown → blocks：[{type}] heading/para/bullet/numbered/table/pageBreak/rule
function parseMarkdown(md) {
  const lines = String(md || '').split(/\r?\n/)
  const blocks = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const t = line.trim()
    if (/^---+PAGE---+$/.test(t) || /<!--\s*page[- ]?break\s*-->/.test(t)) { blocks.push({ type: 'pageBreak' }); i++; continue }
    const h = t.match(/^(#{1,4})\s+(.*)$/)
    if (h) { blocks.push({ type: 'heading', level: h[1].length, text: h[2].trim() }); i++; continue }
    if (t.startsWith('|')) {
      const tl = []
      while (i < lines.length && lines[i].trim().startsWith('|')) { tl.push(lines[i].trim()); i++ }
      const cells = (l) => l.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
      const header = cells(tl[0] || '')
      const rows = tl.slice(2).filter(l => !/^\|[\s:|-]+\|$/.test(l)).map(cells)
      if (header.some(c => c)) blocks.push({ type: 'table', headers: header, rows })
      continue
    }
    if (/^[-*]\s+/.test(t)) {
      const items = []
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) { items.push(lines[i].trim().replace(/^[-*]\s+/, '')); i++ }
      blocks.push({ type: 'bullet', items })
      continue
    }
    if (/^\d+[.、)]\s+/.test(t)) {
      const items = []
      while (i < lines.length && /^\d+[.、)]\s+/.test(lines[i].trim())) { items.push(lines[i].trim().replace(/^\d+[.、)]\s+/, '')); i++ }
      blocks.push({ type: 'numbered', items })
      continue
    }
    if (!t) { i++; continue }
    if (/^---+$/.test(t) || /^\*\*\*+$/.test(t)) { blocks.push({ type: 'rule' }); i++; continue }
    // 段落：收集到空行/标题/列表/表格为止
    const pl = []
    while (i < lines.length) {
      const s = lines[i].trim()
      if (!s || /^(#{1,4})\s+|^[-*]\s+|^\d+[.、)]\s+/.test(s) || s.startsWith('|')
          || /^---+PAGE---+$/.test(s) || /^---+$/.test(s) || /^\*\*\*+$/.test(s)) break
      pl.push(lines[i])
      i++
    }
    if (pl.length) blocks.push({ type: 'para', text: pl.join('\n') })
  }
  return blocks
}

function buildTable({ headers, rows }) {
  const border = { style: BorderStyle.SINGLE, size: 4, color: '999999' }
  const mkCell = (text, isHeader) => new TableCell({
    shading: isHeader ? { type: ShadingType.CLEAR, fill: 'E8EDF4' } : undefined,
    verticalAlign: 'center',
    children: [new Paragraph({ children: [new TextRun({ text, font: isHeader ? HEAD_FONT : BODY_FONT, bold: isHeader, size: 22 })] })],
  })
  const mkRow = (cells, isHeader) => new TableRow({ tableHeader: isHeader, children: cells.map(c => mkCell(c, isHeader)) })
  const headerRow = headers.length ? mkRow(headers, true) : null
  const bodyRows = (rows || []).map(r => mkRow(r, false))
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
    rows: headerRow ? [headerRow, ...bodyRows] : bodyRows,
  })
}

// 生成文档对象
function buildDocument(blocks, opts = {}) {
  const children = []
  if (opts.cover) {
    children.push(new Paragraph({ spacing: { before: 4200 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: opts.title || '文档', font: HEAD_FONT, bold: true, size: 60 })] }))
    if (opts.subtitle) children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 200 }, children: [new TextRun({ text: opts.subtitle, font: BODY_FONT, size: 30, color: '666666' })] }))
    if (opts.author) children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 1600 }, children: [new TextRun({ text: opts.author, font: BODY_FONT, size: 26, color: '888888' })] }))
    children.push(new Paragraph({ children: [new PageBreak()] }))
  }
  if (opts.toc) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 200, after: 200 }, children: [new TextRun({ text: '目  录', font: HEAD_FONT, bold: true, size: 32 })] }))
    children.push(new Paragraph({ children: [new TableOfContents('目录', { hyperlink: true, headingStyleRange: '1-3' })] }))
    children.push(new Paragraph({ children: [new PageBreak()] }))
  }
  for (const b of blocks) {
    switch (b.type) {
      case 'heading':
        children.push(new Paragraph({ heading: headingLevel(b.level), spacing: { before: 260, after: 140 }, children: [headingRun(b.text, b.level)] }))
        break
      case 'para':
        children.push(new Paragraph({ spacing: { line: 380, after: 120 }, indent: { firstLine: 480 }, children: inlineRuns(b.text) }))
        break
      case 'bullet':
        for (const it of b.items) children.push(new Paragraph({ bullet: { level: 0 }, spacing: { line: 360, after: 60 }, children: inlineRuns(it) }))
        break
      case 'numbered':
        for (const it of b.items) children.push(new Paragraph({ numbering: { reference: 'num', level: 0 }, spacing: { line: 360, after: 60 }, children: inlineRuns(it) }))
        break
      case 'table':
        children.push(buildTable(b))
        children.push(new Paragraph({ spacing: { after: 120 }, children: [] }))
        break
      case 'pageBreak':
        children.push(new Paragraph({ children: [new PageBreak()] }))
        break
      case 'rule':
        children.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CCCCCC' } }, spacing: { after: 120 }, children: [] }))
        break
    }
  }
  return new Document({
    creator: '白龙马多Agent办公室',
    description: opts.title || '白龙马生成文档',
    styles: { default: { document: { run: { font: BODY_FONT, size: 24 } } } },
    numbering: {
      config: [{
        reference: 'num',
        levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720 } } } }],
      }],
    },
    sections: [{
      properties: { page: { size: A4, margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN } } },
      headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: opts.header || '', font: BODY_FONT, size: 18, color: '888888' })] })] }) },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: '第 ', font: BODY_FONT, size: 18, color: '888888' }), new TextRun({ children: [PageNumber.CURRENT], font: BODY_FONT, size: 18, color: '888888' }), new TextRun({ text: ' 页', font: BODY_FONT, size: 18, color: '888888' })] })] }) },
      children,
    }],
  })
}

// ── gen_docx 主入口 ──
// args: { input: '报告.md', output?: '报告.docx', title?, subtitle?, author?, cover?, toc?, header? }
export async function execGenDocx(args = {}, context = {}) {
  throwIfAborted(context.signal)
  const rawInput = String(args.input || '').trim()
  if (!rawInput) return toolJson({ ok: false, tool: 'gen_docx', error: '缺少 input（Markdown 文件路径）' })
  const inPath = normalizeSandboxPath(rawInput)
  const inResolved = path.resolve(SANDBOX_ROOT, inPath)
  assertInSandbox(inResolved)
  assertFileNotGuarded(inResolved)
  if (!fs.existsSync(inResolved)) {
    return toolJson({ ok: false, tool: 'gen_docx', error: `输入文件不存在：${rawInput}（请先用 write_file 写 Markdown 内容）` })
  }

  const outRaw = String(args.output || '').trim() || inPath.replace(/\.[^.]+$/, '') + '.docx'
  const outPath = normalizeSandboxPath(outRaw)
  const outResolved = path.resolve(SANDBOX_ROOT, outPath)
  assertInSandbox(outResolved)
  assertFileNotGuarded(outResolved)

  const md = fs.readFileSync(inResolved, 'utf-8')
  const blocks = parseMarkdown(md)
  const opts = {
    cover: args.cover === true || args.cover === 'true',
    toc: args.toc === true || args.toc === 'true',
    title: String(args.title || '').trim(),
    subtitle: String(args.subtitle || '').trim(),
    author: String(args.author || '').trim(),
    header: String(args.header || '').trim(),
  }
  if (!opts.title) {
    const firstHeading = blocks.find(b => b.type === 'heading')
    opts.title = firstHeading ? firstHeading.text : path.basename(outResolved, '.docx')
  }

  const doc = buildDocument(blocks, opts)
  const buf = await Packer.toBuffer(doc)
  fs.mkdirSync(path.dirname(outResolved), { recursive: true })
  fs.writeFileSync(outResolved, buf)

  return toolJson({
    ok: true,
    tool: 'gen_docx',
    input: inPath,
    output: outPath,
    absolute_path: outResolved,
    bytes: buf.length,
    paragraphs: blocks.filter(b => b.type === 'para').length,
    headings: blocks.filter(b => b.type === 'heading').length,
    tables: blocks.filter(b => b.type === 'table').length,
    cover: opts.cover,
    toc: opts.toc,
    hint: '已生成 .docx。内容如需调整，改 Markdown 源文件后重新调用 gen_docx。',
  })
}
