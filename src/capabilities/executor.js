import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { upsertPrefetchTask, removePrefetchTask, listPrefetchTasks, setConfig as dbSetConfig } from '../db.js'
import { emitEvent, setStickyEvent } from '../events.js'
import { getTerminalStreamSnapshot, recordTerminalStreamEvent } from '../terminal-stream.js'
import { streamToolFileWriteExecutionPreview } from '../write-file-preview.js'
import { setCustomInterval as setTickerInterval } from '../ticker.js'
import { setUserLocation } from '../weather.js'
import { getAgentById, isDelegationAllowed } from '../agents/registry.js'
import { isInstalledTool, executeInstalledTool } from './marketplace/index.js'
import { execManageToolFactory } from './tool-factory.js'
import { execInstallTool, execUninstallTool, execListTools, execFindTool } from './tools/marketplace-tools.js'
import { execSetTask, execCompleteTask, execUpdateTaskStep, execReviewVerdict, execReviewWork, execFocusBanner } from './tools/task-tools.js'
import { throwIfAborted } from './abort-utils.js'
import { execUISet } from './tools/scene.js'
import { SANDBOX_ROOT } from './sandbox.js'
import { sceneStore } from '../scene/scene-store.js'
import { sceneClientCount } from '../scene/scene-server.js'
import { evaluateToolPolicy } from './tool-policy.js'
import { inferToolStatus, writeToolAuditLog } from './tool-audit.js'
import { tracer } from '../observability/index.js'
import { execCopyFile, execDeleteFile, execFindFile, execListDir, execMakeDir, execMoveFile, execReadFile, execRenameFile, execWriteFile } from './tools/filesystem.js'
import { execReadDocument } from './tools/documents.js'
import { execKnowledgeIngest, execKnowledgeSearch, execKnowledgeList, execKnowledgeDelete, execKnowledgeStats } from './tools/knowledge.js'
import { execRunPython, execPythonPackages } from './tools/python-sandbox.js'
import { execCostStats, execTraceList, execTraceDetail, execObservabilityDashboard, execToolReceipt } from './tools/observability.js'
import { execRequestApproval as execHitlRequest, execListApprovals as execHitlList } from './tools/hitl.js'
import { execWorkflowRun, execWorkflowList, execWorkflowSave, execWorkflowDelete, execProposeWorkflow } from './tools/workflow.js'
import { execBackgroundCommand, execCommand, execDownloadFile, execKillProcess, execListProcesses, execQuickCommand, execRunNodeScript, execTaskCommand } from './tools/shell.js'
import { execInstallSoftware, listSoftwareInstallJobs } from './tools/software-install.js'
import { execBrowserRead, execBrowserAct, execDeepResearch, execFetchUrl, execWebSearch } from './tools/web.js'
import { execDowngradeMemory, execMergeMemories, execProbeMemory, execRecallMemory, execSearchMemory, execSkipConsolidation, execSkipRecognition, execUpsertMemory, execAskMemory, execManageVault } from './tools/memory.js'
import { execManageReminder } from './tools/reminders.js'
import { execSetGoal, execListGoals, execUpdateGoal, execShowBriefing } from './tools/goals.js'
import { execDeleteSkill, execImproveSkill, execLearnSkill, execListSkills, execViewSkill } from './tools/skills.js'
import { execMcpCall, execMcpListServers } from './tools/mcp.js'
import { execManageTodo, execWeeklyReview } from './tools/workbench.js'
import { execAdoptRole } from './tools/roles.js'
import { execCaptureScreen } from './tools/capture.js'
import { execSpawnSubagents } from './tools/spawn.js'
import { execJunjichu } from '../multi-agent/control.js'
import { execHotspotMode, execWorldcupMode, execTyphoonMode, execBaguaMode, execMapMode, execOpenDocPanel, execPreviewFile, execPersonCardMode } from "./tools/panels.js"
import { runTask as runA2ATask } from '../agents/a2a-client.js'
import { backupLocalData } from '../runtime/backup.js'
import { execGenerateImage, execGenerateLyrics, execGenerateMusic, execMediaMode, execMusic, execSpeak } from './tools/media.js'
import { execAnalyzeImage, execManageApiCapability, execRunApiCapability } from './tools/api-capability.js'
import { execManageRule } from './tools/rules.js'
import { CAPABILITY_DEMO_INTRO, runCapabilityDemo } from '../capability-demo.js'
import { deliverMessage } from '../runtime/delivery.js'
export { calculateNextDueAt } from './tools/reminders.js'
export { autoSpeakForVoiceReply } from './tools/media.js'
export { detectOpenFollowupQuestion } from '../runtime/delivery.js'

import { isExternalChannel } from '../identity.js'

// 工具执行器：根据工具名和参数执行对应操作，返回结果字符串
function inferFileWritePreviewOutcome(result = '') {
  try {
    const parsed = JSON.parse(String(result || ''))
    if (parsed && typeof parsed === 'object') {
      const bytes = parsed.bytes ?? parsed.size ?? parsed.length
      const ok = parsed.ok
      const verified = parsed.verified ?? (ok === undefined ? true : ok !== false)
      return { bytes, verified }
    }
  } catch (e) { console.warn('[src/capabilities/executor.js] op failed:', e?.message || e) }
  return { verified: true }
}

function getDesktopWindowLayoutSnapshot() {
  try {
    const reader = globalThis?.getBailongmaWindowLayoutSnapshot
    return typeof reader === 'function' ? reader() : null
  } catch {
    return null
  }
}

function normalizeOptionalBoolean(value) {
  if (value === undefined) return undefined
  if (value === true || value === false) return value
  const text = String(value).trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(text)) return true
  if (['false', '0', 'no', 'off', ''].includes(text)) return false
  return !!value
}

