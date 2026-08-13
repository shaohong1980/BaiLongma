// scripts/check-node.mjs
// BaiLongma 要求 Node 20.18+（major=20, minor>=18）。
// 说明：Node 20 全系列 ABI（NODE_MODULE_VERSION）恒为 115，与 Electron 33 内置
// Node 20.18 完全一致，better-sqlite3 原生模块可直接复用，无需精确锁 20.18.x。
// 实际部署目录 D:/node20 也是 20.19.x，故放宽为 >=18（保留对更老 20.x 的保护）。
const [major, minor] = process.versions.node.split('.').map(Number);
const OK = major === 20 && minor >= 18;

if (!OK) {
  console.error('');
  console.error(`[BaiLongma] ❌ 需要 Node 20.18+，当前是 ${process.version}`);
  console.error('');
  console.error('  请切换 Node 20.18+：');
  console.error('  1) Git Bash（推荐）：直接运行，已自动加载 D:/node20');
  console.error('  2) cmd/PowerShell：  set PATH=D:/node20;%PATH%');
  console.error('  3) nvm-windows：     nvm install 20.18.3 && nvm use 20.18.3');
  console.error('');
  process.exit(1);
}

console.log(`[BaiLongma] Node ${process.version} ✓ 符合要求（20.18+）`);
