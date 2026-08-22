// seedance.js —— Seedance AI 视频生成（火山方舟 Ark）配置
// 从 src/config.js 拆出：seedance 存独立文件（seedance.json），与主 config.json 物理隔离，
// 避免被 activate() 等"全量覆盖写 config.json"的操作误删。
import fs from 'fs'
import { paths } from '../paths.js'

const SEEDANCE_DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'
const SEEDANCE_DEFAULT_MODEL = 'doubao-seedance-2-0-260128'

// seedance.json 读写（独立文件，只放 seedance 配置，谁都不会全量覆盖它）
function readSeedanceFile() {
  try { return JSON.parse(fs.readFileSync(paths.seedanceConfigFile, 'utf-8')) || {} }
  catch { return {} }
}
// 导出供 config.js 的 runConfigMigrations(v0→v1) 调用（收编确定性启动迁移）
export function writeSeedanceFile(obj) {
  const tmp = paths.seedanceConfigFile + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8')
  fs.renameSync(tmp, paths.seedanceConfigFile)
}

// 一次性迁移：旧版把 seedance 存在 config.json 里。若独立文件尚无、而 config.json 里还有，
// 就搬过去并从 config.json 删除该字段，之后只认独立文件。
function migrateLegacySeedance() {
  if (fs.existsSync(paths.seedanceConfigFile)) return
  let mainCfg
  try { mainCfg = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8')) } catch { return }
  const legacy = mainCfg?.seedance
  if (!legacy || typeof legacy !== 'object') return
  try {
    writeSeedanceFile(legacy)
    const { seedance: _removed, ...rest } = mainCfg
    // 与 config.js 的 writeStoredConfig 同款：tmp + rename，绝不原地直接写
    const tmp = paths.configFile + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(rest, null, 2), 'utf-8')
    fs.renameSync(tmp, paths.configFile)
    console.log('[config] 已把旧的 seedance 配置从 config.json 迁移到 seedance.json')
  } catch (e) {
    console.warn('[config] seedance 迁移失败:', e.message)
  }
}

export function getSeedanceConfig() {
  // 环境变量优先（ARK_API_KEY），方便开发/部署注入
  const envKey = String(process.env.ARK_API_KEY || process.env.SEEDANCE_API_KEY || '').trim()
  migrateLegacySeedance()
  const stored = readSeedanceFile()
  const apiKey = envKey || String(stored.apiKey || '').trim()
  return {
    apiKey,
    model: String(stored.model || '').trim() || SEEDANCE_DEFAULT_MODEL,
    baseURL: String(stored.baseURL || '').trim() || SEEDANCE_DEFAULT_BASE_URL,
    configured: Boolean(apiKey),
  }
}

export function isSeedanceConfigured() {
  return getSeedanceConfig().configured
}

export function setSeedanceConfig({ apiKey, model, baseURL } = {}) {
  migrateLegacySeedance()
  const next = { ...readSeedanceFile() }
  if (apiKey !== undefined) next.apiKey = String(apiKey || '').trim()
  if (model !== undefined) next.model = String(model || '').trim()
  if (baseURL !== undefined) next.baseURL = String(baseURL || '').trim()
  // 没有 key 时删掉独立文件，保持干净
  if (!next.apiKey) {
    try { fs.rmSync(paths.seedanceConfigFile, { force: true }) } catch (e) { console.warn('[src/config/seedance.js] op failed:', e?.message || e) }
    return getSeedanceConfig()
  }
  writeSeedanceFile(next)
  return getSeedanceConfig()
}
