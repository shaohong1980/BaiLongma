---
name: Git Workflow
description: 规范的 Git 操作——提交信息规范、分支管理、冲突解决、安全（不提交密钥）。
tags:
  - git
  - workflow
  - commit
  - version
aliases:
  - git操作
  - 提交代码
  - 分支管理
  - 版本管理
triggers:
  - 帮我git提交
  - 提交代码
  - 建个分支
  - 解决冲突
  - git操作
---

# Git 工作流

## 提交规范
- **信息格式**：`type: 摘要`（feat/fix/docs/style/refactor/perf/test/chore/build/ci）
  - `feat: 新增工作台待办功能`
  - `fix: 修复地图面板打不开的问题`
- 一条提交做一件事；摘要 ≤72 字符，说明"为什么"不是"改了什么"

## 操作流程
1. 提交前先 `git status` / `git diff` 看改动，确认没有误提交
2. **严禁提交密钥/配置**：提交前检查是否有 `.env`、`config.json`、`*secret*`、`*key*` 文件
3. 分步提交：`git add 具体文件`（不用 `add -A` 盲加），`git commit -m "feat: ..."`
4. 推送：`git push origin 分支`

## 分支与冲突
- 新功能/修复建分支：`git checkout -b feat/xxx`，完成合回 main
- 冲突解决：`git pull` → 看冲突文件 → 保留双方合理部分 → 测试 → 提交
- **合回前跑测试**，别把坏代码合上去

## 安全红线
- 提交前必查：`git status` 里有没有 `config.json`、`.env`、`data/`、`node_modules`、`*.log`
- 发现误提交密钥：立即从历史移除（filter-branch/filter-repo）+ 轮换密钥
- 大文件/二进制不入库（用 .gitignore / LFS）

## 规范
- **小步频繁**：提交小而清晰，别攒几百行一次提
- **先看再改**：`git diff` 确认改动符合预期再提交
- **如实**：commit message 说清改动，不写"改了一堆东西"
