// 长期目标工具 schema：set_goal / list_goals / update_goal
export const goalsSchemas = {
  set_goal: {
    type: 'function',
    function: {
      name: 'set_goal',
      description: 'Create a long-term goal. Use when the user states an ongoing objective that spans days/weeks (e.g. "learn Python", "finish the product doc", "keep my notes organized"). The system tracks it, surfaces it in the daily briefing, and reminds you to advance it. Do NOT use for one-off tasks — that is set_task.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short goal title, e.g. "学会 Python 基础".' },
          description: { type: 'string', description: 'Optional longer description / acceptance criteria.' },
          priority: { type: 'integer', minimum: 1, maximum: 5, description: 'Importance 1-5, default 3.' },
          due_at: { type: 'string', description: 'Optional ISO 8601 due time.' },
        },
        required: ['title'],
      },
    },
  },
  list_goals: {
    type: 'function',
    function: {
      name: 'list_goals',
      description: 'List tracked goals, optionally filtered by status (active/paused/done/abandoned). Use before updating progress or when the user asks "what goals do I have".',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['active', 'paused', 'done', 'abandoned'], description: 'Filter by status; omit for all.' },
        },
      },
    },
  },
  update_goal: {
    type: 'function',
    function: {
      name: 'update_goal',
      description: 'Update a goal: title, description, priority, progress (0-100), status, due_at, or result_note. Call when the user makes progress on a goal, marks it done, pauses it, or abandons it. For marking done you may set status=done (progress becomes 100).',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'Goal id (from list_goals).' },
          title: { type: 'string' },
          description: { type: 'string' },
          priority: { type: 'integer', minimum: 1, maximum: 5 },
          progress: { type: 'integer', minimum: 0, maximum: 100, description: 'Completion percent 0-100.' },
          status: { type: 'string', enum: ['active', 'paused', 'done', 'abandoned'] },
          due_at: { type: 'string' },
          result_note: { type: 'string', description: 'Short note on progress/results.' },
        },
        required: ['id'],
      },
    },
  },
  show_briefing: {
    type: 'function',
    function: {
      name: 'show_briefing',
      description: 'Show the daily briefing card. Call when the user asks to see the morning/daily briefing, e.g. "晨间简报", "今日简报", "早上好有什么消息", "today briefing". If today\'s briefing does not exist yet it is generated on the fly (requires working LLM).',
      parameters: {
        type: 'object',
        properties: {
          force: { type: 'boolean', description: 'Set true to regenerate the briefing even if one already exists today.' },
        },
      },
    },
  },
}