const LOCAL_FILE_OPEN_COMMAND_RE = /\b(Start-Process|Invoke-Item|ii|explorer(?:\.exe)?|notepad(?:\.exe)?|wordpad(?:\.exe)?|typora(?:\.exe)?|code(?:\.cmd|\.exe)?|subl(?:ime_text)?(?:\.exe)?|notepad\+\+(?:\.exe)?)\b|(?:^|[;&|])\s*start(?:\s|$)|\bcmd(?:\.exe)?\s+\/c\s+start(?:\s|$)/i
const LOCAL_OPEN_FILE_EXT_SOURCE = 'md|markdown|mdx|txt|rtf|html?|css|js|jsx|ts|tsx|json|ya?ml|xml|csv|log|py|sh|bash|ps1|bat|cmd|sql|rst|adoc|docx?'
const LOCAL_OPEN_FILE_EXT_PART = `(?:${LOCAL_OPEN_FILE_EXT_SOURCE})`
const LOCAL_OPEN_FILE_EXT_RE = new RegExp(`\\.(${LOCAL_OPEN_FILE_EXT_SOURCE})$`, 'i')

function normalizeComparablePath(filePath = '') {
  const resolved = path.normalize(path.resolve(String(filePath || '')))
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function addComparablePath(out, filePath = '') {
  if (!filePath) return
  out.add(normalizeComparablePath(filePath))
  try {
    if (fs.existsSync(filePath)) out.add(normalizeComparablePath(fs.realpathSync.native(filePath)))
  } catch (e) { console.warn('[src/capabilities/executor.js] op failed:', e?.message || e) }
}

function resolveShellCwd(args = {}) {
  const raw = String(args?.cwd || '').trim()
  if (!raw) return SANDBOX_ROOT
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(SANDBOX_ROOT, raw)
}

function cleanOpenPathToken(value = '') {
  let text = String(value || '').trim()
  text = text.replace(/^[`"'([{]+/, '').replace(/[`"',;)\]}]+$/, '')
  if (!text) return ''
  if (/^(https?|mailto):\/\//i.test(text)) return ''
  if (/^file:\/\//i.test(text)) {
    try {
      text = fileURLToPath(text)
    } catch {
      return ''
    }
  }
  return LOCAL_OPEN_FILE_EXT_RE.test(text) ? text : ''
}

function resolveOpenFileCandidate(rawPath = '', cwd = SANDBOX_ROOT) {
  const cleaned = cleanOpenPathToken(rawPath)
  if (!cleaned) return ''
  return path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(cwd, cleaned)
}

function extractLocalOpenFileCandidates(command = '', cwd = SANDBOX_ROOT) {
  const text = String(command || '')
  if (!LOCAL_FILE_OPEN_COMMAND_RE.test(text)) return []

  const candidates = new Set()
  const add = (value) => {
    const resolved = resolveOpenFileCandidate(value, cwd)
    if (resolved) candidates.add(normalizeComparablePath(resolved))
  }

  const quoted = new RegExp(`["']([^"']+\\.${LOCAL_OPEN_FILE_EXT_PART})["']`, 'ig')
  let match
  while ((match = quoted.exec(text)) !== null) add(match[1])

  const bare = new RegExp(`(^|[\\s=])([^\\s"'|;&<>]+\\.${LOCAL_OPEN_FILE_EXT_PART})(?=$|[\\s)'";|&<>])`, 'ig')
  while ((match = bare.exec(text)) !== null) add(match[2])

  return Array.from(candidates)
}

function currentWriteFileArtifactPaths(snapshot) {
  const out = new Set()
  const artifactPath = String(snapshot?.artifact_path || '').trim()
  if (!artifactPath) return out
  if (path.isAbsolute(artifactPath)) {
    addComparablePath(out, artifactPath)
  } else {
    addComparablePath(out, path.resolve(SANDBOX_ROOT, artifactPath))
  }
  return out
}

function commandResultLooksSuccessful(result = '') {
  try {
    const obj = JSON.parse(String(result || '{}'))
    if (obj.ok === false) return false
    if (obj.exit_code !== undefined && obj.exit_code !== null) return Number(obj.exit_code) === 0
    return true
  } catch {
    return true
  }
}

function maybeCloseWriteFilePreviewAfterLocalOpen(args = {}, result = '') {
  if (!commandResultLooksSuccessful(result)) return null
  const command = String(args.command || args.cmd || '')
  const candidates = extractLocalOpenFileCandidates(command, resolveShellCwd(args))
  if (candidates.length === 0) return null

  const snapshot = getTerminalStreamSnapshot('write_file')
  if (!snapshot || snapshot.closed || !snapshot.artifact_path) return null

  const artifactPaths = currentWriteFileArtifactPaths(snapshot)
  const openedPath = candidates.find(candidate => artifactPaths.has(candidate))
  if (!openedPath) return null

  try {
    globalThis?.terminalStreamBridge?.emit?.('close', {
      stream_id: 'write_file',
      source: 'local_file_open',
      artifact_path: snapshot.artifact_path,
    })
  } catch (e) { console.warn('[src/capabilities/executor.js] op failed:', e?.message || e) }
  recordTerminalStreamEvent({ action: 'close', stream_id: 'write_file', force: true })
  return {
    stream_id: 'write_file',
    reason: 'local_file_open',
    artifact_path: snapshot.artifact_path,
    opened_path: openedPath,
  }
}

function addTerminalCloseInfo(result = '', closeInfo = null) {
  if (!closeInfo) return result
  try {
    const obj = JSON.parse(String(result || '{}'))
    obj.terminal_stream_closed = closeInfo
    return toolJson(obj)
  } catch {
    return result
  }
}

async function execShellToolAndMaybeCloseWritePreview(runner, args, context) {
  const result = await runner(args, context)
  const closeInfo = maybeCloseWriteFilePreviewAfterLocalOpen(args, result)
  return addTerminalCloseInfo(result, closeInfo)
}

async function executeToolUnchecked(name, args, context = {}) {
  try {
    throwIfAborted(context.signal)
    switch (name) {
      case 'express':
        return await execExpress(args, context)
      case 'send_message':
        return await execSendMessage(args, context)
      case 'read_file':
        return await execReadFile(args, context)
      case 'list_dir':
        return await execListDir(args, context)
      case 'read_document':
        return await execReadDocument(args, context)
      case 'knowledge_ingest':
        return await execKnowledgeIngest(args, context)
      case 'knowledge_search':
        return await execKnowledgeSearch(args)
      case 'knowledge_list':
        return execKnowledgeList(args)
      case 'knowledge_delete':
        return execKnowledgeDelete(args)
      case 'knowledge_stats':
        return execKnowledgeStats()
      case 'run_python':
        return await execRunPython(args, context)
      case 'python_packages':
        return await execPythonPackages()
      case 'cost_stats':
        return execCostStats(args)
      case 'trace_list':
        return execTraceList(args)
      case 'trace_detail':
        return execTraceDetail(args)
      case 'observability_dashboard':
        return execObservabilityDashboard(args)
      case 'tool_receipt':
        return execToolReceipt(args)
      case 'hitl_request':
        return await execHitlRequest(args, context)
      case 'hitl_list':
        return execHitlList(args)
      case 'workflow_run':
        return await execWorkflowRun(args, context)
      case 'workflow_list':
        return execWorkflowList(args)
      case 'workflow_save':
        return execWorkflowSave(args)
      case 'workflow_delete':
        return execWorkflowDelete(args)
      case 'propose_workflow':
        return await execProposeWorkflow(args, context)
      case 'write_file':
        return await execWriteFile(args, context)
      case 'delete_file':
        return await execDeleteFile(args, context)
      case 'make_dir':
        return await execMakeDir(args, context)
      case 'rename_file':
        return await execRenameFile(args, context)
      case 'copy_file':
        return await execCopyFile(args, context)
      case 'move_file':
        return await execMoveFile(args, context)
      case 'find_file':
        return await execFindFile(args, context)
      case 'install_software':
        return await execInstallSoftware(args, context)
      case 'exec_command':
        return await execShellToolAndMaybeCloseWritePreview(execCommand, args, context)
      case 'run_node_script':
        return await execRunNodeScript(args, context)
      case 'exec_quick_command':
        return await execShellToolAndMaybeCloseWritePreview(execQuickCommand, args, context)
      case 'exec_task_command':
        return await execShellToolAndMaybeCloseWritePreview(execTaskCommand, args, context)
      case 'exec_background_command':
        return await execShellToolAndMaybeCloseWritePreview(execBackgroundCommand, args, context)
      case 'download_file':
        return await execDownloadFile(args, context)
      case 'kill_process':
        return await execKillProcess(args)
      case 'list_processes':
        return await execListProcessesWithSoftwareJobs(args)
      case 'web_search':
        return await execWebSearch(args, context)
      case 'fetch_url':
        return await execFetchUrl(args, context)
      case 'browser_read':
        return await execBrowserRead(args, context)
      case 'browser_act':
        return await execBrowserAct(args, context)
      case 'deep_research':
        return await execDeepResearch(args, context)
      case 'search_memory':
        return await execSearchMemory(args)
      case 'probe_memory':
        return await execProbeMemory(args)
      case 'upsert_memory':
        return await execUpsertMemory(args, context)
      case 'skip_recognition':
        return await execSkipRecognition(args)
      case 'merge_memories':
        return await execMergeMemories(args, context)
      case 'downgrade_memory':
        return await execDowngradeMemory(args)
      case 'skip_consolidation':
        return await execSkipConsolidation(args)
      case 'speak':
        return await execSpeak(args)
      case 'generate_lyrics':
        return await execGenerateLyrics(args)
      case 'generate_music':
        return await execGenerateMusic(args)
      case 'generate_image':
        return await execGenerateImage(args)
      case 'set_tick_interval':
        return execSetTickInterval(args)
      case 'media_mode':
        return execMediaMode(args)
      case 'hotspot_mode':
        return execHotspotMode(args)
      case 'worldcup_mode':
        return execWorldcupMode(args)
      case 'typhoon_mode':
        return execTyphoonMode(args)
      case 'bagua_mode':
        return execBaguaMode(args)
      case 'map_mode':
        return execMapMode(args)
      case 'open_doc_panel':
        return execOpenDocPanel(args)
      case 'preview_file':
        return execPreviewFile(args)
      case 'person_card_mode':
        return execPersonCardMode(args)
      case 'music':
        // 注意：放歌/搜索等耗时工具的"在找…"即时回应已统一在 llm.js 工具循环（ackSent）里发，
        // 覆盖所有耗时工具且保证一个 turn 只应一声，这里不再单独发，避免重复两条。
        return await execMusic(args)
      case 'schedule_reminder':
      case 'manage_reminder':
        return await execManageReminder(args, context)
      case 'manage_prefetch_task':
        return execManagePrefetchTask(args)
      case 'manage_rule':
        return execManageRule(args)
      case 'set_goal':
        return execSetGoal(args)
      case 'list_goals':
        return execListGoals(args)
      case 'update_goal':
        return execUpdateGoal(args)
      case 'show_briefing':
        return await execShowBriefing(args)
      case 'manage_todo':
        return execManageTodo(args)
      case 'adopt_role':
        return execAdoptRole(args)
      case 'spawn_subagents':
        return await execSpawnSubagents(args, context)
      case 'junjichu':
        return await execJunjichu(args)
      case 'weekly_review':
        return execWeeklyReview(args)
      case 'list_skills':
        return execListSkills(args)
      case 'view_skill':
        return execViewSkill(args)
      case 'learn_skill':
        return execLearnSkill(args)
      case 'improve_skill':
        return execImproveSkill(args)
      case 'delete_skill':
        return execDeleteSkill(args)
      case 'mcp_list_servers':
        return await execMcpListServers()
      case 'mcp_call':
        return await execMcpCall(args)
      case 'ui_set':
        return execUISet(args)
      case 'capability_demo':
        return execCapabilityDemo(args, context)
      case 'focus_banner':
        return execFocusBanner(args)
      case 'terminal_stream':
        return execTerminalStream(args)
      case 'voice_retire':
        return execVoiceRetire(args)
      case 'set_location':
        return execSetLocation(args)
      case 'set_agent_name':
        return execSetAgentName(args)
      case 'delegate_to_agent':
        return await execDelegateToAgent(args, context)
      case 'grant_agent_delegation':
        return execGrantAgentDelegation(args)
      case 'complete_startup_self_check':
        return execCompleteStartupSelfCheck(args, context)
      case 'set_task':
        return execSetTask(args, context)
      case 'complete_task':
        return execCompleteTask(args, context)
      case 'update_task_step':
        return execUpdateTaskStep(args, context)
      case 'review_work':
        return await execReviewWork(args, context)
      case 'review_verdict':
        return execReviewVerdict(args)
      case 'recall_memory':
        return await execRecallMemory(args, context)
      case 'manage_vault':
        return await execManageVault(args)
      case 'ask_memory':
        return await execAskMemory(args)
      case 'install_tool':
        return await execInstallTool(args)
      case 'uninstall_tool':
        return execUninstallTool(args)
      case 'list_tools':
        return execListTools()
      case 'manage_tool_factory':
        return await execManageToolFactory(args)
      case 'run_capability':
      case 'run_api_capability':
        return await execRunApiCapability(args, context)
      case 'analyze_image':
        return await execAnalyzeImage(args, context)
      case 'capture_screen':
        return execCaptureScreen(args)
      case 'manage_api_capability':
        return execManageApiCapability(args)
      case 'find_tool':
        return execFindTool(args)
      case 'connect_wechat':
        return execConnectWechat()
      case 'connect_feishu':
        return execConnectFeishu()
      case 'set_security':
        return execSetSecurity(args)
      case 'request_approval':
        return execRequestApproval(args)
      case 'backup_data':
        return execBackupData(args)
      default:
        if (isInstalledTool(name)) {
          const previewed = streamToolFileWriteExecutionPreview(name, args)
          const result = await executeInstalledTool(name, args)
          if (previewed) streamToolFileWriteExecutionPreview(name, args, inferFileWritePreviewOutcome(result))
          return result
        }
        return `错误：未知工具 "${name}"`
    }
  } catch (err) {
    if (err.name === 'AbortError') throw err
    return `执行失败：${err.message}`
  }
}

export async function executeTool(name, args, context = {}) {
  const startedAt = Date.now()
  const safeArgs = args || {}
  const policy = evaluateToolPolicy(name, safeArgs, context)

  if (!policy.allowed) {
    const result = toolJson({
      ok: false,
      tool: name,
      error: 'permission denied',
      policy: {
        risk: policy.risk,
        reason: policy.reason,
      },
    })
    writeToolAuditLog({ name, args: safeArgs, context, policy, status: 'denied', result, startedAt })
    return result
  }

  try {
    // 可观测性：工具执行 span（归到当前 turn 的 trace_id 下）
    const result = await tracer.trace('tool.exec', {
      attributes: {
        tool: name,
        risk: policy.risk,
        autonomous: !!context.autonomous,
        args_keys: Object.keys(safeArgs).slice(0, 8).join(','),
      },
    }, async (span) => {
      const r = await executeToolUnchecked(name, safeArgs, context)
      span.setAttribute('tool_status', inferToolStatus(r))
      span.setAttribute('result_len', String(r || '').length)
      return r
    })
    writeToolAuditLog({ name, args: safeArgs, context, policy, status: inferToolStatus(result), result, startedAt })
    return result
  } catch (err) {
    if (err.name === 'AbortError') throw err
    const result = `执行失败：${err.message}`
    writeToolAuditLog({ name, args: safeArgs, context, policy, status: 'error', result, error: err.message, startedAt })
    return result
  }
}

// express：表达器入口，根据 format 路由到对应输出渠道
// Extend the existing process list with structured software-install jobs.
async function execListProcessesWithSoftwareJobs(args = {}) {
  const result = await execListProcesses(args)
  try {
    const parsed = JSON.parse(result)
    const softwareInstallJobs = listSoftwareInstallJobs({ includeTerminal: true, detail: true })
    return toolJson({
      ...parsed,
      software_install_count: softwareInstallJobs.length,
      software_install_jobs: softwareInstallJobs,
    })
  } catch {
    return result
  }
}

// express: expression entrypoint; route to the requested output format.
async function execExpress({ target_id, content, channel = 'AUTO', format = 'text' }, context = {}) {
  if (!content?.trim()) return '错误：未提供表达内容'
  if (format === 'voice') {
    // 语音表达：先发文字消息再生成语音
    const sendResult = await execSendMessage({ target_id, content, channel }, context)
    if (!commandResultLooksSuccessful(sendResult)) return sendResult
    return await execSpeak({ text: content })
  }
  // 默认：文字表达
  return await execSendMessage({ target_id, content, channel }, context)
}

async function execSendMessage(args, context = {}) {
  return await deliverMessage(args, context)
}

function toolJson(payload) {
  return JSON.stringify(payload, null, 2)
}

// manage_prefetch_task：管理预热任务
function execManagePrefetchTask({ action, source, label, url, ttl_minutes, tags }) {
  if (action === 'list') {
    const tasks = listPrefetchTasks()
    if (tasks.length === 0) return '当前没有预热任务。'
    return tasks.map(t =>
      `[${t.enabled ? '✓' : '✗'}] ${t.source}  ${t.label}  TTL=${t.ttl_minutes}min\n  URL: ${t.url}`
    ).join('\n')
  }

  if (action === 'add') {
    if (!source) return '错误：缺少 source'
    if (!label) return '错误：缺少 label'
    if (!url) return '错误：缺少 url'
    upsertPrefetchTask({ source, label, url, ttlMinutes: ttl_minutes ?? 60, tags: tags ?? [] })
    return `预热任务已保存：${source}（${label}），TTL=${ttl_minutes ?? 60}min。下次运行预热时生效。`
  }

  if (action === 'remove') {
    if (!source) return '错误：缺少 source'
    const ok = removePrefetchTask(source)
    return ok ? `预热任务已删除：${source}` : `未找到任务：${source}`
  }

  return `错误：未知 action "${action}"，可选 add / remove / list`
}

// set_tick_interval：L2 调节自身思维节奏
function execSetTickInterval({ seconds, ttl, reason }) {
  const res = setTickerInterval({ seconds, ttl, reason })
  if (!res.ok) return `错误：${res.error}`
  // noop 路径：返回 JSON 让 isToolFailure 识别为软失败,触发 maxSameFailures 熔断。
  // 旧的纯文本返回 isToolFailure 检测不到失败,模型在同 callLLM 内可以无限重调浪费 round。
  // ok:false 让前端也明确显示"无效调用",别再误导用户以为节奏变了。
  if (res.noop) {
    return JSON.stringify({
      ok: false,
      tool: 'set_tick_interval',
      noop: true,
      seconds: res.seconds,
      ttl: res.ttl,
      error: `tick interval already ${res.seconds}s with ${res.ttl} rounds left; call rejected as no-op`,
      reason: 'Calling set_tick_interval with the current value is a no-op and wastes a round. Only call when you actually need to change the pace.',
    })
  }
  const parts = [`节奏已设为 ${res.seconds}s，持续 ${res.ttl} 轮`]
  if (res.clampedFrom?.seconds !== undefined) parts.push(`（seconds ${res.clampedFrom.seconds} 越界，已 clamp 到 ${res.seconds}）`)
  if (res.clampedFrom?.ttl !== undefined) parts.push(`（ttl ${res.clampedFrom.ttl} 越界，已 clamp 到 ${res.ttl}）`)
  return parts.join('')
}

// ─────────────────────────────────────────────────────────────────────────────
// 面板 · 界面控制工具
// ─────────────────────────────────────────────────────────────────────────────
function execCapabilityDemo(args = {}, context = {}) {
  if (isExternalChannel(context.currentChannel)) {
    return toolJson({
      ok: false,
      tool: 'capability_demo',
      error: 'capability_demo is local-only. For external channels, answer the capability question in text instead of opening local UI or speech.',
    })
  }
  const spokenText = runCapabilityDemo({
    to: context.currentTargetId || '',
    channel: context.currentChannel || 'TUI',
    speak: true,
    message: true,
  })
  emitEvent('action', {
    tool: 'capability_demo',
    summary: '启动能力展示',
    detail: args.reason || context.currentUserMessage || '',
  })
  return toolJson({
    ok: true,
    tool: 'capability_demo',
    started: true,
    delivered: true,
    message_sent: true,
    spoken: true,
    spoken_text: spokenText,
    intro_text: CAPABILITY_DEMO_INTRO,
    final_reply_guidance: 'The intro message has already been sent and spoken while the visual demo starts. End the round now; do not send or speak another introduction.',
  })
}

// 任务管理工具（通过 context 回调通知 index.js）
// ─────────────────────────────────────────────────────────────────────────────

// 收起悬浮语音球：发 SSE 事件给渲染层(voice-wake.js)，由它在说完话后播退场动画收起。
// 只退场屏幕上的球，不停 app、不影响可达性。无球在场时渲染层自动忽略（幂等）。
function execTerminalStream({
  action = 'write',
  text = '',
  stream_id = 'default',
  title = 'Bailongma Terminal Stream',
  newline = true,
  level = 'info',
  format = '',
  artifact_kind = '',
  artifact_path = '',
  hold_open = undefined,
  force = false,
  placement = 'auto',
  bounds = null,
  focus = true,
} = {}) {
  const normalizedAction = String(action || 'write').trim().toLowerCase()
  if (!['open', 'write', 'clear', 'close', 'status'].includes(normalizedAction)) {
    return toolJson({ ok: false, error: 'action must be open, write, clear, close, or status' })
  }

  const bridge = global.terminalStreamBridge
  const streamId = String(stream_id || 'default').trim() || 'default'
  const cleanTitle = String(title || 'Bailongma Terminal Stream').trim() || 'Bailongma Terminal Stream'
  const normalizedHoldOpen = normalizeOptionalBoolean(hold_open)
  const forceClose = normalizeOptionalBoolean(force) === true

  if (normalizedAction === 'status') {
    const snapshot = getTerminalStreamSnapshot(streamId)
    return toolJson({
      ok: true,
      tool: 'terminal_stream',
      action: 'status',
      stream_id: snapshot.stream_id,
      title: snapshot.title,
      format: snapshot.format,
      artifact_kind: snapshot.artifact_kind,
      artifact_path: snapshot.artifact_path,
      hold_open: !!snapshot.hold_open,
      closed: snapshot.closed,
      chunks: snapshot.chunks.length,
      window_available: !!bridge,
      layout: getDesktopWindowLayoutSnapshot(),
    })
  }

  if (normalizedAction === 'close') {
    const snapshot = getTerminalStreamSnapshot(streamId)
    if (snapshot.hold_open && !forceClose) {
      return toolJson({
        ok: false,
        tool: 'terminal_stream',
        action: 'close',
        stream_id: snapshot.stream_id,
        title: snapshot.title,
        skipped: 'held_open_artifact',
        reason: 'This stream is holding an article/document preview for user review. Only close it when the user explicitly asks, with force=true.',
        window_available: !!bridge,
      })
    }
  }

  if (bridge && ['open', 'write', 'clear'].includes(normalizedAction)) {
    bridge.emit('open', { title: cleanTitle, stream_id: streamId, placement, bounds, focus })
  } else if (bridge && normalizedAction === 'close') {
    bridge.emit('close', { stream_id: streamId })
  }

  const snapshot = recordTerminalStreamEvent({
    action: normalizedAction,
    stream_id: streamId,
    title: cleanTitle,
    text,
    newline,
    level,
    format,
    artifact_kind,
    artifact_path,
    hold_open: normalizedHoldOpen,
    force: forceClose,
  })

  return toolJson({
    ok: true,
    tool: 'terminal_stream',
    action: normalizedAction,
    stream_id: snapshot.stream_id,
    title: snapshot.title,
    closed: snapshot.closed,
    chunks: snapshot.chunks.length,
    window_available: !!bridge,
  })
}

function execVoiceRetire({ reason = '' } = {}) {
  emitEvent('voice_retire', { reason: typeof reason === 'string' ? reason : '' })
  return toolJson({ ok: true, tool: 'voice_retire', retired: true, reason: String(reason || '') })
}

function execSetLocation({ city }) {
  const loc = String(city || '').trim()
  if (!loc) return toolJson({ ok: false, error: '城市名称不能为空' })
  setUserLocation(loc)
  return toolJson({ ok: true, city: loc, message: `位置已更新为：${loc}` })
}

function execSetAgentName({ name }) {
  const trimmed = String(name || '').trim()
  if (!trimmed) return toolJson({ ok: false, error: '名字不能为空' })
  if (trimmed.length > 32) return toolJson({ ok: false, error: '名字不能超过 32 个字符' })
  if (!/^[一-龥A-Za-z0-9 _-]+$/.test(trimmed)) {
    return toolJson({ ok: false, error: '名字只允许包含中文、英文字母、数字、空格、下划线、短横线' })
  }
  dbSetConfig('agent_name', trimmed)
  setStickyEvent('agent_name_updated', { name: trimmed })
  emitEvent('agent_name_updated', { name: trimmed })
  return toolJson({ ok: true, name: trimmed, message: `好的，我以后就叫 ${trimmed} 了` })
}

function execConnectWechat() {
  if (sceneClientCount() === 0) {
    return toolJson({ ok: false, error: '当前没有界面客户端，无法弹出微信连接界面。' })
  }
  emitEvent('show_wechat_popup', {})
  return toolJson({ ok: true, status: 'popup_shown', message: '已弹出微信连接二维码界面，请告知用户扫码操作。' })
}

function execConnectFeishu() {
  if (sceneClientCount() === 0) {
    return toolJson({ ok: false, error: '当前没有界面客户端，无法弹出飞书配置界面。' })
  }
  emitEvent('show_feishu_popup', {})
  return toolJson({
    ok: true,
    status: 'popup_shown',
    message: '已弹出飞书连接配置界面（含分步引导 + App ID/Secret 输入框 + 打开飞书开放平台按钮）。请引导用户：去飞书开放平台创建企业自建应用、加机器人能力和 im:message 权限、在「事件订阅」选「使用长连接接收事件」并订阅 im.message.receive_v1（不要开加密推送），把 App ID 和 App Secret 填进弹窗点连接即可，无需公网地址。',
  })
}

function execSetSecurity({ file_sandbox, exec_sandbox, reason = '' }) {
  if (file_sandbox === undefined && exec_sandbox === undefined) {
    return toolJson({ ok: false, error: '至少指定 file_sandbox 或 exec_sandbox 之一' })
  }
  if (sceneClientCount() === 0) {
    return toolJson({ ok: false, error: '当前没有界面客户端，无法弹出确认框。请告知用户到设置页面手动修改安全沙箱配置。' })
  }

  // 沙箱变更摘要拼进 choice 的 prompt（声明式 Scene 没有专用安全卡，复用通用 choice kind）。
  const changeLines = []
  if (file_sandbox !== undefined) changeLines.push(`文件沙箱将${file_sandbox ? '开启' : '关闭'}`)
  if (exec_sandbox !== undefined) changeLines.push(`执行沙箱将${exec_sandbox ? '开启' : '关闭'}`)
  const prompt = [reason, changeLines.join('；')].filter(Boolean).join('\n') || '确认安全设置变更？'

  // 待应用的变更随 surface 走（存 data.pending）：让 SceneStore 继续做唯一真相源，
  // 用户点确认时由 scene intent handler 回查本 surface 取出 pending 直接 apply（不另开并行 state）。
  // choice kind 只读 prompt/options，会忽略 pending；manifest 也只暴露 id/kind/intent，不泄露给 Agent。
  const pending = {}
  if (file_sandbox !== undefined) pending.file_sandbox = file_sandbox
  if (exec_sandbox !== undefined) pending.exec_sandbox = exec_sandbox

  const id = `security-confirm-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
  sceneStore.set(id, {
    kind: 'choice',
    intent: 'confront',   // 用户必须停下来决策：背景退后、聚焦居中
    data: {
      prompt,
      options: [
        { value: 'confirm', label: '确认', tone: 'danger' },
        { value: 'cancel',  label: '取消', tone: 'default' },
      ],
      pending,
    },
  })
  emitEvent('action', { tool: 'set_security', summary: '等待用户确认安全设置变更', detail: id })
  // 工具返回 message 明确告诉模型"卡片已经在 UI 上、用户能直接看到"——避免模型把
  // "已弹出确认卡片"这句话当成"用户还不知道，我要 send_message 复述一遍"的口播触发。
  // 用户点确认/取消时会收到 silent APP_SIGNAL turn，那时再做内部 state 更新（也不需要 send_message）。
  return toolJson({
    ok: true,
    id,
    status: 'pending_confirmation',
    message: '确认 surface 已挂出（kind=choice，居中聚焦，含"确认/取消"按钮）。用户在屏幕上直接看到了完整内容，不需要你再 send_message 复述卡片说什么或提醒用户去点确认 —— 那是冗余的口播。等用户点完，系统会用 silent APP_SIGNAL 通知你结果，那一轮也无需 send_message。本轮直接结束即可。',
  })
}

// ── 通用审批确认流（②）──
// 对齐办公产品的人机协同（提交→审批→执行）：Agent 对高风险/大规模/不可逆操作
// 可调用 request_approval 弹确认卡片，用户批准后才执行。结果经 silent APP_SIGNAL
// 通知回 agent（api.js 的 scene intent handler 处理 approval-* surface）。
function execRequestApproval({ prompt, action = '' }) {
  const promptText = String(prompt || '').trim()
  if (!promptText) return toolJson({ ok: false, tool: 'request_approval', error: 'prompt 不能为空（说明要做什么、为什么需要确认）' })
  if (sceneClientCount() === 0) {
    return toolJson({ ok: false, tool: 'request_approval', error: '当前没有界面客户端，无法弹出确认框。请改用文字向用户说明并等待回复。' })
  }
  const id = `approval-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
  sceneStore.set(id, {
    kind: 'choice',
    intent: 'confront',
    data: {
      prompt: promptText.slice(0, 500),
      options: [
        { value: 'approve', label: '批准', tone: 'danger' },
        { value: 'cancel', label: '取消', tone: 'default' },
      ],
      pending: { request_approval: true, action: String(action || '').slice(0, 300) },
    },
  })
  emitEvent('action', { tool: 'request_approval', summary: '等待用户批准操作', detail: id })
  return toolJson({
    ok: true,
    tool: 'request_approval',
    id,
    status: 'pending_approval',
    message: '批准卡片已挂出（用户在屏幕上直接看到，无需你复述）。用户点批准/取消后系统会用 silent APP_SIGNAL 通知你结果（approved=true/false）。本轮先结束，不要重复请求、不要代替用户决定、不要把"已请求"当"已批准"。',
  })
}

// ── 本地数据备份（③ 本地深度）──
function execBackupData({ target_dir = 'backups' } = {}) {
  const r = backupLocalData({ target_dir })
  if (!r.ok) return toolJson({ ok: false, tool: 'backup_data', error: r.error })
  return toolJson({
    ok: true,
    tool: 'backup_data',
    backup_dir: r.backup_dir,
    files: r.files,
    hint: '备份已完成。备份目录在沙箱内，可整体拷走/压缩实现数据迁移。可用 backup_status 查看历史备份。',
  })
}

// 把 Agent 的文档信息格式化成错误响应里的引导字段
function agentDocsHint(agent) {
  if (!agent) return {}
  const hint = {}
  if (agent.docs_url) {
    hint.docs_url = agent.docs_url
    hint.docs_hint = `调用失败。建议先用 fetch_url("${agent.docs_url}") 查阅 ${agent.name} 当前版本（${agent.version || 'unknown'}）的使用文档，确认正确的参数格式后重试。`
  } else if (agent.docs_search_query) {
    hint.docs_search_query = agent.docs_search_query
    hint.docs_hint = `调用失败。建议先用 web_search("${agent.docs_search_query}") 查找 ${agent.name} 当前版本（${agent.version || 'unknown'}）的使用文档，确认正确的调用方式后重试。`
  }
  return hint
}

async function execDelegateToAgent({ agent_id, prompt: agentPrompt, context: agentContext = '', timeout = 60 }, toolContext = {}) {
  if (!isDelegationAllowed()) {
    return toolJson({ ok: false, error: '尚未获得 Agent 委托权限，请先询问用户并通过 grant_agent_delegation 获取授权。' })
  }

  const agent = getAgentById(String(agent_id || ''))
  if (!agent) {
    return toolJson({ ok: false, error: `未找到 Agent：${agent_id}。请先用 list_known_agents 查看可用列表。` })
  }
  if (!agent.available) {
    return toolJson({
      ok: false,
      error: `Agent ${agent.name} 当前不可用（上次检测：${agent.detected_at}）。`,
      ...agentDocsHint(agent),
    })
  }

  const fullPrompt = agentContext
    ? `${agentContext.trim()}\n\n${agentPrompt.trim()}`
    : agentPrompt.trim()

  const timeoutSec = Math.min(Math.max(Number(timeout) || 60, 5), 300)

  // A2A 标准协议通道：通过 Agent Card 发现 + tasks/send 轮询与外部 Agent 通信。
  // 这是 detector 对 HTTP 型 Agent 探测到 A2A 端点后升级的首选通道。
  if (agent.invoke_type === 'a2a') {
    const baseUrl = String(agent.invoke_cmd || '').trim()
    if (!baseUrl) {
      return toolJson({ ok: false, error: `Agent ${agent.name} 标记为 A2A 但缺少 base URL。` })
    }
    const r = await runA2ATask(baseUrl, {
      text: fullPrompt,
      metadata: { delegated_by: 'bailongma', target_agent: agent.id },
      timeoutMs: timeoutSec * 1000,
      signal: toolContext?.signal,
    })
    if (!r.ok) {
      return toolJson({
        ok: false,
        error: r.state === 'input-required'
          ? r.error
          : `A2A 调用 ${agent.name} 失败${r.error ? `：${r.error}` : ''}`,
        state: r.state || null,
        task_id: r.taskId || null,
        timed_out: r.timed_out || false,
        ...agentDocsHint(agent),
      })
    }
    return toolJson({
      ok: true,
      agent_id,
      agent_name: agent.name,
      channel: 'a2a',
      task_id: r.taskId,
      state: r.state,
      reply: String(r.text || '').slice(0, 4000),
    })
  }

  if (agent.invoke_type === 'cli') {
    const safePrompt = fullPrompt.replace(/"/g, '\\"').replace(/\n/g, ' ')
    const cmdArgs = (agent.invokeArgs || []).map(a => a === '{prompt}' ? `"${safePrompt}"` : a).join(' ')
    const cmd = `${agent.invoke_cmd} ${cmdArgs}`
    const result = await execCommand({ command: cmd, timeout: timeoutSec, background: false }, {})
    // CLI 调用失败时注入文档引导
    try {
      const parsed = typeof result === 'string' ? JSON.parse(result) : result
      if (parsed?.ok === false || (parsed?.exit_code !== undefined && parsed.exit_code !== 0)) {
        return toolJson({ ...parsed, ...agentDocsHint(agent) })
      }
    } catch { /* result 不是 JSON，直接返回 */ }
    return result
  }

  if (agent.invoke_type === 'http') {
    const base = agent.invoke_cmd.replace(/\/$/, '')
    // Ollama API（端口 11434）有专属格式，需要带 model 字段
    const isOllama = base.includes(':11434')
    const ollamaModel = agent.notes?.match(/ollama[^)]*\(([^)]+)\)/i)?.[1]
      || agent.id   // 用 agent id 作为 model 名的兜底

    const endpoints = isOllama
      ? [{ path: '/api/chat', body: { model: ollamaModel, messages: [{ role: 'user', content: fullPrompt }], stream: false } },
         { path: '/api/generate', body: { model: ollamaModel, prompt: fullPrompt, stream: false } }]
      : [{ path: '/api/chat', body: { message: fullPrompt, messages: [{ role: 'user', content: fullPrompt }] } },
         { path: '/v1/chat/completions', body: { messages: [{ role: 'user', content: fullPrompt }] } },
         { path: '/chat', body: { message: fullPrompt } },
         { path: '/query', body: { query: fullPrompt } }]

    for (const ep of endpoints) {
      try {
        const res = await fetch(`${base}${ep.path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(ep.body),
          signal: AbortSignal.timeout(timeoutSec * 1000),
        })
        if (res.ok) {
          const data = await res.json()
          const reply = data?.message?.content || data?.response || data?.message
            || data?.content || data?.choices?.[0]?.message?.content || JSON.stringify(data)
          return toolJson({ ok: true, agent_id, agent_name: agent.name, reply: String(reply).slice(0, 4000) })
        }
      } catch { /* 尝试下一个端点 */ }
    }
    return toolJson({
      ok: false,
      error: `无法连接到 ${agent.name}（${base}），所有端点均不响应。`,
      ...agentDocsHint(agent),
    })
  }

  return toolJson({ ok: false, error: `不支持的调用类型：${agent.invoke_type}` })
}

function execGrantAgentDelegation({ allowed, note = '' }) {
  try {
    dbSetConfig('agent_delegation_asked', 'true')
    dbSetConfig('agent_delegation_allowed', allowed ? 'true' : 'false')
  } catch (e) {
    console.error('[Agents] grant_agent_delegation 写入失败：', e.message)
    return toolJson({ ok: false, error: e.message })
  }
  const msg = allowed
    ? `已记录授权：Bailongma 可以指挥本地 AI 小伙伴工作。`
    : `已记录：用户暂不授权 Agent 委托功能。`
  return toolJson({ ok: true, allowed: !!allowed, note: String(note || ''), message: msg })
}

function normalizeSelfCheckResults(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const normalized = {}
  for (const [key, item] of Object.entries(value)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      normalized[key] = { status: String(item || 'unknown') }
      continue
    }
    normalized[key] = {
      status: String(item.status || item.state || 'unknown').slice(0, 40),
      detail: String(item.detail || item.message || '').slice(0, 500),
    }
  }
  return normalized
}

function execCompleteStartupSelfCheck({ summary = '', results = {} } = {}, context = {}) {
  if (!context?.startupSelfCheck?.active || !context?.onCompleteStartupSelfCheck) {
    return toolJson({
      ok: false,
      tool: 'complete_startup_self_check',
      error: 'startup self-check is not active',
    })
  }

  const cleanResults = normalizeSelfCheckResults(results)
  const completed = context.onCompleteStartupSelfCheck({
    summary: String(summary || '').slice(0, 1000),
    results: cleanResults,
  })
  return toolJson({
    ok: true,
    tool: 'complete_startup_self_check',
    version: completed.version,
    status: completed.status,
    completed_at: completed.completed_at,
    results: cleanResults,
  })
}
