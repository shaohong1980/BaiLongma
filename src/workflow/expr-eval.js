// expr-eval.js —— 受限 JS 表达式求值器（替代 new Function，防代码注入）
//
// workflow 的 condition / switch / transform / sub_workflow 输入表达式，过去用
// new Function('context', 'item', ...) 编译执行。那样运行时在主进程全局作用域，
// 表达式里 `process` / `require` / `globalThis` 等标识符都能被引用到（new Function
// 只遮蔽了形参，白名单正则也拦不住 `process.exit(1)` 这类函数调用）。
//
// 本模块改为手写 tokenizer + 递归下降解析 → AST → 求值：
//   · 标识符只从 { item, context } 作用域对象取值，未知标识符 → undefined
//   · 不支持函数调用 / new / 赋值 / 解构 / 模板串
//   · 成员访问拦截 __proto__ / constructor / prototype，避免原型链逃逸
//
// 支持的语法子集（workflow 实际用到的）：
//   字面量：数字、'...'、"..."、true/false/null/undefined
//   引用：item / context 及成员访问（. 属性、[下标/键]）
//   数组/对象字面量：[a,b]、{k:v}
//   一元：! - +
//   二元：* / % + - < <= > >= == != === !== && || ??
//   三元：?:（含括号分组）
// 求值语义对齐 JS 常用行为；==/!= 采用宽松等值近似实现。

import vm from 'node:vm'

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

class ExprError extends Error {}

// ── Tokenizer ────────────────────────────────────────────────────────────────
function tokenize(input) {
  const tokens = []
  let i = 0
  const n = input.length
  while (i < n) {
    const c = input[i]
    if (/\s/.test(c)) { i += 1; continue }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(input[i + 1] || ''))) {
      let j = i
      while (j < n && /[0-9.eE]/.test(input[j])) {
        if ((input[j] === 'e' || input[j] === 'E')) {
          if (/[0-9+\-]/.test(input[j + 1] || '')) j += 1
        }
        j += 1
      }
      const num = Number(input.slice(i, j))
      if (!Number.isNaN(num)) { tokens.push({ type: 'num', value: num }); i = j; continue }
    }
    if (c === "'" || c === '"') {
      let j = i + 1
      let out = ''
      let closed = false
      while (j < n) {
        const ch = input[j]
        if (ch === '\\') {
          const esc = input[j + 1]
          if (esc === 'n') out += '\n'
          else if (esc === 't') out += '\t'
          else if (esc === 'r') out += '\r'
          else if (esc === '\\') out += '\\'
          else if (esc === "'") out += "'"
          else if (esc === '"') out += '"'
          else out += esc
          j += 2
          continue
        }
        if (ch === c) { closed = true; j += 1; break }
        out += ch
        j += 1
      }
      if (!closed) throw new ExprError('unterminated string literal')
      tokens.push({ type: 'str', value: out })
      i = j
      continue
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i
      while (j < n && /[A-Za-z0-9_$]/.test(input[j])) j += 1
      tokens.push({ type: 'ident', value: input.slice(i, j) })
      i = j
      continue
    }
    const three = input.slice(i, i + 3)
    if (three === '===' || three === '!==') { tokens.push({ type: 'op', value: three }); i += 3; continue }
    const two = input.slice(i, i + 2)
    if (['==', '!=', '<=', '>=', '&&', '||', '??'].includes(two)) { tokens.push({ type: 'op', value: two }); i += 2; continue }
    if ('(){}[].,?:+-*/%<>!'.includes(c)) { tokens.push({ type: 'op', value: c }); i += 1; continue }
    throw new ExprError(`unexpected character: ${c}`)
  }
  tokens.push({ type: 'eof', value: '' })
  return tokens
}

