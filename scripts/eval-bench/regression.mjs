// regression.mjs —— 评估结果回归对比
//
// 对比两次评估结果，检测性能退化：
//   - 通过率变化
//   - 各维度平均分变化
//   - 具体用例的 pass/fail 变化
//   - 新增失败用例
//
// 用法：
//   node scripts/eval-bench/regression.mjs --baseline=v1.json --current=v2.json
//   node scripts/eval-bench/regression.mjs --list  # 列出历史评估结果

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HISTORY_DIR = path.join(__dirname, 'history')

function ensureHistoryDir() {
  if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true })
}

// 保存评估结果到历史
export function saveEvaluationResult(result, label = '') {
  ensureHistoryDir()
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const filename = `eval_${timestamp}${label ? '_' + label : ''}.json`
  const filepath = path.join(HISTORY_DIR, filename)
  fs.writeFileSync(filepath, JSON.stringify(result, null, 2))
  return filepath
}

// 列出历史评估结果
function listHistory() {
  ensureHistoryDir()
  const files = fs.readdirSync(HISTORY_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse()
  return files.map(f => {
    const filepath = path.join(HISTORY_DIR, f)
    const stat = fs.statSync(filepath)
    return { file: f, path: filepath, created: stat.mtime.toISOString() }
  })
}

// 加载评估结果
function loadResult(filepath) {
  if (!fs.existsSync(filepath)) throw new Error(`文件不存在: ${filepath}`)
  return JSON.parse(fs.readFileSync(filepath, 'utf-8'))
}

// 对比两次结果
function compareResults(baseline, current) {
  const baseCases = normalizeCases(baseline)
  const currCases = normalizeCases(current)

  const baseMap = new Map(baseCases.map(c => [c.id, c]))
  const currMap = new Map(currCases.map(c => [c.id, c]))

  const allIds = new Set([...baseMap.keys(), ...currMap.keys()])
  const changes = []
  let newPasses = 0, newFails = 0, regressions = 0, improvements = 0

  for (const id of allIds) {
    const base = baseMap.get(id)
    const curr = currMap.get(id)
    const basePassed = base?.passed ?? null
    const currPassed = curr?.passed ?? null

    if (basePassed === null && currPassed !== null) {
      changes.push({ id, type: 'new', status: currPassed ? 'pass' : 'fail' })
      if (currPassed) newPasses++; else newFails++
    } else if (basePassed !== null && currPassed === null) {
      changes.push({ id, type: 'removed', was: basePassed ? 'pass' : 'fail' })
    } else if (basePassed !== currPassed) {
      if (basePassed && !currPassed) {
        changes.push({ id, type: 'regression', from: 'pass', to: 'fail' })
        regressions++
      } else {
        changes.push({ id, type: 'improvement', from: 'fail', to: 'pass' })
        improvements++
      }
    }
  }

  const basePassRate = calcPassRate(baseCases)
  const currPassRate = calcPassRate(currCases)

  return {
    summary: {
      baseline_total: baseCases.length,
      current_total: currCases.length,
      baseline_pass_rate: basePassRate,
      current_pass_rate: currPassRate,
      pass_rate_change: (currPassRate - basePassRate).toFixed(1) + '%',
      regressions,
      improvements,
      new_passes: newPasses,
      new_fails: newFails,
      verdict: regressions > 0 ? 'REGRESSION_DETECTED' : 'OK',
    },
    changes,
    regressions: changes.filter(c => c.type === 'regression'),
    improvements: changes.filter(c => c.type === 'improvement'),
  }
}

function normalizeCases(result) {
  if (Array.isArray(result)) return result
  if (result.results) return result.results
  if (result.tasks) return result.tasks
  return []
}

function calcPassRate(cases) {
  if (!cases.length) return 0
  const passed = cases.filter(c => c.passed || c.judgment?.passed).length
  return (passed / cases.length) * 100
}

async function main() {
  const listFlag = process.argv.includes('--list')
  const baselineArg = process.argv.find(a => a.startsWith('--baseline='))
  const currentArg = process.argv.find(a => a.startsWith('--current='))
  const saveArg = process.argv.find(a => a.startsWith('--save='))
  const inputArg = process.argv.find(a => a.startsWith('--input='))

  if (listFlag) {
    const history = listHistory()
    if (!history.length) { console.log('暂无历史评估结果'); return }
    console.log('历史评估结果：')
    history.forEach((h, i) => console.log(`  ${i + 1}. ${h.file} (${h.created})`))
    return
  }

  if (saveArg && inputArg) {
    const result = loadResult(inputArg.split('=')[1])
    const filepath = saveEvaluationResult(result, saveArg.split('=')[1])
    console.log(`已保存到历史: ${filepath}`)
    return
  }

  if (!baselineArg || !currentArg) {
    console.error('用法：')
    console.error('  node regression.mjs --list')
    console.error('  node regression.mjs --baseline=old.json --current=new.json')
    console.error('  node regression.mjs --input=result.json --save=v2')
    process.exit(1)
  }

  const baseline = loadResult(baselineArg.split('=')[1])
  const current = loadResult(currentArg.split('=')[1])
  const comparison = compareResults(baseline, current)

  console.log('\n=== 回归对比报告 ===')
  console.log(`基线用例数: ${comparison.summary.baseline_total}`)
  console.log(`当前用例数: ${comparison.summary.current_total}`)
  console.log(`基线通过率: ${comparison.summary.baseline_pass_rate.toFixed(1)}%`)
  console.log(`当前通过率: ${comparison.summary.current_pass_rate.toFixed(1)}%`)
  console.log(`变化: ${comparison.summary.pass_rate_change}`)
  console.log(`退化: ${comparison.summary.regressions}`)
  console.log(`改进: ${comparison.summary.improvements}`)
  console.log(`新增通过: ${comparison.summary.new_passes}`)
  console.log(`新增失败: ${comparison.summary.new_fails}`)
  console.log(`结论: ${comparison.summary.verdict}`)

  if (comparison.regressions.length) {
    console.log('\n⚠️  退化用例：')
    comparison.regressions.forEach(r => console.log(`  - ${r.id}`))
  }
  if (comparison.improvements.length) {
    console.log('\n✅ 改进用例：')
    comparison.improvements.forEach(r => console.log(`  - ${r.id}`))
  }

  // 保存对比报告
  const reportPath = path.join(__dirname, 'regression-report.json')
  fs.writeFileSync(reportPath, JSON.stringify(comparison, null, 2))
  console.log(`\n详细报告已保存: ${reportPath}`)

  process.exit(comparison.summary.regressions > 0 ? 1 : 0)
}

main().catch(err => { console.error(err); process.exit(1) })
