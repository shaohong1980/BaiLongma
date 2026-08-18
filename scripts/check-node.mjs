// scripts/check-node.mjs
// BaiLongma 要求 Node 22+（major=22）。
// 说明：系统 Node 22 仅作为构建 / 脚本运行环境（npm、electron-rebuild、lint 等）；
// 运行时统一走 Electron 33 内置 Node（后端用 ELECTRON_RUN_AS_NODE=1 electron），
// better-sqlite3 原生模块始终按 Electron ABI（130）编译，与系统 node 的 ABI 无关。
// 升级原因：@electron/rebuild 4.x 声明 node >=22.12.0，node 20 下 npm install 必失败。
const [major] = process.versions.node.split('.').map(Number);
const OK = major === 22;

if (!OK) {
  console.error('');
  console.error(`[BaiLongma] ❌ 需要 Node 22+，当前是 ${process.version}`);
  console.error('');
  console.error('  请切换 Node 22+：');
  console.error('  1) nvm-windows：     nvm install 22.20.0 && nvm use 22.20.0');
  console.error('  2) fnm：             fnm install 22 && fnm use 22');
  console.error('  3) 手动下载：        https://nodejs.org/download/release/latest-v22.x/');
  console.error('');
  process.exit(1);
}

console.log(`[BaiLongma] Node ${process.version} ✓ 符合要求（22+）`);
