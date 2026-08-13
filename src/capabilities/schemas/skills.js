// Skill 管理工具 schema：list_skills / view_skill / learn_skill / improve_skill / delete_skill
// 对应 hermes-agent 的 skills_list / skill_view / skill_manage + /learn，是「学习闭环」的工具面：
//   - 按需浏览（list/view），不再只靠消息关键词命中后被动注入；
//   - learn_skill 把"刚刚做过的工作流 / 文档 / 目录"沉淀成 SKILL.md（从经验里学）；
//   - improve_skill 把一次使用中的踩坑/改进写回技能（技能在使用中自我改进）。

export const skillsSchemas = {
  list_skills: {
    type: 'function',
    function: {
      name: 'list_skills',
      description: 'List installed Agent Skills (SKILL.md packages) with name, description, usage count and activity state (active/stale/archived). Use when the user asks what skills/capabilities are installed, or before deciding whether a skill exists for a job. Optional query filters by keyword.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional keyword to filter by name/tag/description.' },
          include_archived: { type: 'boolean', description: 'Include archived (long-unused) skills in the list. Default false.' },
        },
      },
    },
  },
  view_skill: {
    type: 'function',
    function: {
      name: 'view_skill',
      description: 'View the full SKILL.md instructions of an installed skill. Use when a listed skill matches the task and you need its exact procedure/rules before acting. Pass the skill id (from list_skills) or name/alias. Records a usage event for the skill.',
      parameters: {
        type: 'object',
        properties: {
          skill: { type: 'string', description: 'Skill id, name, or alias (from list_skills).' },
        },
        required: ['skill'],
      },
    },
  },
  learn_skill: {
    type: 'function',
    function: {
      name: 'learn_skill',
      description: 'Turn experience into a reusable Agent Skill (SKILL.md). Use when the user just walked you through a workflow ("learn this"), points at a doc/directory/repo, or asks you to remember how to do something reusable. The runtime will instruct you to gather the described sources with your existing tools and author a SKILL.md under sandbox/skills/<name>/ following the Bailongma skill-authoring standards. After authoring, verify it is discoverable via list_skills.',
      parameters: {
        type: 'object',
        properties: {
          what: { type: 'string', description: 'What to learn: a workflow from this conversation, a directory/repo path, an API/doc URL, pasted notes, or "what I just did". Free-form description is fine.' },
          name: { type: 'string', description: 'Optional skill name (lowercase-hyphenated, <=64 chars). If omitted, derive from the workflow.' },
        },
        required: ['what'],
      },
    },
  },
  improve_skill: {
    type: 'function',
    function: {
      name: 'improve_skill',
      description: 'Record a lesson learned while using a skill, so the skill improves itself over time. Call after you used a skill and hit a pitfall, discovered a better step, or the user corrected you — append the concrete lesson (what to avoid / what to do instead) to the skill. The note is appended as a dated entry in the skill\'s SKILL.md "## Lessons Learned" section.',
      parameters: {
        type: 'object',
        properties: {
          skill: { type: 'string', description: 'Skill id, name, or alias the lesson applies to (from list_skills).' },
          lesson: { type: 'string', description: 'One concrete, actionable lesson: the pitfall/context and the better approach. 1-3 sentences.' },
        },
        required: ['skill', 'lesson'],
      },
    },
  },
  delete_skill: {
    type: 'function',
    function: {
      name: 'delete_skill',
      description: 'Delete an installed skill package (removes its folder and usage telemetry). Only for skills the user explicitly asks to remove — never delete bundled skills. Prefer improve_skill for fixing a flawed skill instead of deleting it.',
      parameters: {
        type: 'object',
        properties: {
          skill: { type: 'string', description: 'Skill id, name, or alias to delete.' },
        },
        required: ['skill'],
      },
    },
  },
}

