// schemas/hitl.js —— HITL 审批工具 schema（P1）
export const hitlSchemas = {
  hitl_request: {
    type: 'function',
    function: {
      name: 'hitl_request',
      description: '请求用户审批（Human-in-the-loop）。在执行危险操作、重要决策或需要人工确认的步骤前调用。调用后会暂停当前流程，等待用户在 UI/API 中批准或拒绝，超时自动过期。适合"删除文件前确认"、"发送消息前确认"、"执行命令前确认"等场景。',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: '审批标题（简短描述要审批什么）',
          },
          description: {
            type: 'string',
            description: '详细说明（操作内容、影响范围、风险等）',
          },
          risk_level: {
            type: 'string',
            description: '风险等级',
            enum: ['low', 'medium', 'high'],
          },
          timeout_ms: {
            type: 'number',
            description: '超时毫秒数（默认 86400000 = 24小时）',
          },
          context: {
            type: 'object',
            description: '附加上下文数据（如要删除的文件路径、要执行的命令等）',
          },
        },
        required: ['title'],
      },
    },
  },

  hitl_list: {
    type: 'function',
    function: {
      name: 'hitl_list',
      description: '列出审批请求（待审批/已通过/已拒绝/已过期）。适合"有哪些待我审批的"、"之前的审批结果是什么"等查询。',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            description: '按状态筛选（默认全部）',
            enum: ['pending', 'approved', 'rejected', 'expired'],
          },
          limit: { type: 'number', description: '返回数量（默认 50）' },
          offset: { type: 'number', description: '分页偏移（默认 0）' },
        },
      },
    },
  },
}
