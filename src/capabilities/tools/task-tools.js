// task-tools.js —— 任务/步骤/审视/专注横幅 的执行函数（从 src/capabilities/executor.js 拆出）
// execSetTask / execCompleteTask / execUpdateTaskStep / execReviewVerdict / execReviewWork / execFocusBanner
// 这些函数只依赖 context 回调 + 少数共享模块（delivery-verify / reflection / reviewer），
// 与 executor 的 dispatch 解耦，可独立维护。
import { getRecentActionLogs } from '../../db.js'
import { recordReflection, buildReflectionFromFailure } from '../../memory/reflection.js'
import { deliveryVerifyNoticeFromLogs } from '../../runtime/delivery-verify.js'
import { runWorkReview } from '../../review/reviewer.js'

function toolJson(payload) {
  return JSON.stringify(payload, null, 2)
}

export function execSetTask({ description, steps = [] }, context) {
  if (!description?.trim()) return '错误：未提供任务描述'
  if (!Array.isArray(steps) || steps.length === 0) return '错误：steps 不能为空，请提供具体执行步骤'
  if (!context?.onSetTask) return '错误：任务管理回调未注册'
  const cleanSteps = steps.map(s => String(s).trim()).filter(Boolean)
  if (cleanSteps.length === 0) return '错误：steps 不能全为空，请提供具体执行步骤'
  context.onSetTask(description.trim(), cleanSteps)

  // 计划器软校验（P3：对齐 Plan-and-Execute 的计划合理性引导，只提示不拦截）
  const hints = []
  if (cleanSteps.length > 10) {
    hints.push('步骤过多（>10），建议合并成更粗的里程碑（每步一个可验证交付），避免执行时频繁记账')
  }
  if (cleanSteps.length < 3) {
    hints.push('步骤较少——若任务确实复杂建议拆细到可独立验证的子步；若确实简单可继续')
  }
  // 产出类任务缺验证步骤：宽松启发式（写/创建/生成 类动词 + 无 验证/读回/运行 类步骤）
  const hasProduce = cleanSteps.some(s => /(写|创建|生成|建|制作|产|生成文件)/.test(s))
  const hasVerify = cleanSteps.some(s => /(验证|测试|检查|读回|确认|运行|跑|curl|测试运行)/.test(s))
  if (hasProduce && !hasVerify && cleanSteps.length >= 2) {
    hints.push('任务涉及产出（写/创建/生成），建议补一步验证（读回/运行/检查）——别做完就宣称成功')
  }

  // P2 任务级授权引导：步骤含执行类动词时，明确"任务内执行命令"的边界（仍受沙箱限制）
  const hasExec = cleanSteps.some(s => /(运行|执行|启动|跑|安装|启动服务|命令|脚本|测试运行|起服务)/.test(s))
  if (hasExec) {
    hints.push('任务含命令执行步骤——本任务内可运行命令，但仍在执行沙箱范围内；涉及系统级变更前应向用户确认')
  }

  const base = `任务已开启：${description}\n步骤（${cleanSteps.length} 个）：\n${cleanSteps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}\n\n计划已记录。现在开始第 1 步「${cleanSteps[0]}」的 执行→观察→判断 微循环；每步一出结果就调 update_task_step 落状态，note 写一句关键结论。`
  return hints.length ? `${base}\n\n${hints.map(h => '⚠ ' + h).join('\n')}` : base
}

// 收尾软门（P2：统一到 src/runtime/delivery-verify.js）：complete_task 照常执行
// （不拦截——第一原则），但 runtime 查一眼 action_log——任务期间产出过文件/执行过命令、
// 却没有任何验证类动作（fetch_url / browser_read / review_work / 读回）时，把证据附在返回值里。
function unverifiedDeliveryNotice() {
  try {
    return deliveryVerifyNoticeFromLogs(getRecentActionLogs(40) || [])
  } catch {
    return ''
  }
}

