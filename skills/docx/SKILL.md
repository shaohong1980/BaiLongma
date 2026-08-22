---
name: DOCX Documents
description: 创建/读取/编辑 Word 文档（.docx）。生成带目录、标题、页眉页码的专业文档，提取或改写现有文档。
tags:
  - docx
  - word
  - document
  - office
aliases:
  - Word文档
  - docx
  - 写Word
  - 生成文档
triggers:
  - 写一个Word文档
  - 生成docx
  - 做一份文档
  - 编辑Word
---

# DOCX 文档创建与编辑

一个 `.docx` 本质是 ZIP + XML。按任务选方案：

| 任务 | 方案 |
|---|---|
| **新建（推荐）** | 用 `gen_docx` 工具：先写 Markdown，再转 .docx |
| **编辑已有** | `unzip` → 改 `word/document.xml` → 重新 zip |
| **读取内容** | `pandoc -t markdown file.docx` 转 Markdown |

## 首选：gen_docx 工具（零手动 XML，排版专业）

写文档内容时**不要用 write_file 一次写完**，而是：

1. 把正文写成 **Markdown 文件**（`#` 一级标题、`##` 二级、`###` 三级；表格用 `| 列 | 列 |`；列表用 `-`/`1.`；段落间空一行；需要分页就单独一行 `---PAGE---`）。长文档用 `write_file` 开头 + `append_file` 逐段追加。
2. 调用 `gen_docx`：
   ```
   gen_docx({ input: "报告.md", title: "报告标题", cover: true, toc: true, author: "白龙马办公室", header: "公司名" })
   ```
3. `gen_docx` 自动生成带封面、目录、多级标题、页眉页码、表格边框的专业 .docx。

> 禁止手写二进制 .docx（ZIP+XML 极易损坏），也禁止把 HTML 改名成 .doc 冒充（Word 打开排版很差）。

## 关键坑（docx-js 脚本方案，仅高级场景）

- 页面默认 A4；美国信纸要设 `width: 12240, height: 15840`（DXA，1440=1英寸）
- 表格要同时设 `columnWidths` 和每个单元格的 `width`，都用 `WidthType.DXA`，列宽和必须等于表宽
- 列表：**不要**手打 `•`，用 `numbering` + `LevelFormat.BULLET`
- `ImageRun` 必须带 `type`（"png"/"jpg"）
- `PageBreak` 必须在 `Paragraph` 里
- **禁用 `\n`**，用独立 `Paragraph`
- 目录：标题必须用内置 `HeadingLevel.*`，自定义样式要设 `outlineLevel`
- 页眉/页脚用 `Header` / `Footer` 对象，页码用 `PageNumber.CURRENT`

## 验证输出

生成后转成 PDF/图片检查渲染：
```bash
libreoffice --headless --convert-to pdf output.docx
pdftoppm -jpeg -r 100 output.pdf page   # 生成 page-*.jpg 逐页看
```

## 流程
1. 先问用户：文档用途、样式偏好（正式/简洁）、需要哪些章节
2. 写 Markdown（分段）→ 调 `gen_docx` 生成 → 转 PDF 目检 → 修复排版 → 交付
3. 交付时说明文件路径
