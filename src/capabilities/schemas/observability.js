// schemas/observability.js —— 可观测性工具 schema（P1）
export const observabilitySchemas = {
  cost_stats: {
    type: 'function',
    function: {
      name: 'cost_stats',
      description: '查看 LLM 调用成本与用量统计（按天/按模型/按 provider 聚合）。包含总成本、token 消耗、每日趋势、Top 昂贵调用。适合"这个月花了多少钱"、"哪个模型最费钱"、"今天用了多少 token"等问题。',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number', description: '统计天数（默认 7，上限 365）' },
        },
      },
    },
  },

  trace_list: {
    type: 'function',
    function: {
      name: 'trace_list',
      description: '列出最近的执行追踪（trace），每个 trace 包含多个 span（LLM 调用、工具执行、记忆检索等）。适合"刚才那次调用做了什么"、"有没有报错的 span"、"哪一步最慢"等排查场景。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '返回数量（默认 20，上限 100）' },
          offset: { type: 'number', description: '分页偏移（默认 0）' },
          status: { type: 'string', description: '按状态筛选：ok / error / unset（默认全部）', enum: ['ok', 'error', 'unset'] },
          name: { type: 'string', description: '按 span 名称筛选（如 llm.call / tool.exec）' },
        },
      },
    },
  },

  trace_detail: {
    type: 'function',
    function: {
      name: 'trace_detail',
      description: '查看某个 trace 的完整 span 树（包含每个步骤的耗时、属性、事件）。适合深入排查某次执行的详细流程和瓶颈。',
      parameters: {
        type: 'object',
        properties: {
          trace_id: { type: 'string', description: 'trace ID（从 trace_list 获取）' },
        },
        required: ['trace_id'],
      },
    },
  },

  observability_dashboard: {
    type: 'function',
    function: {
      name: 'observability_dashboard',
      description: '获取综合可观测性仪表盘数据（成本 + trace + 工具使用 + 延迟分位）。一次调用拿到所有监控指标，适合生成状态报告或健康检查。',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number', description: '统计天数（默认 7）' },
        },
      },
    },
  },
}