export function execCompleteTask({ summary = '' }, context) {
  if (!context?.onCompleteTask) return '错误：任务管理回调未注册'
  // Reflexion：任务完成时有失败步骤 → 沉淀反思（下次同类任务经记忆召回自动带上教训）
  try {
    const ts = typeof context.getTaskState === 'function' ? context.getTaskState() : null
    const failedSteps = (ts?.steps || []).filter(s => s && s.status === 'failed')
    if (failedSteps.length > 0) {
      const reasons = failedSteps.map(s => String(s.text || '').slice(0, 80)).filter(Boolean).join('; ')
      recordReflection({
        content: buildReflectionFromFailure({
          task: String(ts?.task || ''),
          reason: `任务部分步骤失败${reasons ? '：' + reasons : ''}`,
          lesson: '失败步骤应如实向用户说明缺口，不要声称全部完成',
        }),
        task: String(ts?.task || ''),
        tags: ['task_failed'],
      })
    }
  } catch (e) { console.warn('[src/capabilities/executor.js] op failed:', e?.message || e) }
  const suggestion = context.onCompleteTask(String(summary || '').trim()) || ''
  const lines = [`任务已完成${summary ? '：' + summary : ''}`]
  if (suggestion) lines.push(suggestion)
  const notice = unverifiedDeliveryNotice()
  if (notice) lines.push(notice)
  return lines.join('\n')
}

export function execUpdateTaskStep({ step_index, status, note = '' }, context) {
  if (step_index === undefined || step_index === null) return '错误：未提供步骤编号'
  const idx = Number(step_index)
  if (!Number.isInteger(idx) || idx < 0) return '错误：步骤编号必须为非负整数'
  if (!['done', 'failed', 'skipped'].includes(status)) return '错误：status 必须为 done/failed/skipped'
  if (!context?.onUpdateTaskStep) return '错误：任务管理回调未注册'
  const result = context.onUpdateTaskStep(idx, status, String(note || '').trim())
  if (result?.error) return `错误：${result.error}`
  const statusLabel = { done: '完成 ✓', failed: '失败 ✗', skipped: '跳过 —' }[status]
  const lines = [`步骤 ${idx + 1} 已标记为${statusLabel}${note ? '：' + note : ''}`]
  if (result?.progress) lines.push(`进度：${result.progress}`)
  // 引导下一个 ReAct 微循环：按状态把模型推向"收尾验证 / 换法重试 / 进入下一步"。
  // 这是 prompt 之外的第二道引导——不拦截、不扣工具，只用返回值给方向（符合不加硬性限制）。
  if (result?.allTerminal) {
    lines.push(result.anyFailed
      ? '所有步骤已到终态，但任务仍保持活动。请自行判断失败/跳过是否影响总目标：可以补救、重规划、向用户说明缺口，或在你确认任务应当结束时显式调用 complete_task。'
      : '所有步骤已到终态，但任务仍保持活动。请核对总体目标和每步证据；只有在你判断目标确实达成后，才显式调用 complete_task 收尾。')
  } else if (status === 'failed') {
    lines.push(result?.nextStep
      ? `这一步失败了：不要重试同样的做法——换工具或换思路再试一次；若是缺信息，在 note 里写清缺什么并直接问用户。处理完这步后，下一步是「${result.nextStep}」。`
      : '这一步失败了：不要重试同样的做法——换工具或换思路再试一次；若是缺信息，在 note 里写清缺什么并直接问用户。')
  } else if (result?.nextStep) {
    lines.push(`继续下一步（第 ${result.nextIndex + 1} 步）：「${result.nextStep}」——进入它自己的 执行→观察→判断 微循环。`)
  }
  return lines.join('\n')
}

// review_verdict 只在审视分身那次独立 callLLM 里被调，结论的真正捕获走 reviewer.js 的 onToolCall。
// 这里只给一个无副作用的确认返回值，让审视分身那轮工具循环正常收尾。
export function execReviewVerdict(args = {}) {
  return toolJson({ ok: true, received: true, pass: args?.pass !== false })
}

