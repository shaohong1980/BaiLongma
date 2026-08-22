// social.js —— 社交平台配置（从 src/config.js 拆出）
// 覆盖 Discord / 飞书 / 微信公众号 / 企业微信 的凭据 + WeChat ClawBot（扫码后自动写入）。
import fs from 'fs'
import { paths } from '../paths.js'
import { patchConfig, readExistingStoredConfig, writeStoredConfig } from './io.js'

const SOCIAL_ENV_KEYS = [
  'DISCORD_BOT_TOKEN',
  'FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_VERIFICATION_TOKEN',
  'WECHAT_OFFICIAL_APP_ID', 'WECHAT_OFFICIAL_APP_SECRET', 'WECHAT_OFFICIAL_TOKEN',
  'WECOM_BOT_KEY', 'WECOM_INCOMING_TOKEN',
]

// ── WeChat ClawBot credentials (written automatically after QR scan, not exposed in SOCIAL_ENV_KEYS) ──

export function getClawbotCredentials() {
  try {
    const stored = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8'))
    const c = stored?.clawbot
    return (c?.accountId && c?.botToken) ? c : null
  } catch { return null }
}

export function setClawbotCredentials({ accountId, botToken, baseUrl }) {
  patchConfig({ clawbot: { accountId, botToken, baseUrl } })
}

export function clearClawbotCredentials() {
  const { clawbot: _, ...rest } = readExistingStoredConfig()
  writeStoredConfig(rest)
}

export function getSocialConfig() {
  let stored = {}
  try { stored = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8'))?.social || {} } catch (err) {
    console.warn('[config] 读取社交配置失败:', err?.message || err)
  }
  const result = {}
  for (const key of SOCIAL_ENV_KEYS) {
    const val = stored[key] || globalThis.process?.env?.[key] || ''
    result[key] = { configured: !!val }
  }
  return result
}

export function setSocialConfig(updates) {
  const existing = readExistingStoredConfig()
  const current = existing.social || {}
  const next = { ...current }
  for (const [key, val] of Object.entries(updates || {})) {
    if (!SOCIAL_ENV_KEYS.includes(key)) continue
    const trimmed = String(val || '').trim()
    if (trimmed) {
      next[key] = trimmed
      // Take effect immediately without restart
      if (globalThis.process?.env) globalThis.process.env[key] = trimmed
    } else {
      delete next[key]
    }
  }
  writeStoredConfig({ ...existing, social: next })
}
