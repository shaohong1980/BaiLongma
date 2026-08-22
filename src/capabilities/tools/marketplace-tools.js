// marketplace-tools.js —— 工具市场的执行函数（从 src/capabilities/executor.js 拆出）
// execInstallTool / execUninstallTool / execListTools / execFindTool
import { installTool, uninstallTool, listInstalledTools, getInstalledToolSchema } from '../marketplace/index.js'
import { TOOL_SCHEMAS } from '../schemas.js'
import { TOOL_GROUPS } from '../../memory/tool-router.js'
import { findCapabilitiesByQuery } from '../capability-registry.js'

function toolJson(payload) {
  return JSON.stringify(payload, null, 2)
}

export async function execInstallTool(args) {
  const { name, description, parameters_schema, code, permissions } = args
  return await installTool({ name, description, parameters: parameters_schema, code, permissions })
}

export function execUninstallTool(args) {
  return uninstallTool({ name: args.name })
}

export function execListTools() {
  const builtins = Object.entries(TOOL_SCHEMAS)
    .filter(([name]) => name !== 'express')
    .map(([name, s]) => ({ name, description: s.function.description, source: 'builtin' }))
  const installed = listInstalledTools()
  const all = [...builtins, ...installed]
  const lines = all.map(t => `[${t.source}] ${t.name}: ${t.description}`)
  return `共 ${all.length} 个工具（${builtins.length} 内置 + ${installed.length} 已安装）：\n\n${lines.join('\n')}`
}

// find_tool：按意图搜全量工具目录，返回命中的工具并标注 loaded（由 llm.js 工具循环把它们的 schema
// 当场注入本轮，模型下一步即可直接调用）。匹配两路并集：
//   ① 中文意图——复用 tool-router 的 TOOL_GROUPS 触发词（和按轮注入同一数据源，零漂移）；
//   ② 英文字面——query 词命中工具 name / description。
// 已安装的扩展工具也一并参与英文字面匹配。
export function execFindTool({ query } = {}) {
  const q = String(query || '').toLowerCase().trim()
  if (!q) return toolJson({ ok: false, tool: 'find_tool', error: 'query 不能为空：用一句话描述你需要做什么。' })
  const terms = q.split(/[\s,，、。.；;]+/).map(t => t.trim()).filter(Boolean)

  const matched = new Set()
  // ① 中文意图：命中任一触发词 → 收下该组工具
  for (const group of TOOL_GROUPS) {
    if (group.triggers.some(t => q.includes(String(t).toLowerCase()))) {
      for (const name of group.tools) matched.add(name)
    }
  }
  // ①b 能力发现：query 命中能力（triggers/label/summary）→ 收下其工具，并带回工作流摘要。
  //   这是「自感知按需激活」的发现半：已迁能力（web/hotspot/worldcup/software-install）的
  //   触发词与工具不在 TOOL_GROUPS，靠这里从能力注册表发现；命中时把能力的工作流(context)
  //   摘要一并回给 Agent，让它即便在关键词没进 prompt 的轮次也知道「这套工具该怎么用」。
  const capHits = findCapabilitiesByQuery(q)
  for (const cap of capHits) {
    for (const name of cap.tools) matched.add(name)
  }
  // ② 英文字面：query 任一词出现在工具名或描述里
  const catalog = [
    ...Object.entries(TOOL_SCHEMAS)
      .filter(([name]) => name !== 'express')
      .map(([name, s]) => ({ name, description: s.function?.description || '' })),
    ...listInstalledTools().map(t => ({ name: t.name, description: t.description || '' })),
  ]
  for (const { name, description } of catalog) {
    const hay = `${name} ${description}`.toLowerCase()
    if (terms.some(t => t.length >= 2 && hay.includes(t))) matched.add(name)
  }

  // 能力工作流摘要：命中的能力把 context 压成一句话回给 Agent（自感知按需激活的「怎么用」半）。
  const capabilities = capHits.map(cap => ({
    id: cap.id,
    label: cap.label,
    summary: cap.summary,
    workflow: cap.context ? String(cap.context).replace(/\s+/g, ' ').trim().slice(0, 280) : '',
  }))

  // 不把已是 CORE 的工具当"新发现"返回（模型本来就有），减少噪声。
  const ALWAYS_PRESENT = new Set(['find_tool', 'recall_memory', 'ui_set'])
  const found = [...matched].filter(name => !ALWAYS_PRESENT.has(name))

  if (found.length === 0) {
    return toolJson({
      ok: true, tool: 'find_tool', query, loaded: [], matches: [],
      capabilities,
      note: '没找到匹配的工具。换个说法再试，或直接告诉用户这件事现在做不了。可调 list_tools 看全部工具。',
    })
  }

  const describe = (name) => {
    const s = TOOL_SCHEMAS[name] || getInstalledToolSchema(name)
    const desc = s?.function?.description || ''
    const req = s?.function?.parameters?.required || []
    return { name, description: desc.slice(0, 200), required_params: req }
  }
  const matches = found.slice(0, 8).map(describe)

  return toolJson({
    ok: true,
    tool: 'find_tool',
    query,
    loaded: matches.map(m => m.name),
    matches,
    capabilities,
    note: '这些工具已为本轮装载——现在直接调用你需要的那个即可，不必再 find_tool。' +
      (capabilities.length ? '相关能力的工作流见 capabilities 字段，按它行动。' : ''),
  })
}
