// documents.js —— 文档/审批工具 schema（多模态文档 + 通用审批确认流）
export const documentSchemas = {
  backup_data: {
    type: 'function',
    function: {
      name: 'backup_data',
      description: '备份本地数据（SQLite 一致性快照 + 配置 + 沙箱工作文件）到沙箱 backups 目录。强调"数据在你机器上、你能带走"——备份后可整体拷贝/压缩迁移。适合用户要求"备份/导出数据"或周期性数据安全。',
      parameters: {
        type: 'object',
        properties: {
          target_dir: { type: 'string', description: '备份存放子目录（默认 backups，在沙箱内）' },
        },
      },
    },
  },
  request_approval: {
    type: 'function',
    function: {
      name: 'request_approval',
      description: '对高风险/大规模/不可逆操作（删除大量文件、外部发信、安装软件、系统级变更等）请求用户显式批准。弹出确认卡片，用户批准后才可继续。适合"这个操作影响面大，需要用户点头"的场景；普通操作不要用（会打断流程）。结果经 silent APP_SIGNAL 通知（approved=true/false），批准前不要执行。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '要向用户说明的内容（做什么、为什么需要确认、影响是什么）' },
          action: { type: 'string', description: '待批准的操作描述（简短，供结果通知使用）' },
        },
        required: ['prompt'],
      },
    },
  },
  read_document: {
    type: 'function',
    function: {
      name: 'read_document',
      description: '读取并理解沙箱内的文档。支持：txt/md/json/csv/log 及常见代码/配置文本——CSV 自动解析为表格（行数/列头/预览），JSON 校验格式。二进制办公格式（pdf/docx/xlsx/pptx）会提示走对应技能包。适合"读这份文档/表格/清单给我"的请求；普通代码/配置文件用 read_file 更精细。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '沙箱内文件路径（相对或绝对，须在 sandbox 内）' },
          max_chars: { type: 'number', description: '文本格式返回的最大字符数（默认 30000）' },
          max_bytes: { type: 'number', description: '允许读取的最大字节数（默认 200000，上限 500000）' },
        },
        required: ['path'],
      },
    },
  },
}
