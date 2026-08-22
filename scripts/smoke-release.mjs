// smoke-release.mjs —— 发布前冒烟：校验 electron-builder 产物结构与体积（P2-18）
//
// 用法：
//   node scripts/smoke-release.mjs           # 校验 dist/ 下的安装包
//   node scripts/smoke-release.mjs --deep    # 额外校验解包后的 asar 内容（要求 dist/win-unpacked 或 .app 存在）
// 在 `npm run build` 之后、发布之前运行；失败返回非 0 退出码。
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'))

let pass = 0, fail = 0
function check(label, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) }
  else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}

// 期待产物：${productName}-Setup-${version}.exe（win）/ ${productName}-${version}-mac-${arch}.dmg（mac）
const product = pkg.build?.productName || pkg.productName || 'Yaotai'
const version = pkg.version

function listDist() {
  try { return fs.readdirSync(DIST) } catch { return [] }
}

console.log(`[smoke-release] product=${product} version=${version}`)
if (!fs.existsSync(DIST)) {
  console.error('[smoke-release] dist/ 不存在——请先运行 npm run build')
  process.exit(1)
}

const files = listDist()
console.log(`[smoke-release] dist/ 共 ${files.length} 个条目`)

const winInstaller = files.find(f => /^.*Setup.*\.exe$/i.test(f))
const macDmg = files.filter(f => /\.dmg$/i.test(f))
const winUnpacked = fs.existsSync(path.join(DIST, 'win-unpacked'))
const macApp = files.filter(f => /\.app$/i.test(f) || /\.app$/.test(f.replace(/\.zip$/, '')))

// Windows 安装包
check('Windows nsis 安装包存在', !!winInstaller, winInstaller || '(缺)')
if (winInstaller) {
  const sizeMb = fs.statSync(path.join(DIST, winInstaller)).size / 1048576
  check('Windows 安装包 > 10MB（非空壳）', sizeMb > 10, `${sizeMb.toFixed(1)}MB`)
}

// macOS dmg
if (macDmg.length) {
  check('macOS dmg 存在', macDmg.length > 0, macDmg.join(', '))
  for (const d of macDmg) {
    const sizeMb = fs.statSync(path.join(DIST, d)).size / 1048576
    check(`macOS dmg ${d} > 10MB`, sizeMb > 10, `${sizeMb.toFixed(1)}MB`)
  }
} else {
  check('macOS dmg 存在（本机未打 mac 包时可忽略）', true, '(非 mac 构建环境跳过)')
}

// asar 校验（解包目录存在时）
const asarCandidates = []
if (winUnpacked) asarCandidates.push(path.join(DIST, 'win-unpacked', 'resources', 'app.asar'))
if (macApp.length) asarCandidates.push(path.join(DIST, macApp[0], 'Contents', 'Resources', 'app.asar'))
const asar = asarCandidates.find(p => fs.existsSync(p))
if (asar) {
  const sizeMb = fs.statSync(asar).size / 1048576
  check('app.asar 存在且 > 1MB', sizeMb > 1, `${sizeMb.toFixed(1)}MB`)
}

// 深校验：解包内容关键文件
if (process.argv.includes('--deep')) {
  const unpackedApp = winUnpacked
    ? path.join(DIST, 'win-unpacked')
    : (macApp.length ? path.join(DIST, macApp[0]) : null)
  if (unpackedApp) {
    const walk = (dir, depth = 0, out = []) => {
      if (depth > 4 || out.length > 500) return out
      try { fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) walk(full, depth + 1, out)
        else out.push(full)
      }) } catch {}
      return out
    }
    const all = walk(unpackedApp)
    const hasElectronExe = all.some(f => /electron\.exe$/i.test(f))
    const hasAsar = all.some(f => /app\.asar$/.test(f))
    const hasSqlite = all.some(f => /better_sqlite3\.node$/.test(f))
    const unpackedSqlite = all.some(f => /app\.asar\.unpacked.*better_sqlite3.*\.node$/.test(f))
    check('解包目录含 electron 可执行文件', hasElectronExe)
    check('解包目录含 app.asar', hasAsar)
    check('解包目录含 better-sqlite3 原生模块', hasSqlite || unpackedSqlite)
  } else {
    check('解包目录存在（--deep）', false, '(未找到 win-unpacked 或 .app)')
  }
}

console.log(`\n[smoke-release] ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
