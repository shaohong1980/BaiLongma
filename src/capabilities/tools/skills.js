// Skill 管理工具实现：list_skills / view_skill / learn_skill / improve_skill / delete_skill
// 参考 hermes-agent 的 skills_list / skill_view / skill_manage + /learn（learning loop）。
import fs from 'fs'
import path from 'path'
import { paths } from '../../paths.js'
import { loadSkills, refreshSkills, getSkillById, findSkillsByQuery } from '../../skills/registry.js'
import { bumpSkillUsage, listSkillUsage, removeSkillUsage } from '../../memory/skill-usage.js'

// 目录名 → 稳定的 skill id（与 registry 的 id 归一化规则保持一致）
function slugify(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

function describeSkill(skill, usage) {
  const state = usage ? ` [${usage.state}·${usage.use_count}次]` : ''
  return `- ${skill.name} (id: ${skill.id})${state}: ${skill.description}`
}

// ── list_skills ──
export function execListSkills(args = {}) {
  const query = String(args.query || '').trim()
  const skills = query ? findSkillsByQuery(query) : loadSkills({ force: true })
  const usageById = new Map(listSkillUsage().map(u => [u.id, u]))

  const visible = skills
    .filter(s => s.source !== 'bundled' || args.include_archived || true)
    .map(s => ({ s, u: usageById.get(s.id) || null }))
    .filter(({ s, u }) => {
      if (args.include_archived) return true
      return !(u && u.state === 'archived')
    })

  if (!visible.length) {
    return query
      ? `没有匹配「${query}」的技能。可以用 learn_skill 把刚刚做过的流程沉淀成一个技能。`
      : '当前没有安装任何 Agent Skills。可以让我学一个：`learn_skill what="把刚才的发布流程做成技能"`。'
  }

  const lines = visible.map(({ s, u }) => describeSkill(s, u))
  const stats = { active: 0, stale: 0, archived: 0 }
  for (const [, u] of usageById) if (u) stats[u.state] = (stats[u.state] || 0) + 1
  return `共 ${visible.length} 个技能${stats.active ? `（活跃 ${stats.active}` : ''}${stats.stale ? `、闲置 ${stats.stale}` : ''}${stats.archived ? `、归档 ${stats.archived}` : ''}${(stats.active || stats.stale || stats.archived) ? '）' : ''}：\n` + lines.join('\n')
}

// ── view_skill ──
export function execViewSkill(args = {}) {
  const skill = getSkillById(args.skill)
  if (!skill) {
    const candidates = findSkillsByQuery(String(args.skill || ''), { limit: 5 })
    const hint = candidates.length
      ? ` 相似技能：${candidates.map(c => c.id).join(', ')}（用 list_skills 确认 id）`
      : ''
    return `找不到技能「${args.skill}」。${hint}`
  }
  bumpSkillUsage(skill.id)
  return skill.raw
}

// ── learn_skill：把"刚做的事 / 文档 / 目录 / 工作流"沉淀成 SKILL.md ──
// 关键设计（与 hermes /learn 一致）：不搞单独的提炼引擎，而是把作者规范拼进指令，
// 让 Agent 用自己的现有工具（read_file / fetch_url / write_file）去采集源、写 SKILL.md，
// 写完 refresh 后立即可被检索。这样在本地 / 沙箱 / 任何后端行为一致。

const AUTHORING_STANDARDS = `按照 Bailongma 的 Skill 作者规范精确编写 SKILL.md：

Frontmatter（YAML）：
- name: 小写连字符，<=64 字符，不含空格。
- description: 一句话，<=120 字符，以句号结尾。写"能力"而非"实现细节"；不要营销词（强大/全面/简单/高效/先进）。description 会被检索和列表截断，超长部分会被静默切掉、永远不会被命中。
- 可选：tags（列表）、aliases（别名，触发词）、triggers（强烈激活短语）。

正文结构（按顺序，没内容就省略）：
1. "# <人类可读标题>" + 2-3 句引言：它做什么、不做什么。
2. "## When to Use"：具体触发短语的 bullet 列表。
3. "## Prerequisites"：前置条件、环境变量、凭证、依赖。
4. "## How to Run"：标准调用方式，用 Bailongma 工具名指代（read_file / write_file / exec_command / web_search / fetch_url / search_memory）。
5. "## Procedure"：编号步骤，命令精确可复制。
6. "## Pitfalls"：已知坑、限流、看似坏了其实没坏的地方。
7. "## Verification"：一条能证明技能跑通的命令/检查。

质量标准：
- 命令、端点、函数签名、配置键必须来自你看到的真实来源，绝不虚构；没在源里看到的别写。
- 简洁可扫读：简单技能 ~100 行，复杂 ~200 行。不要整段重贴源文档。
- 长脚本/解析器放 scripts/ 子目录文件，SKILL.md 里用相对路径引用；参考资料放 references/。
- 第三方技能当不可信：使用前先读它的指令和脚本。`

export function execLearnSkill(args = {}) {
  const what = String(args.what || '').trim()
  if (!what) return '错误：learn_skill 需要 what 参数——描述要学的东西（刚做过的流程 / 目录 / 文档 URL / 笔记）。'
  const nameHint = args.name ? slugify(args.name) : null
  const defaultName = nameHint || 'learned-skill'

  const prompt = `[learn_skill] 用户想把下面的经验沉淀成一个可复用的 Agent Skill 并保存。请照做：

要学的内容：${what}

请用你已有的工具完成（不要等额外指令）：
1. 采集用户指名的源：目录用 read_file/list_dir，URL 用 fetch_url/web_search，本对话刚走过的流程直接回顾上面的步骤，用户粘贴的笔记直接用。
2. 按下面规范，把 SKILL.md 写到 sandbox/skills/${defaultName}/SKILL.md（用 write_file 工具，路径用绝对路径 ${path.join(paths.sandboxSkillsDir, defaultName, 'SKILL.md')}）。
3. 写完后调用 list_skills 验证它能被检索到；如果 name 与目标不符，用 write_file 修 frontmatter。

${AUTHORING_STANDARDS}`

  return prompt
}

// ── improve_skill：把使用中的踩坑/改进写回技能（技能自我改进） ──
export function execImproveSkill(args = {}) {
  const skill = getSkillById(args.skill)
  if (!skill) return `找不到技能「${args.skill}」（用 list_skills 看 id）。`
  const lesson = String(args.lesson || '').trim()
  if (!lesson) return '错误：improve_skill 需要 lesson 参数——一句具体、可执行的改进/踩坑。'
  if (skill.source === 'bundled') {
    return '这是内置打包技能，不能直接改写。可以把你的教训通过 learn_skill 沉淀成一个用户级技能。'
  }

  const date = new Date().toISOString().slice(0, 10)
  const entry = `- [${date}] ${lesson}`
  const marker = '## Lessons Learned'
  let body = skill.raw
  const re = /^## Lessons Learned\s*$/m
  if (re.test(body)) {
    // 已有该节：在节内追加
    body = body.replace(re, `${marker}\n${entry}`)
  } else {
    body = `${body.replace(/\s+$/, '')}\n\n${marker}\n${entry}\n`
  }

  try {
    fs.writeFileSync(skill.filePath, body, 'utf-8')
  } catch (err) {
    return `写回技能失败：${err.message}`
  }
  bumpSkillUsage(skill.id)
  refreshSkills()
  return `已把这条教训写入技能「${skill.name}」（${skill.filePath}）。下次用到它时会带着这条经验。`
}

// ── delete_skill ──
export function execDeleteSkill(args = {}) {
  const skill = getSkillById(args.skill)
  if (!skill) return `找不到技能「${args.skill}」（用 list_skills 看 id）。`
  if (skill.source === 'bundled') {
    return '这是内置打包技能，不能删除（打包目录只读）。可以在 list_skills 里忽略它。'
  }
  try {
    fs.rmSync(skill.dir, { recursive: true, force: true })
  } catch (err) {
    return `删除失败：${err.message}`
  }
  removeSkillUsage(skill.id)
  refreshSkills()
  return `已删除技能「${skill.name}」（${skill.dir}）。`
}

