// io.js —— config 共享的低层文件 I/O 与合并写（从 src/config.js 拆出）
//
// 所有"读 config.json / 合并后写回"的约束都在这里收敛：
//   · 写必走 tmp + rename（原子），绝不原地直接写
//   · setter 必须基于 readExistingStoredConfig 合并，绝不全量覆盖（避免抹掉 voice/tts/security 等兄弟块）
// config.js 与 src/config/*.js 各功能模块统一从这里取用，杜绝各写一份。
import fs from 'fs'
import path from 'path'
import { paths } from '../paths.js'

export function readParsedConfig() {
  try {
    if (!fs.existsSync(paths.configFile)) return null
    const parsed = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8'))
    return (parsed && typeof parsed === 'object') ? parsed : null
  } catch {
    return null
  }
}

export function writeStoredConfig(obj) {
  const tmp = paths.configFile + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8')
  fs.renameSync(tmp, paths.configFile)
}

// 读出 config.json 现有内容（失败返回空对象）。
// activate() 等写操作必须基于它合并，否则会抹掉 voice/tts/security 等其它字段。
export function readExistingStoredConfig() {
  try { return JSON.parse(fs.readFileSync(paths.configFile, 'utf-8')) || {} }
  catch { return {} }
}

// 顶级字段的"读-浅合并-写"一把梭。所有 setter 都该走它（或 readExistingStoredConfig），
// 把"写时必合并、绝不全量覆盖"变成不可绕过的约束。
// 注意：浅合并无法删除键；需要删字段的 setter 仍自行 readExistingStoredConfig + 解构剔除后 writeStoredConfig。
export function patchConfig(partial) {
  const merged = { ...readExistingStoredConfig(), ...partial }
  writeStoredConfig(merged)
  return merged
}

export function readJsonObjectFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
    return (parsed && typeof parsed === 'object') ? parsed : null
  } catch {
    return null
  }
}

export function writeJsonObjectFile(file, record) {
  const tmp = `${file}.tmp`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf-8')
  fs.renameSync(tmp, file)
}
