// 测试：从 hermes-agent / openhuman / openclaw 移植的改进
//   1. 工具结果压缩（TokenJuice / hermes _summarize_tool_result）
//   2. 技能学习闭环（learn_skill / view_skill / improve_skill / 用量遥测）
//   3. MCP 客户端（stdio JSON-RPC：initialize / tools/list / tools/call）
//   4. 主线会话窗口外压缩（hermes context_compressor 的 compaction）
//   5. 复杂任务后沉淀技能引导（hermes 自主学习）+ 任务自评 live 化
//
// 运行：node src/test-learned-improvements.js （MCP 部分会用自带的 mock 服务器）
// 纯逻辑部分可在普通 node 下跑；涉及 db 的 live 集成另由 electron 冒烟验证。

import fs from 'fs'
import path from 'path'
import os from 'os'

let failed = 0
function assert(cond, label) {
  if (!cond) { console.error(`FAIL: ${label}`); failed += 1; process.exitCode = 1 }
  else console.log(`PASS: ${label}`)
}

// ── 隔离：把数据目录指到临时目录，避免污染真实数据 ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-improvements-'))
process.env.BAILONGMA_USER_DIR = tmp

// 结束清理临时目录（进程被强杀时 finally 可能不执行，启动期有 sandbox-cleanup 兜底）
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {} })

// ── 1. 工具结果压缩 ──
async function testToolCompression() {
  const { compressToolResultForModel, summarizeToolResult, isToolCompressible, cleanupOldToolOutputs } =
    await import('./runtime/tool-result-compressor.js')

  assert(!isToolCompressible('write_file'), 'write_file 不在压缩白名单')
  assert(isToolCompressible('read_file'), 'read_file 在压缩白名单')
  assert(isToolCompressible('exec_command'), 'exec_command 在压缩白名单')

  const big = 'y'.repeat(2000)
  const small = compressToolResultForModel('read_file', { path: 'a.txt' }, 'hi', { threshold: 1000 })
  assert(small.content === 'hi', '小结果原样放行')

  const compressed = compressToolResultForModel('read_file', { path: 'big.txt' }, big, { dataDir: tmp, threshold: 1000 })
  assert(compressed.summarized === true, '大结果被压缩')
  assert(compressed.content.includes('full output'), '压缩结果带全文路径')
  assert(fs.existsSync(compressed.savedPath), '全文已落盘')

  const w = compressToolResultForModel('write_file', { path: 'x', content: big }, big, { threshold: 1000 })
  assert(w.content === big, '有副作用工具不压缩')

  const execSummary = summarizeToolResult('exec_command', { command: 'npm test' }, JSON.stringify({ ok: true, exit_code: 0, stdout: 'a\nb\nc' }))
  assert(execSummary.includes('exit 0') && execSummary.includes('npm test'), 'exec 摘要含命令和 exit code')

  const webSummary = summarizeToolResult('web_search', { query: 'weather' }, JSON.stringify({ ok: true, results: [1, 2, 3] }))
  assert(webSummary.includes('3 results'), 'web_search 摘要含结果数')

  cleanupOldToolOutputs({ dataDir: tmp, force: true })
}

