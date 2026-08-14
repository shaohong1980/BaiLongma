---
name: Web App Testing
description: 本地 Web 应用测试——用 Playwright 验证前端功能、调试 UI 行为、截图、看浏览器日志。
tags:
  - testing
  - playwright
  - web
  - browser
  - ui
aliases:
  - 测试网页
  - 浏览器测试
  - UI测试
  - 前端测试
triggers:
  - 测试一下这个网页
  - 验证前端功能
  - 截图看下页面
  - 调试UI
---

# Web 应用测试

用 Playwright（Node）驱动真实浏览器验证前端。

## 常用脚本骨架
```js
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ headless: true });
  const page = await b.newPage();
  await page.goto('http://localhost:端口');
  // 交互
  await page.fill('#input', '内容');
  await page.click('#btn');
  await page.waitForTimeout(500);
  // 断言
  const text = await page.textContent('#result');
  console.log('result:', text);
  await page.screenshot({ path: 'shot.png' });
  await b.close();
})();
```

## 测试清单
- **核心流程**：用户最常走的路径能否跑通（登录→操作→结果）
- **边界**：空输入、超长输入、特殊字符、错误提示
- **状态**：加载中/成功/失败/空数据 各状态
- **控制台**：`page.on('console')` / `page.on('pageerror')` 收集报错
- **截图留证**：关键页面截图，改完对比

## 规范
- **先复现再断言**：测试要能复现问题，别测"看似正常"
- **自动化优先**：能写脚本测就别手动点点点
- **报错要带证据**：截图 + console 报错 + 复现步骤
- 测试环境：本地服务起好后用 `http://127.0.0.1:端口` 访问
