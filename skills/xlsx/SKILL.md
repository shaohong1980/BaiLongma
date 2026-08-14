---
name: XLSX Spreadsheets
description: Excel 表格处理——读取/创建/编辑 .xlsx/.csv，公式、格式、图表、数据清洗。
tags:
  - xlsx
  - excel
  - spreadsheet
  - csv
  - 表格
aliases:
  - 表格
  - Excel
  - xlsx
  - 处理表格
  - 生成excel
triggers:
  - 处理这个excel
  - 生成表格
  - 做个excel
  - 清洗csv
  - 表格数据
---

# XLSX 表格处理

用 Python `openpyxl` 处理 .xlsx（比 csv 强：保留格式/公式/图表）。

## 关键做法
- 读：`openpyxl.load_workbook('f.xlsx')`；纯数据可用 `data_only=True` 取计算值
- 建：`Workbook()` → `active` → 写值 → 设格式
- 公式：直接赋值 `"=SUM(A1:A10)"`
- 样式：`Font`/`Fill`/`Alignment`/`Border`；表头加粗+填充色+冻结首行
- 图表：`BarChart`/`LineChart`/`PieChart` + `add_data` + `add_chart`
- CSV/TSV：`csv` 模块或 pandas；注意编码（中文 UTF-8 带 BOM，Excel 才不乱码）

## 数据清洗要点
- 先看表头、行数、前几行，识别脏数据
- 处理：去重、补缺失（标注）、统一格式（日期/单位）、拆列
- **清洗前备份原文件**，操作可回滚

## 流程
1. 读文件确认结构，复述需求（要哪几列、什么结果）
2. 脚本处理 → 输出新文件（不覆盖原文件，除非用户要求）
3. 验证：读回新文件抽查关键行/公式结果
4. 交付路径 + 说明做了什么清洗/计算
