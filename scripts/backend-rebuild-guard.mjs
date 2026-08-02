// scripts/backend-rebuild-guard.mjs
// 方案 B：统一 Electron 运行时。backend:rebuild（即 npm rebuild better-sqlite3）
// 会把原生模块编回普通 Node ABI，破坏桌面端与后端的统一，故禁止执行。
console.error('');
console.error('[BaiLongma] ⛔ 禁止执行 backend:rebuild / npm rebuild better-sqlite3');
console.error('');
console.error('  项目已统一在 Electron 运行时（方案 B），better-sqlite3 必须保持 Electron ABI（130）。');
console.error('  执行 npm rebuild better-sqlite3 会把它编回普通 Node ABI，导致桌面端和后端都无法启动。');
console.error('');
console.error('  如确实需要重编原生模块，请用：  npm run electron:rebuild');
console.error('');
process.exit(1);