// review_work：主 Agent 把成果交给审视分身复查。
// goal/claim 由主 Agent 给；turnToolLog/taskState 由 runtime 从本轮证据注入（主 Agent 够不到、
// 改不了——这是审视独立性的承重墙）。结论以软引导形式作为工具返回值丢回，不拦截、不扣工具、
// 不挡 complete_task（第一原则：不加硬性限制）。
export async function execReviewWork({ goal, claim, artifacts = [] }, context = {}) {
  if (!goal || !String(goal).trim()) return toolJson({ ok: false, error: 'goal 不能为空：请写清楚这件事原本要达成什么' })
  if (!claim || !String(claim).trim()) return toolJson({ ok: false, error: 'claim 不能为空：请写清楚你认为自己做成了什么' })

  const turnToolLog = Array.isArray(context.turnToolLog) ? context.turnToolLog : []
  const taskState = typeof context.getTaskState === 'function' ? context.getTaskState() : null
  // 触发本轮的用户原话——runtime 注入的 ground truth，主 Agent 改不了。给审视分身对照"它写的 goal
  // 是不是把用户诉求裁窄/跑偏了"。多步任务里这里可能是 TICK，无妨：审视分身另有 taskState 作锚点。
  const triggeringMessage = String(context.currentUserMessage || '')
  const traceId = `rv${Date.now().toString(36).slice(-5)}`

  // 调试：主 Agent 这一侧——它确实调起了 review_work，且 runtime 取到了多少证据。
  // 若这条没出现，说明模型压根没调审视；若 turn_calls=0，说明证据注入承重墙没接上（排查 index.js turnToolLog）。
  console.log(`[审视分身#${traceId}] ◆ 主Agent调起 review_work | 注入证据：${turnToolLog.length} 条工具日志 / ${taskState?.task ? '有' : '无'}任务计划 / ${triggeringMessage ? '有' : '无'}用户原话`)

  const verdict = await runWorkReview({
    goal: String(goal),
    claim: String(claim),
    artifacts: Array.isArray(artifacts) ? artifacts : [],
    turnToolLog,
    taskState,
    triggeringMessage,
    traceId,
    signal: context.signal,
  })

  const guidance = verdict.pass
    ? '审视通过。这是独立的第二双眼睛核对过的结果——可以收尾/交付了。'
    : '审视发现了问题（见 issues）。这是第二双眼睛的意见，不是命令：先核实属实的项并修掉 blocker/major，修完可以再调一次 review_work 让它复查，或直接收尾；若你不认同某条，向用户说明理由后照常推进，不要默默忽略也不要被它卡死。'

  console.log(`[审视分身#${traceId}] ◆ 回传主Agent | pass=${verdict.pass} | issues=${verdict.issues.length}${verdict.inconclusive ? ' | inconclusive(兜底放行)' : ''}`)

  return toolJson({
    ok: true,
    trace_id: traceId,
    pass: verdict.pass,
    issues: verdict.issues,
    summary: verdict.summary,
    inconclusive: verdict.inconclusive || undefined,
    evidence_seen: { tool_calls: turnToolLog.length, has_task_plan: !!(taskState && taskState.task), saw_user_message: !!triggeringMessage },
    guidance,
  })
}

export function execFocusBanner({ action, task = '', current_step = '', tasks = [] }) {
  if (!['show', 'update', 'hide'].includes(action)) {
    return toolJson({ ok: false, error: 'action 必须是 show / update / hide' })
  }
  const bridge = global.focusBannerBridge
  if (!bridge) {
    return toolJson({ ok: false, error: '桌面功能不可用（非 Electron 环境）' })
  }
  if (action === 'hide') {
    bridge.emit('hide')
    return toolJson({ ok: true, action: 'hide', message: '专注横幅已关闭' })
  }
  const cleanTasks = Array.isArray(tasks)
    ? tasks.map(t => ({ text: String(t.text || ''), done: !!t.done }))
    : []
  bridge.emit('command', { action, task: String(task), current_step: String(current_step), tasks: cleanTasks })
  return toolJson({ ok: true, action, task, current_step, tasks: cleanTasks })
}

