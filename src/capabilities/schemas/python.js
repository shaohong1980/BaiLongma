// schemas/python.js —— Python 代码沙箱工具 schema（P0）
export const pythonSchemas = {
  run_python: {
    type: 'function',
    function: {
      name: 'run_python',
      description: '在隔离沙箱中执行 Python 代码，返回 stdout/stderr/exit_code 和生成的图表。自动配置 matplotlib Agg 后端，plt.show() 会自动保存为 PNG。适合数据分析、统计计算、绘图、数据清洗、算法验证等场景。工作目录在沙箱内，可读写 sandbox/python/<session>/ 下的文件。',
      parameters: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: '要执行的 Python 代码（完整脚本，支持多行）',
          },
          timeout_ms: {
            type: 'number',
            description: '超时毫秒数（默认 30000，上限 120000）',
          },
        },
        required: ['code'],
      },
    },
  },

  python_packages: {
    type: 'function',
    function: {
      name: 'python_packages',
      description: '查看当前 Python 环境已安装的包（重点列出 numpy/pandas/matplotlib/scipy/sklearn 等数据科学库）。执行 run_python 前先调这个确认依赖是否可用。',
      parameters: { type: 'object', properties: {} },
    },
  },
}