// ── Parser（递归下降，产生 AST）──────────────────────────────────────────────
class Parser {
  constructor(tokens) { this.tokens = tokens; this.pos = 0 }
  peek() { return this.tokens[this.pos] }
  next() { return this.tokens[this.pos++] }
  expectOp(op) {
    const t = this.next()
    if (t.type !== 'op' || t.value !== op) throw new ExprError(`expected '${op}'`)
    return t
  }
  parseExpression() { return this.parseTernary() }
  parseTernary() {
    const test = this.parseOr()
    if (this.peek().type === 'op' && this.peek().value === '?') {
      this.next()
      const consequent = this.parseTernary()
      this.expectOp(':')
      const alternate = this.parseTernary()
      return { type: 'ternary', test, consequent, alternate }
    }
    return test
  }
  parseOr() { return this.parseBinaryLeft(['||'], () => this.parseAnd()) }
  parseAnd() { return this.parseBinaryLeft(['&&'], () => this.parseNullish()) }
  parseNullish() { return this.parseBinaryLeft(['??'], () => this.parseEquality()) }
  parseEquality() { return this.parseBinaryLeft(['==', '!=', '===', '!=='], () => this.parseRelational()) }
  parseRelational() { return this.parseBinaryLeft(['<', '<=', '>', '>='], () => this.parseAdditive()) }
  parseAdditive() { return this.parseBinaryLeft(['+', '-'], () => this.parseMultiplicative()) }
  parseMultiplicative() { return this.parseBinaryLeft(['*', '/', '%'], () => this.parseUnary()) }
  parseBinaryLeft(ops, subParser) {
    let left = subParser()
    for (;;) {
      const t = this.peek()
      if (t.type === 'op' && ops.includes(t.value)) {
        this.next()
        const right = subParser()
        left = { type: 'binary', op: t.value, left, right }
      } else break
    }
    return left
  }
  parseUnary() {
    const t = this.peek()
    if (t.type === 'op' && (t.value === '!' || t.value === '-' || t.value === '+')) {
      this.next()
      return { type: 'unary', op: t.value, argument: this.parseUnary() }
    }
    return this.parsePostfix()
  }
  parsePostfix() {
    let node = this.parsePrimary()
    for (;;) {
      const t = this.peek()
      if (t.type === 'op' && t.value === '.') {
        this.next()
        const name = this.next()
        if (name.type !== 'ident') throw new ExprError('expected property name after .')
        node = { type: 'member', object: node, property: { type: 'str', value: name.value }, computed: false }
      } else if (t.type === 'op' && t.value === '[') {
        this.next()
        const key = this.parseExpression()
        this.expectOp(']')
        node = { type: 'member', object: node, property: key, computed: true }
      } else break
    }
    return node
  }
  parsePrimary() {
    const t = this.next()
    if (t.type === 'num' || t.type === 'str') return { type: 'lit', value: t.value }
    if (t.type === 'ident') {
      if (t.value === 'true') return { type: 'lit', value: true }
      if (t.value === 'false') return { type: 'lit', value: false }
      if (t.value === 'null') return { type: 'lit', value: null }
      if (t.value === 'undefined') return { type: 'lit', value: undefined }
      return { type: 'scope', name: t.value }
    }
    if (t.type === 'op') {
      if (t.value === '(') {
        const inner = this.parseExpression()
        this.expectOp(')')
        return inner
      }
      if (t.value === '[') {
        const elements = []
        if (!(this.peek().type === 'op' && this.peek().value === ']')) {
          for (;;) {
            elements.push(this.parseExpression())
            if (this.peek().type === 'op' && this.peek().value === ',') { this.next(); continue }
            break
          }
        }
        this.expectOp(']')
        return { type: 'array', elements }
      }
      if (t.value === '{') {
        const props = []
        if (!(this.peek().type === 'op' && this.peek().value === '}')) {
          for (;;) {
            const kt = this.next()
            let key
            if (kt.type === 'ident') key = kt.value
            else if (kt.type === 'str') key = kt.value
            else throw new ExprError('invalid object key')
            this.expectOp(':')
            props.push({ key, value: this.parseExpression() })
            if (this.peek().type === 'op' && this.peek().value === ',') { this.next(); continue }
            break
          }
        }
        this.expectOp('}')
        return { type: 'object', props }
      }
    }
    throw new ExprError(`unexpected token: ${t.type}:${t.value}`)
  }
}

// ── 求值 ─────────────────────────────────────────────────────────────────────
function lookupScope(scope, name) {
  if (Object.prototype.hasOwnProperty.call(scope, name)) return scope[name]
  return undefined
}

function memberGet(obj, key) {
  if (obj === null || obj === undefined) return undefined
  if (FORBIDDEN_KEYS.has(String(key))) return undefined
  if (Array.isArray(obj)) {
    const idx = Number(key)
    if (Number.isInteger(idx) && idx >= 0 && idx < obj.length) return obj[idx]
    return undefined
  }
  if (typeof obj === 'object' || typeof obj === 'string') {
    if (typeof obj === 'string') {
      if (key === 'length') return obj.length
      const idx = Number(key)
      if (Number.isInteger(idx) && idx >= 0 && idx < obj.length) return obj[idx]
      return undefined
    }
    if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key]
  }
  return undefined
}

