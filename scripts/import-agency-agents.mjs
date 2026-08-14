// 从 agency-agents-zh 拉取全部角色 markdown 并转成 Bailongma roles/*.json
import fs from 'fs'
import path from 'path'

const BASE = 'https://raw.githubusercontent.com/jnMetaCode/agency-agents-zh/main/'
const OUT = path.resolve('.dev-test/agency-agents/roles')
const ROOT = path.resolve('roles')
fs.mkdirSync(OUT, { recursive: true })

// 1. 获取文件清单
const tree = await fetch('https://api.github.com/repos/jnMetaCode/agency-agents-zh/git/trees/main?recursive=1', {
  headers: { 'Accept': 'application/vnd.github+json' },
}).then(r => r.json())
const files = (tree.tree || [])
  .filter(t => t.path.endsWith('.md') && t.path.split('/').length === 2)
  .map(t => t.path)
console.log('角色文件数:', files.length)

// 2. 逐个拉取并解析（并发 6）
const CONC = 6
let idx = 0
const results = []
async function worker() {
  while (idx < files.length) {
    const p = files[idx++]
    try {
      const md = await fetch(BASE + p).then(r => r.text())
      const role = convert(p, md)
      if (role) results.push(role)
    } catch {}
  }
}
await Promise.all(Array.from({ length: CONC }, worker))
console.log('转换成功:', results.length)

// 3. 写文件（避免覆盖已有的 7 个内置角色）
let written = 0, skipped = 0
for (const role of results) {
  const file = path.join(ROOT, role.id + '.json')
  if (fs.existsSync(file)) { skipped++; continue }
  fs.writeFileSync(file, JSON.stringify(role, null, 2), 'utf-8')
  written++
}
console.log('写入:', written, '| 跳过(已存在):', skipped)
process.exit(0)

function convert(filePath, md) {
  const slug = path.basename(filePath, '.md')
  const fmMatch = md.match(/^---\s*\n([\s\S]*?)\n---/)
  const fm = {}
  if (fmMatch) {
    for (const line of fmMatch[1].split('\n')) {
      const m = line.match(/^([\w-]+):\s*(.*)$/)
      if (m) fm[m[1].trim()] = m[2].trim()
    }
  }
  const name = fm.name || slug.split('-').pop()
  const description = fm.description || ''
  const emoji = fm.emoji || ''
  const color = fm.color || ''
  const body = md.replace(/^---\s*\n[\s\S]*?\n---/, '')

  // persona：取 "身份与记忆" 或开头一段
  const idMatch = body.match(/身份与记忆[^\n]*\n([\s\S]*?)(?=\n##|$)/)
  const persona = idMatch
    ? idMatch[1].split('\n').map(l => l.replace(/^[-*]\s*/, '').trim()).filter(Boolean).slice(0, 4).join('；')
    : name

  // guidelines：取 "关键规则" 或 "核心使命" 的条目
  const ruleSection = body.match(/(?:关键规则|核心使命|规则)[^\n]*\n([\s\S]*?)(?=\n##|$)/)
  const guidelines = []
  if (ruleSection) {
    for (const line of ruleSection[1].split('\n')) {
      const m = line.match(/^\s*\d+[.、]\s*(.+)/)
      if (m) guidelines.push(m[1].trim())
    }
  }

  return {
    id: slug,
    name,
    label: name,
    description: description.slice(0, 200),
    avatar: emoji,
    color,
    persona: String(persona).slice(0, 400),
    guidelines: guidelines.slice(0, 8),
  }
}
