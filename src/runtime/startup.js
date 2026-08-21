// startup.js —— 启动扫描（自 src/index.js 拆出）
// 职责：首次启动资源复制、安装目录数据救援、本机环境扫描、地理/热点/本地 Agent/工具槽
// 加载、技能目录加载。全部带硬超时（withStartupTimeout），绝不阻塞后端启动。
import { seedSandboxOnce, seedMusicOnce, rescueDataFromInstallDir } from '../paths.js'
import { collectSystemInfo, getDesktopPath } from '../system-info.js'
import { collectDesktopInfo } from '../desktop-scanner.js'
import { collectInstalledSoftware } from '../installed-software-scanner.js'
import { collectLocalResources } from '../local-resources-scanner.js'
import { collectGeoWeather } from '../geo-weather.js'
import { collectTrending } from '../trending.js'
import { collectAgents } from '../agents/registry.js'
import { loadInstalledTools } from '../capabilities/marketplace/index.js'
import { setStickyEvent } from '../events.js'
import { refreshSkills } from '../skills/registry.js'

export function reportStartupProgress(id, status, detail, message) {
  try {
    const reporter = globalThis.bailongmaStartupProgress
    if (typeof reporter === 'function') reporter({ id, status, detail, message })
  } catch (e) { console.warn('[src/runtime/startup.js] op failed:', e?.message || e) }
}

// 启动期"自感知"采集（地理/天气/热点/本机 agent/已装工具）是可选的、依赖网络或子进程的步骤，
// 绝不应阻塞后端启动：某个外部调用卡死（如 DNS/connect 被挂住，连 AbortController 都打不断）
// 不能把整个 startAPI 拖到永不执行。给每个采集套硬上限，超时即跳过（非致命），保证一定能启动。
export function withStartupTimeout(promise, ms, label) {
  return Promise.race([
    Promise.resolve(promise).catch(err => { console.warn(`${label} 失败(忽略):`, err?.message || err); return null }),
    new Promise(resolve => setTimeout(() => { console.warn(`${label} 超时 ${ms}ms,跳过(不阻塞启动)`); resolve(null) }, ms)),
  ])
}

// 执行全部启动扫描。返回 { geoResult, startupSkills } 供 index.js 的 buildSystemPrompt / main 使用。
export async function runStartupScans() {
  // On first launch, copy sandbox seed files from the resource directory to the user data directory (Electron install)
  reportStartupProgress('resources', 'running', '复制沙箱与音乐资源', '正在准备工作区')
  seedSandboxOnce()
  seedMusicOnce()

  // 安全护栏：把历史上误落在安装目录里的工作文件迁回 sandbox（避免下次更新随安装目录被清空）。
  // 迁移发生后用粘性事件告警，前端连上即可看到提示。
  try {
    const rescuedDirs = rescueDataFromInstallDir()
    if (rescuedDirs.length > 0) {
      setStickyEvent('install_dir_rescue', {
        level: 'warning',
        dirs: rescuedDirs,
        message: `检测到 ${rescuedDirs.length} 个工作目录原先存放在程序安装目录里（更新时会被清空），已自动迁移到 sandbox：${rescuedDirs.join('、')}`,
      })
    }
  } catch (err) {
    console.warn('[startup] 安装目录数据迁移检查失败:', err?.message || err)
  }
  reportStartupProgress('resources', 'done', '工作区已准备', '工作区已准备')

  // Collect host system environment info (full scan + persist on first run, then refresh dynamic fields).
  // Must complete before the main loop starts so buildSystemPrompt can inject the env block.
  reportStartupProgress('environment', 'running', '系统、桌面、软件与本地资源', '正在扫描本机环境')
  await collectSystemInfo()
  // Scan the user's desktop (shortcuts cached by mtime, regular files scanned every time)
  collectDesktopInfo(getDesktopPath())
  // Scan installed software once so software/app/proxy questions can use local evidence.
  collectInstalledSoftware()
  // Scan the user's local resources (ssh hosts, keys, known_hosts, git identity)
  collectLocalResources()
  reportStartupProgress('environment', 'done', '本机环境已扫描', '本机环境已扫描')

  // Collect geo-location + live weather (refresh on IP change or after 7 days; weather refreshed every time)
  reportStartupProgress('geo', 'running', '读取缓存或请求实时天气', '正在刷新天气位置')
  const geoResult = await withStartupTimeout(collectGeoWeather(), 12000, '[startup] geo-weather')
  reportStartupProgress('geo', 'done', '天气位置已刷新', '天气位置已刷新')

  // Collect trending topics (CN → Weibo+Zhihu, others → HN+Reddit; 1h cache)
  reportStartupProgress('trending', 'running', '加载今日热点源', '正在采集热点')
  await withStartupTimeout(collectTrending(geoResult?.location?.country_code), 12000, '[startup] trending')
  reportStartupProgress('trending', 'done', '热点采集完成', '热点采集完成')

  // Scan locally installed AI agents (Claude Code, Codex, Hermes, OpenClaw, etc.)
  reportStartupProgress('agents', 'running', 'Claude Code / Codex / Hermes', '正在扫描本地 Agent')
  await withStartupTimeout(collectAgents(), 15000, '[startup] agents')
  reportStartupProgress('agents', 'done', '本地 Agent 扫描完成', '本地 Agent 扫描完成')

  // Load persisted installed tools
  reportStartupProgress('tools', 'running', '恢复已安装能力', '正在加载工具槽')
  await withStartupTimeout(loadInstalledTools(), 12000, '[startup] installed-tools')
  reportStartupProgress('tools', 'done', '工具槽已加载', '工具槽已加载')

  // Load Agent Skills metadata. Full SKILL.md bodies are injected only when a turn matches.
  reportStartupProgress('skills', 'running', '技能目录、SQLite、线程状态', '正在加载技能和记忆')
  const startupSkills = refreshSkills()
  console.log(`[skills] Loaded ${startupSkills.length} Agent Skill(s)`)

  return { geoResult, startupSkills }
}

// 本地嵌入模型预热：provider==='local' 时后台 fire-and-forget 建好 pipeline（含首次模型下载），
// 让首条向量召回不被冷启动撞穿超时。绝不阻塞启动，失败静默（召回会自动退化为 FTS5）。
export function warmupLocalEmbeddingAsync() {
  ;(async () => {
    try {
      const { getEmbeddingCredentials } = await import('../config.js')
      const cred = getEmbeddingCredentials()
      if (cred?.provider === 'local' && cred.model) {
        const { warmupLocalEmbedding } = await import('../embedding-local.js')
        warmupLocalEmbedding(cred.model).catch(() => {})
      }
    } catch (e) { console.warn('[src/runtime/startup.js] op failed:', e?.message || e) }
  })().catch(() => {})
}
