// skill-suggest.js —— 复杂任务完成后提示沉淀技能（hermes 自主学习闭环的本地版）
//
// Hermes 会在复杂任务跑完后把流程蒸馏成可复用技能。这里做同样的事，但更轻：
// 不自动创建（避免打扰），只在「多步骤任务」完成时给模型一句软引导——
// 模型觉得这套流程可复用，就调 learn_skill 存成 SKILL.md；否则忽略。
//
// 复杂度判定：计划步骤数 ≥ COMPLEX_TASK_MIN_STEPS 就算多步骤（3 步以上通常意味着
// 有可复用的流程/动作序列，而不是一句话问答）。

export const COMPLEX_TASK_MIN_STEPS = 3

export function isComplexTask(stepCount) {
  return Number.isInteger(stepCount) && stepCount >= COMPLEX_TASK_MIN_STEPS
}

// 构造给模型的软引导；非复杂任务返回空串（调用方直接不注入）。
export function buildSkillSuggestion(taskDesc, stepCount) {
  if (!isComplexTask(stepCount)) return ''
  const desc = String(taskDesc || '').trim().slice(0, 40)
  const title = desc ? `「${desc}」` : ''
  return `（提示：这是一个 ${stepCount} 步的多步骤任务${title}。如果这套流程以后可能还会用到，可以用 learn_skill 把刚才的步骤沉淀成可复用的技能——它会引导你采集源并写好 SKILL.md；用不上就忽略本条。）`
}

