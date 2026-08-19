// schemas/workflow.js —— 工作流工具 schema（P1）
export const workflowSchemas = {
  propose_workflow: {
    type: 'function',
    function: {
      name: 'propose_workflow',
      description: '根据一句自然语言需求，自主设计一个多步骤工作流并生成提案（Human-in-the-loop）。设计会经过校验，成功后推送到「工作流编辑器」供用户审阅，用户接受后才保存/运行。适合"帮我把 XXX 自动化"、"设计一个 XX 流程"这类请求。',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '工作流名称（简短，如"日报自动生成"）',
          },
          task: {
            type: 'string',
            description: '用一句话描述要自动化的事情（这是设计工作流的输入）',
          },
          description: {
            type: 'string',
            description: '补充说明（可选）：输入输出、特殊要求、约束等',
          },
        },
        required: ['name', 'task'],
      },
    },
  },

  workflow_run: {
    type: 'function',
    function: {
      name: 'workflow_run',
      description: '运行一个工作流（Workflow）。工作流是预定义的多步骤执行流程，支持 LLM 调用、工具调用、条件分支、循环、并行、人工审批等节点。可以用内置模板（research_then_answer / approve_then_execute / data_analysis / simple_qa）或自定义 workflow JSON。',
      parameters: {
        type: 'object',
        properties: {
          template: {
            type: 'string',
            description: '内置模板名称（simple_qa / research_then_answer / approve_then_execute / data_analysis）。与 workflow 二选一。',
            enum: ['simple_qa', 'research_then_answer', 'approve_then_execute', 'data_analysis'],
          },
          workflow_id: {
            type: 'string',
            description: '已保存的工作流 ID（从 workflow_list 获取）。与 template/workflow 二选一。',
          },
          workflow: {
            type: 'object',
            description: '自定义工作流 JSON 定义（包含 nodes 数组）。与 template/workflow_id 二选一。',
          },
          input: {
            type: 'object',
            description: '工作流输入数据（如 { input: "用户问题", code: "python代码" }），节点中用 {{input}} 引用',
          },
        },
      },
    },
  },

  workflow_list: {
    type: 'function',
    function: {
      name: 'workflow_list',
      description: '列出已保存的工作流定义和内置模板。适合"有哪些可用的工作流"、"看看某个工作流的定义"。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '返回数量（默认 50）' },
          include_templates: { type: 'boolean', description: '是否包含内置模板（默认 true）' },
        },
      },
    },
  },

  workflow_save: {
    type: 'function',
    function: {
      name: 'workflow_save',
      description: '保存一个自定义工作流定义到数据库，之后可通过 workflow_id 调用。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '工作流名称' },
          description: { type: 'string', description: '工作流描述' },
          workflow: {
            type: 'object',
            description: '工作流定义（包含 id, name, nodes 数组）',
          },
        },
        required: ['name', 'workflow'],
      },
    },
  },

  workflow_delete: {
    type: 'function',
    function: {
      name: 'workflow_delete',
      description: '删除一个已保存的工作流定义。',
      parameters: {
        type: 'object',
        properties: {
          workflow_id: { type: 'string', description: '要删除的工作流 ID' },
        },
        required: ['workflow_id'],
      },
    },
  },
}
