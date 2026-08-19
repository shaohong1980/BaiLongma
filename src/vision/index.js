// vision/index.js —— 视觉输入辅助模块（P0: 多模态）
//
// 功能：
//   1. 从本地图片路径或 URL 构建多模态消息内容（OpenAI content 数组格式）
//   2. 图片转 base64 data URL（支持本地文件）
//   3. 检测当前模型是否支持视觉，不支持时自动路由
//   4. 图片大小压缩（超过阈值时提示或自动缩小）

import fs from 'fs'
import path from 'path'
import { paths } from '../paths.js'
import { modelSupportsVision, getVisionModelForProvider, messageHasImageContent } from '../config/models.js'

// 视觉内容检测：多模态 content 数组是否含图片（供 llm.js 复用）
export { messageHasImageContent }

const MAX_IMAGE_BYTES = 5 * 1024 * 1024  // 5MB
const SUPPORTED_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])

function toolJson(payload) {
  return JSON.stringify(payload, null, 2)
}

// 检测文件是否为图片
export function isImageFile(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  return SUPPORTED_IMAGE_EXTS.has(ext)
}

// 允许的本地图片读取根目录：沙箱 / 媒体目录 / 用户数据目录（阻止从消息 API 读取任意系统文件）
const IMAGE_ALLOWED_ROOTS = [
  () => paths.sandboxDir,
  () => paths.mediaDir,
  () => paths.userDir,
].map(get => { try { return path.resolve(get()) } catch { return null } }).filter(Boolean)

export function isSafeLocalImagePath(filePath) {
  if (!filePath) return false
  const resolved = path.resolve(String(filePath))
  return IMAGE_ALLOWED_ROOTS.some(root => {
    try { return resolved === root || resolved.startsWith(root + path.sep) } catch { return false }
  })
}

// 本地图片转 base64 data URL
export function imageToDataUrl(filePath, { allowOutsideSandbox = false } = {}) {
  if (!isSafeLocalImagePath(filePath) && !allowOutsideSandbox) {
    return { ok: false, error: `仅允许读取沙箱 / 媒体目录内的图片: ${filePath}` }
  }
  if (!fs.existsSync(filePath)) {
    return { ok: false, error: `文件不存在: ${filePath}` }
  }
  const stat = fs.statSync(filePath)
  if (stat.size > MAX_IMAGE_BYTES) {
    return { ok: false, error: `图片过大（${(stat.size / 1024 / 1024).toFixed(1)}MB，上限 5MB）` }
  }
  const ext = path.extname(filePath).toLowerCase()
  const mimeMap = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
  }
  const mime = mimeMap[ext] || 'image/png'
  const base64 = fs.readFileSync(filePath).toString('base64')
  return { ok: true, dataUrl: `data:${mime};base64,${base64}`, size: stat.size, mime }
}

// 构建多模态消息内容（文本 + 图片）
// images: 数组，每个元素是 { url: 'http...' 或 'data:...' , detail: 'low'|'high'|'auto' }
// text: 伴随文本
export function buildMultimodalContent({ text = '', images = [] } = {}) {
  const content = []
  if (text && text.trim()) {
    content.push({ type: 'text', text: text.trim() })
  }
  for (const img of images) {
    if (!img?.url) continue
    content.push({
      type: 'image_url',
      image_url: {
        url: img.url,
        detail: img.detail || 'auto',
      },
    })
  }
  return content
}

// 从本地图片文件构建多模态内容（自动转 base64）
export function buildMultimodalFromFiles({ text = '', imagePaths = [] } = {}) {
  const images = []
  const errors = []
  for (const p of imagePaths) {
    const result = imageToDataUrl(p)
    if (result.ok) {
      images.push({ url: result.dataUrl })
    } else {
      errors.push({ path: p, error: result.error })
    }
  }
  const content = buildMultimodalContent({ text, images })
  return { content, images: images.length, errors }
}

// 检测并准备视觉路由：如果当前模型不支持视觉但消息含图片，返回推荐的视觉模型
export function resolveVisionModel({ currentModel, provider, hasImage } = {}) {
  if (!hasImage) return { needSwitch: false, model: currentModel }
  if (modelSupportsVision(currentModel, provider)) {
    return { needSwitch: false, model: currentModel }
  }
  const visionModel = getVisionModelForProvider(provider)
  if (visionModel) {
    return { needSwitch: true, model: visionModel, reason: `当前模型 ${currentModel} 不支持视觉输入，自动切换到 ${visionModel}` }
  }
  return { needSwitch: false, model: currentModel, warning: `当前模型 ${currentModel} 不支持视觉输入，且 provider ${provider} 没有可用的视觉模型。图片可能被忽略。` }
}

// 保存上传的图片到 mediaDir，返回可访问的路径
export function saveUploadedImage(buffer, originalName) {
  try {
    const ext = path.extname(originalName).toLowerCase() || '.png'
    if (!SUPPORTED_IMAGE_EXTS.has(ext)) {
      return { ok: false, error: `不支持的图片格式: ${ext}` }
    }
    const timestamp = Date.now()
    const random = Math.random().toString(36).slice(2, 8)
    const filename = `upload_${timestamp}_${random}${ext}`
    const savePath = path.join(paths.mediaDir, filename)
    fs.writeFileSync(savePath, buffer)
    return { ok: true, path: savePath, filename, size: buffer.length }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

// 工具：analyze_image —— 让 Agent 能主动分析沙箱内的图片
// 这个工具会构建多模态消息并调用 LLM（走 runSimpleCompletion）
export async function analyzeImage({ imagePath, prompt = '描述这张图片的内容' } = {}) {
  if (!imagePath) return toolJson({ ok: false, error: '缺少 imagePath' })

  const dataUrlResult = imageToDataUrl(imagePath)
  if (!dataUrlResult.ok) {
    return toolJson({ ok: false, error: dataUrlResult.error })
  }

  // 动态导入避免循环依赖
  const { runSimpleCompletion } = await import('../llm.js')
  const { config } = await import('../config.js')

  const visionCheck = resolveVisionModel({
    currentModel: config.model,
    provider: config.provider,
    hasImage: true,
  })

  const messages = [
    { role: 'system', content: '你是一个图片分析助手。请仔细观察图片并回答用户的问题。' },
    {
      role: 'user',
      content: buildMultimodalContent({
        text: prompt,
        images: [{ url: dataUrlResult.dataUrl }],
      }),
    },
  ]

  try {
    const reply = await runSimpleCompletion({
      messages,
      temperature: 0.3,
      maxTokens: 2000,
      model: visionCheck.model,
    })
    return toolJson({
      ok: true,
      image: path.basename(imagePath),
      model_used: visionCheck.model,
      model_switched: visionCheck.needSwitch,
      analysis: reply,
    })
  } catch (err) {
    return toolJson({
      ok: false,
      error: `图片分析失败: ${err.message}`,
      hint: visionCheck.warning || '请确认当前模型支持视觉输入，或切换到 gpt-4o / qwen-vl / moonshot-vision 等视觉模型。',
    })
  }
}