// ── 2. 技能学习闭环 ──
async function testSkillLoop() {
  const skillsTools = await import('./capabilities/tools/skills.js')
  const usage = await import('./memory/skill-usage.js')
  const schemas = await import('./capabilities/schemas.js')
  const router = await import('./memory/tool-router.js')

  assert(!!schemas.TOOL_SCHEMAS.learn_skill, 'learn_skill schema 存在')
  assert(!!schemas.TOOL_SCHEMAS.improve_skill, 'improve_skill schema 存在')

  // learn_skill 返回带作者规范的指令
  const learn = skillsTools.execLearnSkill({ what: '把发布流程做成技能', name: 'publish-guide' })
  assert(learn.startsWith('[learn_skill]'), 'learn_skill 返回引导指令')
  assert(learn.includes('SKILL.md'), '指令提到 SKILL.md 作者规范')

  // 建一个真实技能（模拟模型 write_file 后）
  const skillDir = path.join(tmp, 'sandbox', 'skills', 'test-loop-skill')
  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'),
    '---\nname: Test Loop Skill\ndescription: Skill to verify the learning loop.\n---\n\n# Test Loop Skill\n\nDo stuff.\n')

  const list = skillsTools.execListSkills({})
  assert(list.includes('test-loop-skill'), '新建技能被 list_skills 发现')

  const view = skillsTools.execViewSkill({ skill: 'test-loop-skill' })
  assert(view.includes('Test Loop Skill'), 'view_skill 返回全文')
  assert((usage.getSkillUsage('test-loop-skill') || {}).use_count >= 1, 'view_skill 记录使用次数')

  const improve = skillsTools.execImproveSkill({ skill: 'test-loop-skill', lesson: 'Always verify output.' })
  assert(improve.startsWith('已把这条教训'), 'improve_skill 写回教训')
  const view2 = skillsTools.execViewSkill({ skill: 'test-loop-skill' })
  assert(view2.includes('## Lessons Learned') && view2.includes('Always verify'), 'SKILL.md 含 Lessons Learned 节')

  // 路由触发
  const sel = router.selectTools({ messageBody: '把刚才的流程学成一个技能', senderId: 'u1' })
  assert(sel.includes('learn_skill'), '「学技能」触发 learn_skill 工具')
  const sel2 = router.selectTools({ messageBody: '今天天气如何', senderId: 'u1' })
  assert(!sel2.includes('learn_skill'), '无关消息不触发技能工具')

  // 清理
  assert(skillsTools.execDeleteSkill({ skill: 'test-loop-skill' }).startsWith('已删除'), 'delete_skill 删除技能')
  assert(usage.getSkillUsage('test-loop-skill') === null, '删除后遥测清空')
}

// ── 3. MCP 客户端 ──
async function testMcp() {
  const mcpTools = await import('./capabilities/tools/mcp.js')
  const client = await import('./mcp/client.js')
  const schemas = await import('./capabilities/schemas.js')
  const router = await import('./memory/tool-router.js')

  assert(!!schemas.TOOL_SCHEMAS.mcp_call, 'mcp_call schema 存在')
  assert(!!schemas.TOOL_SCHEMAS.mcp_list_servers, 'mcp_list_servers schema 存在')

  const sel = router.selectTools({ messageBody: '帮我连一下 Notion', senderId: 'u1' })
  assert(sel.includes('mcp_call'), '「Notion」触发 MCP 工具')
  const sel2 = router.selectTools({ messageBody: '你好', senderId: 'u1' })
  assert(!sel2.includes('mcp_call'), '无关消息不触发 MCP 工具')

  // 配置一个 mock 服务器
  const cfgDir = path.join(tmp, 'data')
  fs.mkdirSync(cfgDir, { recursive: true })
  const mockServer = path.join(tmp, 'mock-mcp-server.cjs')
  fs.writeFileSync(mockServer, `
const readline = require('readline')
const rl = readline.createInterface({ input: process.stdin, terminal: false })
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line) } catch { return }
  const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1' } } })
  else if (msg.method === 'tools/list') send({ jsonrpc: '2.0', id: msg.id, result: { tools: [ { name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } } ] } })
  else if (msg.method === 'tools/call') send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'echo:' + (msg.params.arguments.text || '') }] } })
})
`)
  fs.writeFileSync(path.join(cfgDir, 'mcp-servers.json'), JSON.stringify({
    servers: { mock: { command: 'node', args: [mockServer] } },
  }, null, 2))

  const list = await mcpTools.execMcpListServers()
  assert(list.includes('mock') && list.includes('echo'), 'mcp_list_servers 列出服务器和工具')

  const call = await mcpTools.execMcpCall({ server: 'mock', tool: 'echo', args: { text: 'hi' } })
  assert(call === 'echo:hi', 'mcp_call 调通 mock 工具')

  const bad = await mcpTools.execMcpCall({ server: 'nope', tool: 'x', args: {} })
  assert(bad.includes('未在 data/mcp-servers.json 中配置'), '未配置服务器被拒绝（安全边界）')

  client.disconnectAll()
}

