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
| **新建** | 用 `docx`（npm）写脚本生成 |
| **编辑已有** | `unzip` → 改 `word/document.xml` → 重新 zip |
| **读取内容** | `pandoc -t markdown file.docx` 转 Markdown |

## 关键坑（docx-js）

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
2. 写脚本生成 → 转 PDF 目检 → 修复排版 → 交付
3. 交付时说明文件路径
