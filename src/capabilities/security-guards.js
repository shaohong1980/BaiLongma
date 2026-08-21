// security-guards.js —— 安全规则引擎（移植自 QwenPaw 的安全四件套概念）
//
// 本模块把 QwenPaw 的三个安全层的检测逻辑用纯 JS 实现（原项目为 Python）：
//   1. ShellEvasionGuardian（Tool Guard 的 shell 部分）
//        - 在命令执行前检测命令注入 / 路径穿越 / 反弹 Shell / 混淆编码攻击 / 数据外泄
//        - 分级：STRICT（最严）/ SMART（智能，默认）/ AUTO（保守自动）/ OFF（关闭）
//   2. FileGuard
//        - 独立于 sandbox 的文件访问策略：阻止 Agent 访问敏感文件/目录（~/.ssh、.env、凭证等）
//   3. SkillScanner
//        - 技能包激活前扫描：prompt injection / 硬编码密钥 / 数据外泄模式
//        - 模式：block（阻止）/ warn（警告）/ off（关闭），支持 whitelist
//
// 纯函数设计，不 import 运行态，可独立测试（见 scripts/smoke-security-guards.mjs）。
// 接线点：
//   - src/capabilities/tool-policy.js   → isDangerousShellCommand 使用 guardShellCommand
//   - src/capabilities/tools/filesystem.js → 文件读写走 guardFilePath
//   - src/skills/registry.js             → loadSkills 时对每个技能跑 scanSkillContent

// ─── 等级常量 ───────────────────────────────────────────────
export const GUARD_LEVELS = ['off', 'auto', 'smart', 'strict']
export const DEFAULT_SHELL_GUARD = 'smart'
export const DEFAULT_FILE_GUARD = 'smart'
export const DEFAULT_SKILL_SCAN = 'warn'   // block | warn | off

// 把配置里的字符串等级归一化为合法值；非法输入回落到默认
export function normalizeGuardLevel(value, fallback, allowed = GUARD_LEVELS) {
  const v = String(value || '').trim().toLowerCase()
  return allowed.includes(v) ? v : fallback
}

// ─────────────────────────────────────────────────────────────
// 1. ShellEvasionGuardian
// ─────────────────────────────────────────────────────────────
// 每条规则：{ re, label, level }，level 是"触发该规则的最松等级"。
//   - 判定"命中需拦截"：当前模式的严格度 >= 规则的 level 严格度。
//   - 严格度排序：off(0) < auto(1) < smart(2) < strict(3)。
//   - 每个规则带说明，供模型看到"为什么被拦"，从而学会避开而非绕开。
const SHELL_RULE_STRICTNESS = { off: 0, auto: 1, smart: 2, strict: 3 }

