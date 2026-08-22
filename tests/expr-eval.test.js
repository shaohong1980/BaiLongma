// workflow 表达式 AST 求值器单测（替代 new Function 的安全求值器）
import { describe, it, expect } from 'vitest'
import { evalWorkflowExpr, evalWorkflowCode } from '../src/workflow/expr-eval.js'

const ctx = { input: 'hello', count: 5, nested: { a: 1, list: [10, 20, 30] }, flag: true }
const item = { price: 100, qty: 3, name: 'widget' }
const scope = { item, context: ctx }

describe('evalWorkflowExpr 基本求值', () => {
  const cases = [
    ['context.input === "hello"', true],
    ['item.price * item.qty', 300],
    ['context.count > 3', true],
    ['context.count <= 5', true],
    ['context.flag && item.qty > 0', true],
    ['!context.flag', false],
    ['context.nested.list[1]', 20],
    ['context.nested.a + item.price', 101],
    ['item.name', 'widget'],
    ['context.missing ?? "default"', 'default'],
    ['item.qty >= 3 ? "bulk" : "single"', 'bulk'],
    ['context.count % 2', 1],
    ['"a" + "b"', 'ab'],
  ]
  it.each(cases)('%s => %s', (expr, expected) => {
    expect(evalWorkflowExpr(expr, scope)).toBe(expected)
  })
})

describe('evalWorkflowExpr 宽松相等 / 严格相等 / 其他运算', () => {
  const cases = [
    ['null == undefined', true],
    ['1 == "1"', true],
    ['true == 1', true],
    ['0 == false', true],
    ['"a" == "b"', false],
    ['1 === "1"', false],
    ['"x" === "x"', true],
    ['"1" == 1', true],
    ['"x" == 1', false],
    ['!0', true],
    ['-item.qty', -3],
    ['+"3"', 3],
    ['item.price / 0', Infinity],
    ['10 % 3', 1],
    ['"abc".length', 3],
    ['({ a: 1, b: 2 }).a', 1],
    ['[10, 20][1]', 20],
    ['item.qty < 5 && context.count > 2', true],
    ['context.input || "fallback"', 'hello'],
    ['context.missing || "fallback"', 'fallback'],
  ]
  it.each(cases)('%s => %s', (expr, expected) => {
    expect(evalWorkflowExpr(expr, scope)).toBe(expected)
  })
})

describe('evalWorkflowExpr 非法表达式返回 undefined（不抛错）', () => {
  const bad = [
    'context.input +',       // 表达式不完整
    "'unterminated",         // 未闭合字符串
    'item.',                 // 悬空点
    'process.exit(',         // 不支持函数调用 → 解析失败
    '(',                     // 括号未闭合
    '{{{',                   // 非法对象
  ]
  it.each(bad)('非法表达式返回 undefined: %s', (expr) => {
    expect(evalWorkflowExpr(expr, scope)).toBeUndefined()
  })
})

describe('evalWorkflowExpr 安全隔离', () => {
  const escapes = [
    'process.env',
    'process.exit(1)',
    'require("fs")',
    'globalThis',
    'this',
    'context.__proto__',
    'context.constructor',
    'Function("return 1")()',
  ]
  it.each(escapes)('拦截逃逸: %s', (expr) => {
    // 不应抛错，也不应返回可用的宿主对象
    const value = evalWorkflowExpr(expr, scope)
    expect(value).toBeUndefined()
  })
})

describe('evalWorkflowCode（vm 沙箱）', () => {
  it('可访问 context 并返回值', () => {
    expect(evalWorkflowCode('return context.input + "!"', ctx)).toBe('hello!')
  })
  it('沙箱内无 process/require', () => {
    expect(evalWorkflowCode('return typeof process', ctx)).toBe('undefined')
    expect(evalWorkflowCode('return typeof require', ctx)).toBe('undefined')
  })
  it('抛错返回错误对象', () => {
    const r = evalWorkflowCode('throw new Error("boom")', ctx)
    expect(String(r?.error)).toContain('boom')
  })
})