// ── 4. 主线会话窗口外压缩 ──
async function testDialectic() {
  const d = await import('./memory/profile-dialectic.js')
  const tick = await import('./runtime/tick-policy.js')

  // 辩证画像：矛盾检测
  assert(d.detectFactContradiction({ title: '咖啡', content: '用户戒咖啡了' }, { title: '咖啡', content: '用户喜欢喝咖啡' }) !== null, '喜欢→戒：检测到矛盾')
  assert(d.detectFactContradiction({ title: '咖啡', content: '用户戒咖啡了' }, { title: '跑步', content: '用户喜欢晨跑' }) === null, '无关主题不误判')
  assert(d.detectFactContradiction({ title: '推送', content: '用户不要每日推送' }, { title: '推送', content: '用户要每日推送' }) !== null, '要→不要：检测到矛盾')
  assert(d.detectFactContradiction({ title: '家在深圳', content: '用户住在深圳' }, { title: '家在广州', content: '用户住在广州' }) === null, '搬家不误判为矛盾（保守）')

  // mem_id 主题锚：识别器命名编码主题
  assert(d.memIdTopicMatch({ mem_id: 'fact_user_coffee' }, { mem_id: 'fact_user_coffee_quit' }) === 1, 'fact_user_coffee ↔ coffee_quit 同主题')
  assert(d.memIdTopicMatch({ mem_id: 'fact_user_coffee' }, { mem_id: 'fact_user_running' }) === 0, '不同主题不匹配')

  // 记忆提醒 nudge 文案
  const nudge = tick.buildMemoryNudge()
  assert(nudge.includes('persist') && nudge.includes('learn_skill') && nudge.includes('upsert_memory'), '记忆提醒含沉淀途径')
}

// ── 5. 复杂任务后沉淀技能引导 + 任务自评 ──
async function testConversationCompression() {
  const cc = await import('./memory/conv-compress.js')

  // needsCompression 判定
  const short = Array.from({ length: 10 }, (_, i) => ({ id: i, content: 'hi ' + i }))
  assert(!cc.needsCompression(short), '短会话不触发压缩')
  const long = Array.from({ length: 40 }, (_, i) => ({ id: i, content: '这是一条足够长的对话消息内容用于测试窗口外压缩判定 ' + i }))
  assert(cc.needsCompression(long), '长会话（>20 条且溢出内容足够）触发压缩')
  const longButSparse = Array.from({ length: 30 }, (_, i) => ({ id: i, content: i < 10 ? '' : 'x' }))
  assert(!cc.needsCompression(longButSparse), '溢出但内容稀疏（字符不足）不压缩')

  // 压缩输入构建
  const input = cc.buildMainlineCompressionInput(
    [{ from_id: 'user', content: '早前讨论' }],
    [{ from_id: 'jarvis', content: '最近回复' }]
  )
  assert(input.includes('[Older portion to compress'), '输入含「待压缩旧部分」段')
  assert(input.includes('Newest messages already visible'), '输入含「最新消息」连续性锚点')

  // 摘要格式化
  assert(cc.formatMainlineSummary('abc') === '<mainline-history-summary>\nabc\n</mainline-history-summary>', 'formatMainlineSummary 包标签')
  assert(cc.formatMainlineSummary('') === '', '空摘要不输出')
}

// ── 5. 复杂任务后沉淀技能引导 + 任务自评 ──
async function testSkillSuggest() {
  const suggest = await import('./memory/skill-suggest.js')
  const evo = await import('./memory/self-evolution.js')

  assert(!suggest.isComplexTask(2), '2 步不算复杂任务')
  assert(suggest.isComplexTask(3), '3 步算复杂任务')
  assert(!suggest.isComplexTask('x'), '非整数步数不算')

  assert(suggest.buildSkillSuggestion('简单问答', 2) === '', '简单任务不提示')
  const s = suggest.buildSkillSuggestion('做市场调研', 4)
  assert(s.includes('learn_skill') && s.includes('4 步'), '多步任务提示 learn_skill')

  // 任务自评 live 入口（JSON 存储，普通 node 可测）
  const r = evo.triggerTaskSelfEval('测试任务', 'unit')
  assert(r && r.scores.average >= 1, 'triggerTaskSelfEval 写入评估')
  const evals = evo.getRecentEvaluations({ limit: 5 })
  assert(evals.some(e => String(e.mem_id || '').startsWith('self_eval_')), '评估记录可查')
}

async function main() {
  await testToolCompression()
  await testSkillLoop()
  await testMcp()
  await testConversationCompression()
  await testSkillSuggest()
  await testDialectic()
  console.log(failed === 0 ? '\n全部通过 ✓' : `\n${failed} 项失败 ✗`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(e => { console.error('测试崩溃:', e); process.exit(1) })

