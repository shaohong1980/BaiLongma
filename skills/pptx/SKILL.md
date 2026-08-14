---
name: PPTX Presentations
description: 创建/读取/编辑 PowerPoint 演示文稿（.pptx）。做 pitch deck、汇报、课件，提取或修改已有幻灯片。
tags:
  - pptx
  - powerpoint
  - slides
  - presentation
aliases:
  - PPT
  - 幻灯片
  - 演示文稿
  - 做PPT
triggers:
  - 做一份PPT
  - 生成演示文稿
  - 做个slides
  - 汇报用PPT
---

# PPTX 演示文稿

用 `pptx`（python-pptx）生成/编辑，脚本方式处理。

## 关键做法
- 新建：`python-pptx` 的 `Presentation()`，选版式 `slide_layouts[i]`
- 读已有：`Presentation('file.pptx')` 遍历 slides/shapes 提取文本
- 编辑：打开→改 shape.text_frame→另存，别破坏版式
- 页尺寸：默认 10×7.5in；16:9 设 `slide_width = Inches(13.33)`

## 设计规范（专业感）
- **一页一个主题**：标题=结论，正文≤6 行，每行≤6 词
- 图片 > 文字 > 列表；能用图不用字
- 统一字体、配色（主色1+辅色1+中性色），别超过 3 种强调色
- 留白充足，别塞满
- 数据页用图表（折线/柱状/饼图），`add_chart` 或嵌入图片

## 流程
1. 问清：受众、主题、页数预期、风格
2. 先给**大纲**（页标题列表）让用户确认，再填充
3. 生成后转 PDF 目检：`libreoffice --headless --convert-to pdf x.pptx` + `pdftoppm` 看每页
4. 检查溢出/遮挡/错位，修完交付