function evalNode(node, scope) {
  switch (node.type) {
    case 'lit': return node.value
    case 'scope': return lookupScope(scope, node.name)
    case 'member': {
      const obj = evalNode(node.object, scope)
      if (obj === null || obj === undefined) return undefined
      const key = node.computed ? evalNode(node.property, scope) : node.property.value
      return memberGet(obj, key)
    }
    case 'array': return node.elements.map(el => evalNode(el, scope))
    case 'object': {
      const out = {}
      for (const p of node.props) {
        if (FORBIDDEN_KEYS.has(p.key)) continue
        out[p.key] = evalNode(p.value, scope)
      }
      return out
    }
    case 'unary': {
      const v = evalNode(node.argument, scope)
      if (node.op === '!') return !v
      if (node.op === '-') return -Number(v)
      return +Number(v)
    }
    case 'binary': return evalBinary(node.op, evalNode(node.left, scope), evalNode(node.right, scope))
    case 'ternary': return evalNode(node.test, scope) ? evalNode(node.consequent, scope) : evalNode(node.alternate, scope)
    default: return undefined
  }
}

function evalBinary(op, a, b) {
  switch (op) {
    case '&&': return a && b
    case '||': return a || b
    case '??': return (a === null || a === undefined) ? b : a
    case '==': return looseEquals(a, b)
    case '!=': return !looseEquals(a, b)
    case '===': return a === b
    case '!==': return a !== b
    case '<': return lessThan(a, b)
    case '<=': return !lessThan(b, a)
    case '>': return lessThan(b, a)
    case '>=': return !lessThan(a, b)
    case '+': {
      if (typeof a === 'string' || typeof b === 'string') return String(a) + String(b)
      return Number(a) + Number(b)
    }
    case '-': return Number(a) - Number(b)
    case '*': return Number(a) * Number(b)
    case '/': {
      const bn = Number(b)
      if (bn === 0) return Infinity
      return Number(a) / bn
    }
    case '%': {
      const bn = Number(b)
      if (bn === 0) return NaN
      return Number(a) % bn
    }
    default: return undefined
  }
}

function lessThan(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a < b
  if (a === null || b === null) return a === null && b !== null
  return String(a) < String(b)
}

// JS 宽松等值近似：覆盖 null/undefined/数字/字符串/布尔 的常见比较
function looseEquals(a, b) {
  if (a === b) return true
  if (a === null || a === undefined) return b === null || b === undefined
  if (b === null || b === undefined) return false
  const ta = typeof a
  const tb = typeof b
  if (ta === tb) return a === b
  if (ta === 'object' || tb === 'object') return false
  // 数字 <-> 字符串 <-> 布尔：统一数字化后比较，数字化失败退回字符串比较
  const toNum = (v) => {
    if (typeof v === 'boolean') return Number(v)
    const s = String(v).trim()
    return s !== '' && !Number.isNaN(Number(s)) ? Number(s) : NaN
  }
  const na = toNum(a)
  const nb = toNum(b)
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na === nb
  return String(a) === String(b)
}

// 供 workflow 使用的入口：解析并求值表达式。
// scope = { item?, context? }；解析/求值失败返回 undefined（与旧的 catch→undefined 一致）。
export function evalWorkflowExpr(expr, scope = {}) {
  try {
    const tokens = tokenize(String(expr || '').trim())
    const ast = new Parser(tokens).parseExpression()
    return evalNode(ast, scope)
  } catch (err) {
    if (err instanceof ExprError) return undefined
    throw err
  }
}

// code 节点：任意 JS 语句改用 node:vm 沙箱执行（不再 new Function 在主进程全局作用域跑）。
// 沙箱里只有 context 可读，无 process/require/fs/net/globalThis 等宿主能力；
// 仍由调用方 allowCode 门控（须已有 Agent 级代码执行授权）。
export function evalWorkflowCode(code, context) {
  try {
    const sandbox = { context }
    const wrapped = `(function(){ "use strict";\n${code}\n})()`
    return vm.runInNewContext(wrapped, sandbox, { timeout: 2000, displayErrors: true })
  } catch (err) {
    return { error: err?.message || String(err) }
  }
}
