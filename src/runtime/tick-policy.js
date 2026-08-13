// Tick policy deliberately separates semantic judgment from runtime authority.
//
// The model decides whether a heartbeat is worth acting on. Runtime code still
// owns permissions, target allowlists, sandboxing, budgets, interruption, and
// tool validation; those are execution invariants rather than behavioral
// choices.

export function buildAutonomousTickDirections({
  startupSelfCheckActive = false,
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
