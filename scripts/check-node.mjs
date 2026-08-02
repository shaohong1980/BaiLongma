// scripts/check-node.mjs
// BaiLongma 强制 Node 20.18.x —— 匹配 Electron 33 内置 Node 20.18，
// 保证 better-sqlite3 原生模块 ABI（115）一致，避免版本错乱。
const [major, minor] = process.versions.node.split('.').map(Number);
const OK = major === 20 && minor === 18;

if (!OK) {
  console.error('');
  console.error(`[BaiLongma] ❌ 需要 Node 20.18.x，当前是 ${process.version}`);
  console.error('');
  console.error('  请切换 Node 20.18：');
  console.error('  1) Git Bash（推荐）：直接运行，已自动加载 D:/node20');
  console.error('  2) cmd/PowerShell：  set PATH=D:/node20;%PATH%');
  console.error('  3) nvm-windows：     nvm install 20.18.3 && nvm use 20.18.3');
  console.error('');
  process.exit(1);
}

console.log(`[BaiLongma] Node ${process.version} ✓ 符合要求（20.18.x）`);
