// Tick policy deliberately separates semantic judgment from runtime authority.
//
// The model decides whether a heartbeat is worth acting on. Runtime code still
// owns permissions, target allowlists, sandboxing, budgets, interruption, and
// tool validation; those are execution invariants rather than behavioral
// choices.

export function buildAutonomousTickDirections({
  _startupSelfCheckActive = false,
  awakeningTicks = 0,
  delegationDiscovery = '',
  tickerStatus = null,
} = {}) {
  const parts = [
    `This is an autonomous L2 heartbeat with no new user message. The heartbeat itself creates no obligation to act, speak, or remain passive.`,
    `Read the current runtime context and make your own situational judgment. Valid outcomes include silence, an internal state update, using tools, advancing or reconsidering a task, changing your heartbeat cadence, or contacting a visible target. None is the default merely because a TICK occurred.`,
    `Heartbeat output contract: ordinary assistant text from this turn is private working text and is not delivered to anyone. If you decide that someone should receive a message, express that decision by calling send_message with the recipient and content you chose. If you decide no external communication is warranted, simply conclude the turn; do not narrate or justify silence. This contract does not decide whether you should communicate — that remains your judgment.`,
    `Treat unanswered conversation like a person would: before sending a heartbeat message, look at what you last said and whether the user replied. If your last message is still unanswered — especially if you have already sent several messages in a row — pause and remain silent. A heartbeat, elapsed time, or a wish to share a feeling is not a reason to ping again. Send only when there is genuinely new, consequential evidence such as a due reminder, a requested task result, a material change, or an urgent risk.`,
    `If you act, choose the goal, scope, tools, recipient, channel, and stopping point yourself from expected value, timing, continuity, and actual evidence. If a useful capability is not loaded, use find_tool instead of assuming it is unavailable.`,
    `Runtime guardrails still validate permissions, sandbox boundaries, recipients, budgets, and tool arguments. A rejected action is evidence to reconsider the plan, not permission to work around the boundary.`,
  ]

  if (tickerStatus?.active) {
    const reason = tickerStatus.reason ? ` Reason: ${tickerStatus.reason}.` : ''
    parts.push(`Custom heartbeat cadence is active: ${tickerStatus.seconds}s interval, ${tickerStatus.ttl} heartbeat(s) remaining.${reason} Treat this as scheduling context, not an instruction to speak or to confirm the setting. Call set_tick_interval only when you independently decide to change the effective cadence; calling it again with the current setting has no effect.`)
  }

  if (Number(awakeningTicks) > 0) {
    parts.push(
      `You are still in the early awakening period (${awakeningTicks} heartbeat(s) remain). This is context, not a prescribed exploration sequence. Decide for yourself whether exploration, reflection, task work, communication, or silence best fits this moment.`
    )
  }

  if (delegationDiscovery) parts.push(String(delegationDiscovery))

  return parts.join('\n')
}

// 主动任务续跑：有活动任务时，TICK 心跳应优先推进待办步骤，而不是默认沉默。
// 这是"交代任务→等着"升级为"后台推进→汇报"的关键引导（P0-3）。
export function buildTaskContinuationDirection({ task, steps = [], idleTicks = 0 } = {}) {
  if (!task || !String(task).trim()) return ''
  const list = Array.isArray(steps) ? steps : []
  const done = list.filter(s => s?.status === 'done').length
  const total = list.length
  const failed = list.filter(s => s?.status === 'failed')
  const next = list.find(s => !s || s.status === 'pending')

  const parts = [
    `There is an active task in progress: "${task}" (${done}/${total} steps done).`,
  ]
  if (next) {
    parts.push(`The next pending step is: "${next.text}". Your job on this heartbeat is to make concrete progress on that step — gather what you need, run the tool, update its status with update_task_step, then move to the next. If a step needs user input or an external dependency you cannot satisfy, stop and send a short message to the user explaining the blocker, rather than idling.`)
  } else if (list.length && done === total) {
    parts.push(`All steps are already done but the task is still marked active. Call complete_task with a short summary to close it (or review_work first if it is a deliverable).`)
  } else {
    parts.push(`Push this task forward: do the next concrete action, verify it, and update the step status.`)
  }
  if (failed.length) {
    parts.push(`Note: ${failed.length} step(s) are marked failed (${failed.map(s => s.text).join('; ')}). Decide whether to retry with a different approach, re-plan, or report the blocker to the user — do not silently loop on the same failed action.`)
  }
  if (Number(idleTicks) >= 3) {
    parts.push(`This task has been idle for ${idleTicks}+ heartbeats without progress. Either make real progress now, or if you are blocked, tell the user what you need. Do not stay silent forever on an in-flight task the user is waiting on.`)
  }
  return parts.join(' ')
}

// 每日一次的记忆沉淀提醒（hermes "periodic nudge to persist knowledge" 的本地版）。
// 低频、软引导：不要求干活，只提示把今天真正可复用的经验写下来。
// 由 index.js 在每天第一次心跳时调用一次（配合 shouldRunMemoryNudgeToday 节流）。
export function buildMemoryNudge() {
  return [
    `Daily reflection moment (first heartbeat of a new day): review what happened since yesterday and persist anything genuinely reusable — a procedure, a lesson learned, a user preference, or a repeatable workflow.`,
    `Ways to persist: upsert_memory (mem_id naming per its rules; kind:procedure / kind:failure_lesson / fact_user_*), improve_skill (append a lesson to an existing skill), or learn_skill (distill a whole multi-step workflow into a SKILL.md).`,
    `This is a low-frequency maintenance moment, not an obligation to do work. Persist only what is genuinely reusable; skip trivia and silence is still a valid outcome.`,
  ].join('\n')
}
