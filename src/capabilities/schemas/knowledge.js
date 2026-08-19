// schemas/knowledge.js —— 知识库工具 schema（P0: RAG）
//
// 工具：
//   knowledge_ingest  : 导入文档（文件路径或纯文本）
//   knowledge_search  : 混合检索（FTS5 + 向量）
//   knowledge_list    : 列出已导入文档
//   knowledge_delete  : 删除文档
//   knowledge_stats   : 知识库统计

export const knowledgeSchemas = {
  knowledge_ingest: {
    type: 'function',
    function: {
      name: 'knowledge_ingest',
      description: '将文档导入本地知识库（RAG）。支持文件路径（自动解析 txt/md/json/csv/docx/xlsx/pptx/pdf）或直接粘贴文本。导入后自动分块、建索引、计算向量，可用 knowledge_search 检索。适合"把这份资料存下来以后问"或"建立一个专题知识库"。',
      parameters: {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            description: '文档来源：沙箱内文件路径（如 notes/report.pdf），或直接粘贴的文本内容（配合 source_type=text）',
          },
          source_type: {
            type: 'string',
            description: '来源类型：file（文件路径，默认）或 text（直接粘贴的文本）',
            enum: ['file', 'text'],
          },
          name: {
            type: 'string',
            description: '文档名称（source_type=text 时必填；file 时默认取文件名）',
          },
          format: {
            type: 'string',
            description: '文本格式（source_type=text 时指定，默认 text）',
            enum: ['text', 'markdown', 'csv', 'json'],
          },
          chunk_size: {
            type: 'number',
            description: '分块大小（字符数，默认 500）',
          },
        },
        required: ['source'],
      },
    },
  },

  knowledge_search: {
    type: 'function',
    function: {
      name: 'knowledge_search',
      description: '在本地知识库中检索相关内容（混合检索：全文 FTS5 + 向量语义相似度）。返回最相关的分块文本及来源文档。适合"查一下之前导入的资料里关于 X 的内容"或"基于知识库回答问题"。检索结果应作为回答的依据，标注来源。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '检索查询（关键词或自然语言问题）',
          },
          limit: {
            type: 'number',
            description: '返回结果数（默认 8，上限 20）',
          },
          doc_id: {
            type: 'string',
            description: '限定在某个文档内检索（可选，默认全库）',
          },
        },
        required: ['query'],
      },
    },
  },

  knowledge_list: {
    type: 'function',
    function: {
      name: 'knowledge_list',
      description: '列出知识库中已导入的文档（名称、格式、分块数、大小、导入时间）。适合"我库里有哪些资料"或"看看某个文档在不在"。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '返回数量（默认 50）' },
          offset: { type: 'number', description: '分页偏移（默认 0）' },
        },
      },
    },
  },

  knowledge_delete: {
    type: 'function',
    function: {
      name: 'knowledge_delete',
      description: '从知识库删除一个文档（及其所有分块和索引）。适合"这份资料不要了"或"清理旧版本"。删除不可恢复，请确认。',
      parameters: {
        type: 'object',
        properties: {
          doc_id: { type: 'string', description: '要删除的文档 ID（从 knowledge_list 获取）' },
        },
        required: ['doc_id'],
      },
    },
  },

  knowledge_stats: {
    type: 'function',
    function: {
      name: 'knowledge_stats',
      description: '查看知识库统计：文档数、分块总数、向量索引覆盖率、总字符数。适合"知识库现在多大了"或"检查向量索引是否建完"。',
      parameters: { type: 'object', properties: {} },
    },
  },
}
