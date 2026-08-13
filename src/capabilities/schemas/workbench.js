// 工作台（Workbench）工具 schema：manage_todo / weekly_review
// 让 Agent 可以用对话方式操作待办事项、完成事项与每周复盘。
export const workbenchSchemas = {
  manage_todo: {
    type: 'function',
    function: {
      name: 'manage_todo',
      description: 'Manage your workbench todo list. Add a todo when the user asks to remember/track a task ("帮我记一下…"), mark a todo done when it is completed, update or delete items, and list current todos. Completed todos are kept as history in the 完成事项 (completed) list. Use this for day-to-day to-dos and task tracking; use set_task for multi-step in-progress tasks, and set_goal for long-term goals.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['add', 'complete', 'update', 'delete', 'list'],
            description: 'add creates a todo; complete marks an existing todo done (moves it to the completed list); update edits title/detail/priority/status/tags; delete removes it entirely; list shows todos (optionally filtered by status).'
          },
          id: {
            type: 'integer',
            description: 'For complete/update/delete: the todo id from list.'
          },
          title: {
            type: 'string',
            description: 'For add / update: the todo title (concise task name).'
          },
          detail: {
            type: 'string',
            description: 'For add / update: optional detail or notes about the todo.'
          },
          priority: {
            type: 'integer',
            minimum: 1,
            maximum: 5,
            description: 'For add / update: priority 1-5, default 3 (higher = more important).'
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'For add / update: optional tags such as ["工作", "urgent"].'
          },
          status: {
            type: 'string',
            enum: ['pending', 'done'],
            description: 'For update: switch status directly. done moves it to the completed list.'
          }
        },
        required: ['action']
      }
    }
  },

  weekly_review: {
    type: 'function',
    function: {
      name: 'weekly_review',
      description: 'Manage weekly reviews on the workbench. Write a weekly review to summarize the week (what was done, insights, next week plan), show the current or a specified week\'s review, or list past reviews. The current ISO week key is auto-computed when not given.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['write', 'show', 'list'],
            description: 'write saves/updates a weekly review; show displays a week\'s review (defaults to the current week); list shows recent weekly reviews.'
          },
          week_key: {
            type: 'string',
            description: 'ISO week key like "2026-W33". For write/show; defaults to the current week.'
          },
          content: {
            type: 'string',
            description: 'For write: the weekly review body (accomplishments, insights, next-week plan).'
          },
          mood: {
            type: 'string',
            description: 'For write: optional one-line mood / overall feeling for the week.'
          }
        },
        required: ['action']
      }
    }
  }
}