const SHELL_RULES = [
  // ── 命令注入 / 拼接（任何等级都拦）──
  { level: 'auto', label: 'command chain injection', re: /[;&|]\s*(rm|del|format|diskpart|shutdown|kill|taskkill|Remove-Item|whoami|net\s+user)\b/i },
  { level: 'auto', label: 'command substitution backticks', re: /`[^`]*`/ },
  { level: 'auto', label: 'command substitution $()', re: /\$\([^)]*\)/ },
  { level: 'auto', label: 'heredoc-to-script injection', re: /<<\s*-?\s*['"]?(sh|bash|cmd|powershell)['"]?/i },
  { level: 'auto', label: 'inline PowerShell -EncodedCommand', re: /(powershell|pwsh)(\.exe)?\s+(-\w+\s+)*-(Command|EncodedCommand|enc\b)\s+/i },

  // ── 路径穿越 / 绝对路径 / 家目录 ──
  { level: 'auto', label: 'parent-directory traversal', re: /(^|[\s"'`])\.\.[\\/]/ },
  { level: 'auto', label: 'absolute windows path', re: /(^|[\s"'`])[a-z]:[\\/]/i },
  { level: 'auto', label: 'absolute unix system path', re: /(^|[\s"'`])\/(etc|usr|var|opt|boot|sbin|bin|dev)\b/i },
  { level: 'auto', label: 'UNC network path', re: /(^|[\s"'`])[\\/]{2}[^\\/]/ },
  { level: 'auto', label: 'home directory reference', re: /(^|[\s"'`])~([\\/]|$)/ },
  { level: 'auto', label: 'environment home variable', re: /\$(home|env:userprofile)\b/i },

  // ── 破坏性系统操作 ──
  { level: 'auto', label: 'recursive delete of system root', re: /\brm\s+(-[^ ]*\s+)*(-r|-rf|-fr)\s+\//i },
  { level: 'auto', label: 'recursive delete PowerShell', re: /Remove-Item\b[^;]*\s-Recurse/i },
  { level: 'auto', label: 'recursive delete cmd', re: /\brd\s+\/s\b|\brmdir\s+\/s\b/i },
  { level: 'auto', label: 'disk partitioning', re: /\b(diskpart|format\s+[a-z]:)\b/i },
  { level: 'auto', label: 'system shutdown', re: /\bshutdown\b[^;]*(now|-\s*s\b|\/s\b)/i },
  { level: 'auto', label: 'git destructive worktree reset', re: /\bgit\s+(reset\s+--hard|clean\s+-[^ ]*\s*f)/i },

  // ── 动态代码执行（绕过静态策略）──
  { level: 'smart', label: 'dynamic invocation via Invoke-Expression', re: /\b(Invoke-Expression|iex\b)\s/i },
  { level: 'smart', label: 'eval-family dynamic execution', re: /\b(eval|exec|system|popen|os\.system)\s*\(/i },
  { level: 'smart', label: 'start-process with raw payload', re: /\bStart-Process\b[^;]*-\s*(FilePath|ArgumentList)\s/i },
  { level: 'smart', label: 'binary download and execute', re: /(curl|wget|Invoke-WebRequest|iwr|IEX)\b[^;\n]*(\.exe|\.bat|\.ps1|\.dll|\.sh)\b/i },

  // ── 反弹 Shell / 远程接入 ──
  { level: 'smart', label: 'reverse shell via /dev/tcp', re: /\b\/dev\/tcp\/[0-9]{1,3}(\.[0-9]{1,3}){3}\// },
  { level: 'smart', label: 'reverse shell via bash -i', re: /bash\s+-i\s*[;&|]/i },
  { level: 'smart', label: 'netcat / ncat / socat reverse', re: /\b(nc|ncat|netcat|socat)\s+[^\s]+\s+-[^\s]*e\s+/i },
  { level: 'smart', label: 'powershell reverse shell', re: /(powershell|pwsh)[^\n]*(TcpClient|NetworkStream|StreamWriter)/i },

  // ── 混淆编码（Hex / Octal / Base64 / 转义）──
  { level: 'smart', label: 'hex-encoded shell bytes', re: /\b(?:\\x[0-9a-f]{2}){4,}/i },
  { level: 'smart', label: 'octal-escaped shell bytes', re: /(?:\\[0-7]{3}){4,}/ },
  { level: 'smart', label: 'base64-encoded payload flag', re: /\b(ConvertTo|FromBase64String|fromBase64|base64\s+(-d|--decode|-D))\b/i },
  { level: 'smart', label: 'unicode-escaped command', re: /(?:\\u[0-9a-f]{4}){4,}/i },
  { level: 'smart', label: 'control-character embedded command', re: /[\x00-\x08\x0b\x0c\x0e-\x1f]/ },

  // ── 凭证 / 敏感信息访问 ──
  { level: 'smart', label: 'credential dump access', re: /\b(mimikatz|lsass|secretsdump|cachedump)\b/i },
  { level: 'strict', label: 'password/key registry read', re: /\b(reg\s+(query|export)\b)[^;]*(HKLM|HKCU)/i },

  // ── 数据外泄 ──
  { level: 'smart', label: 'exfiltrate file via network POST', re: /\b(curl|wget|Invoke-WebRequest)\b[^;\n]*(--data|-d\b|--data-binary|--upload-file|-T\b|Invoke-RestMethod)/i },
  { level: 'smart', label: 'encode local file then send', re: /(base64|certutil\s+-encode)[^;\n]*(curl|wget|Invoke-WebRequest|nc\s)/i },
  { level: 'strict', label: 'silent download-to-nowhere with remote fetch', re: /\b(curl|wget|Invoke-WebRequest)\b[^;\n]*-o\s+[^;\n]*(http|https):\/\//i },
]

// 计算一条规则在某个模式下是否拦截。
function ruleBlocksAt(ruleLevel, mode) {
  return SHELL_RULE_STRICTNESS[mode] >= SHELL_RULE_STRICTNESS[ruleLevel]
}

/**
 * 检测一条 shell 命令并返回拦截原因列表。
 * @param {string} command 原始命令文本
 * @param {object} [options]
 * @param {string} [options.mode='smart']  GUARD_LEVELS 之一（off/auto/smart/strict）
 * @returns {{ blocked: boolean, reasons: string[], findings: Array<{level:string,label:string}> }}
 */
export function guardShellCommand(command, { mode = DEFAULT_SHELL_GUARD } = {}) {
  const m = normalizeGuardLevel(mode, DEFAULT_SHELL_GUARD)
  if (m === 'off') return { blocked: false, reasons: [], findings: [] }
  const text = String(command || '').trim()
  if (!text) return { blocked: false, reasons: [], findings: [] }

  const findings = []
  for (const rule of SHELL_RULES) {
    if (!ruleBlocksAt(rule.level, m)) continue
    if (rule.re.test(text)) {
      findings.push({ level: rule.level, label: rule.label })
    }
  }
  const reasons = findings.map(f => f.label)
  return { blocked: reasons.length > 0, reasons, findings }
}

// ─────────────────────────────────────────────────────────────
// 2. FileGuard —— 敏感路径访问策略
// ─────────────────────────────────────────────────────────────
// 与 sandbox（目录白名单）正交：sandbox 管"能去哪"，FileGuard 管"哪些敏感文件/目录
// 即使路径可达也不该碰"。覆盖 QwenPaw FileGuard 默认保护的类别，并补 Windows 常见项。
const FILE_GUARD_PATTERNS = [
  { level: 'auto', label: 'SSH private keys', re: /(^|[\\/])\.ssh([\\/]|$)|(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$|(^|[\\/])known_hosts$/i },
  { level: 'auto', label: 'credential dotfiles', re: /(^|[\\/])\.(env|aws|azure|gcloud|kube|docker)([\\/]|$)|\.(env|env\.local|pypirc|npmrc|netrc)$/i },
  { level: 'auto', label: 'cloud credentials', re: /(^|[\\/])\.aws([\\/])|(credentials|config)$/i },
  { level: 'auto', label: 'git credentials', re: /(^|[\\/])\.git-credentials$|(^|[\\/])\.git([\\/])(config|credentials)$/i },
  { level: 'auto', label: 'certificate and private key files', re: /\.(pem|key|pfx|p12|crt)(\.|$)/i },
  { level: 'auto', label: 'secret store directories', re: /(^|[\\/])\.secret([\\/])|(^|[\\/])secrets?([\\/])|(^|[\\/])\.config([\\/])(gh|hub|glab)([\\/]|$)/i },
  { level: 'auto', label: 'browser credential stores', re: /(Login Data|Cookies|Web Data|keychain|Credential Storage)/i },
  { level: 'auto', label: 'system credential database', re: /(^|[\\/])SAM$|(^|[\\/])SYSTEM$|(^|[\\/])NTUSER\.DAT$/i },
  { level: 'auto', label: 'token and keychain files', re: /(^|[\\/])(tokens?|keys?|creds?)([\\/]|$)|\.(keychain|keyring|token)$/i },
  { level: 'auto', label: 'wallet and crypto keys', re: /(^|[\\/])\.?(bitcoin|litecoin|monero|ethereum|solana)([\\/])|wallet\.dat$/i },
]

/**
 * 检测一个文件/目录路径是否为敏感目标。
 * @param {string} filePath
 * @param {object} [options]
 * @param {string} [options.mode='smart']  GUARD_LEVELS 之一
 * @returns {{ blocked: boolean, reasons: string[], findings: Array<{level:string,label:string}> }}
 */
export function guardFilePath(filePath, { mode = DEFAULT_FILE_GUARD } = {}) {
  const m = normalizeGuardLevel(mode, DEFAULT_FILE_GUARD)
  if (m === 'off') return { blocked: false, reasons: [], findings: [] }
  const text = String(filePath || '').replace(/\\/g, '/')
  if (!text) return { blocked: false, reasons: [], findings: [] }
  const findings = []
  for (const rule of FILE_GUARD_PATTERNS) {
    if (!ruleBlocksAt(rule.level, m)) continue
    if (rule.re.test(text)) findings.push({ level: rule.level, label: rule.label })
  }
  const reasons = findings.map(f => f.label)
  return { blocked: reasons.length > 0, reasons, findings }
}

// ─────────────────────────────────────────────────────────────
// 3. SkillScanner —— 技能包内容安全扫描
// ─────────────────────────────────────────────────────────────
const SKILL_INJECTION_PATTERNS = [
  { label: 'instruction override (ignore previous)', re: /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|messages?|commands?)/i },
  { label: 'instruction override (disregard)', re: /disregard\s+(all\s+)?(previous|prior|above)\s+(instructions?|rules?|prompts?|guidelines?)/i },
  { label: 'system prompt impersonation', re: /(you\s+are\s+now|act\s+as\s+(the\s+)?system|your\s+(new\s+)?system\s+prompt\s+is)\b/i },
  { label: 'system role injection', re: /<\|?(system|developer|im_start|im_end)\|?>/i },
  { label: 'directive to reveal system prompt', re: /(reveal|print|show|dump|leak|output)\s+(your\s+)?(system\s+)?prompt/i },
  { label: 'chain-of-thought extraction', re: /(output|show|reveal)\s+(your\s+)?(chain[- ]of[- ]thought|reasoning|thinking)/i },
  { label: 'fake tool-result injection', re: /<tool_result>|<result>|<function_results>/i },
  { label: 'do-anything override', re: /(do\s+anything|override\s+all|bypass\s+(all\s+)?(safet|securit|guard|polic))/i },
]

const SKILL_SECRET_PATTERNS = [
  { label: 'OpenAI-style API key', re: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { label: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { label: 'AWS access key', re: /\b(AKIA|ASIA)[A-Z0-9]{16}/ },
  { label: 'private key block', re: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/ },
  { label: 'generic bearer token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i },
  { label: 'long high-entropy secret', re: /(api[_-]?key|secret|token|password)\s*[=:]\s*['"]?[A-Za-z0-9._~+/-]{20,}['"]?/i },
  { label: 'stripe/live secret', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/ },
  { label: 'Slack/Telegram bot token', re: /\bxox[baprs]-[A-Za-z0-9-]+|\d{8,10}:[A-Za-z0-9_-]{30,}/ },
]

const SKILL_EXFIL_PATTERNS = [
  { label: 'exfiltrate via webhook POST', re: /\b(curl|wget|Invoke-WebRequest)\b[^;\n]*(-X\s+POST|--data|-d\b|--data-binary|Invoke-RestMethod)/i },
  { label: 'encode-and-send', re: /(base64|ConvertTo-Json|certutil\s+-encode)[^;\n]*(curl|wget|Invoke-WebRequest|nc\s)/i },
  { label: 'external endpoint with data param', re: /\bhttps?:\/\/[^\s"'`]+\?[^\s"'`]*(data|content|payload|token|key)=/i },
  { label: 'sinkhole domain patterns', re: /(webhook\.site|requestbin|pipedream\.net|beeceptor\.com|ngrok\.io)/i },
]

/**
 * 扫描技能包内容（SKILL.md 正文 + frontmatter）。
 * @param {string} content 技能原始文本
 * @param {object} [options]
 * @param {string} [options.mode='warn']  'block' | 'warn' | 'off'
 * @param {string[]} [options.whitelist]  命中该子串时跳过（技能 ID / 名称白名单）
 * @param {string} [options.id]           技能 id，用于白名单匹配
 * @returns {{ verdict: 'block'|'warn'|'ok', findings: Array<{category:string,label:string}>, blocked: boolean }}
 */
export function scanSkillContent(content, { mode = DEFAULT_SKILL_SCAN, whitelist = [], id = '' } = {}) {
  const m = String(mode || '').trim().toLowerCase()
  if (m === 'off') return { verdict: 'ok', findings: [], blocked: false }
  const text = String(content || '')
  if (!text) return { verdict: 'ok', findings: [], blocked: false }

  const white = (whitelist || []).map(s => String(s).trim().toLowerCase()).filter(Boolean)
  const skillId = String(id || '').trim().toLowerCase()
  const isWhitelisted = white.includes(skillId) || white.some(w => skillId.includes(w))
  if (isWhitelisted) return { verdict: 'ok', findings: [], blocked: false }

  const findings = []
  for (const p of SKILL_INJECTION_PATTERNS) {
    if (p.re.test(text)) findings.push({ category: 'injection', label: p.label })
  }
  for (const p of SKILL_SECRET_PATTERNS) {
    if (p.re.test(text)) findings.push({ category: 'secret', label: p.label })
  }
  for (const p of SKILL_EXFIL_PATTERNS) {
    if (p.re.test(text)) findings.push({ category: 'exfiltration', label: p.label })
  }

  const blocked = m === 'block' && findings.length > 0
  return { verdict: blocked ? 'block' : (findings.length ? 'warn' : 'ok'), findings, blocked }
}

// ─── 导出规则集供调试 / 测试 ───
export const __internals = {
  SHELL_RULES, FILE_GUARD_PATTERNS, SKILL_INJECTION_PATTERNS,
  SKILL_SECRET_PATTERNS, SKILL_EXFIL_PATTERNS, SHELL_RULE_STRICTNESS,
}
