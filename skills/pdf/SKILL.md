---
name: PDF Processing
description: PDF 处理——读取/提取文字表格、合并拆分、加水印、旋转、OCR、加密、生成新 PDF。
tags:
  - pdf
  - document
  - ocr
  - 处理
aliases:
  - 处理PDF
  - 提取PDF
  - 合并PDF
  - PDF转文字
triggers:
  - 处理这个PDF
  - 提取PDF内容
  - 合并几个PDF
  - 给PDF加水印
  - PDF转文字
---

# PDF 处理

## 常用工具（exec_command 调用）

| 任务 | 工具 |
|---|---|
| **提取文字/表格** | `pdftotext` / `pdftoppm`；表格用 `pdfplumber`(Python) 或 `tabula` |
| **合并/拆分** | `pdfunite`（合并）、`pdfseparate`（拆分）、`qpdf` |
| **加水印/旋转** | `qpdf --rotate`、PyPDF2（加文字水印） |
| **创建新 PDF** | `pandoc file.md -o out.pdf`、`reportlab`(Python) |
| **填表单** | `pdftk fill_form`、`pypdf` |
| **OCR 扫描件** | `ocrmypdf` / `tesseract -l chi_sim`（中文要语言包） |
| **加密/解密** | `qpdf --encrypt` / `--decrypt` |
| **提取图片** | `pdfimages` |

## 工作流
1. 先 `read_file` / `pdftotext` 确认内容与页数
2. 按任务选工具处理
3. **验证**：处理完用 `pdftotext` 抽查输出，确认没丢内容/乱码

## 关键点
- **中文 PDF**：`pdftotext` 可能乱码，改用 OCR（`tesseract chi_sim`）或 `ocrmypdf`
- 扫描件没文字层：必须先 OCR，`pdftotext` 会返回空
- 处理完交付前，把结果转图片抽查一两页，别只报"处理好了"
