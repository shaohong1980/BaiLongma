import fs from 'fs'
import path from 'path'
import { paths } from '../../paths.js'
import { getMediaHistory, upsertMediaHistory, listMusicLibrary, upsertMusicTrack } from '../../db.js'
import { execGenerateVideo, getVideoHistory, saveGeneratedVideo, scanMusicDirIntoLibrary } from '../../capabilities/tools/media.js'
import { mimeFromChatMediaExt } from '../../chat-media.js'
import { isPathInside, jsonResponse, readJsonBody } from '../utils.js'

function streamFile(req, res, filePath, contentType, { cacheControl = 'no-cache', range = false } = {}) {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) {
      res.writeHead(404)
      res.end('media not found')
      return
    }
    const total = stat.size
    const rangeHeader = range ? req.headers.range : null
    if (rangeHeader) {
      const m = rangeHeader.match(/bytes=(\d*)-(\d*)/)
      const start = m?.[1] ? parseInt(m[1]) : 0
      const end = m?.[2] ? parseInt(m[2]) : total - 1
      res.writeHead(206, {
        'Content-Type': contentType,
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Cache-Control': cacheControl,
      })
      fs.createReadStream(filePath, { start, end }).pipe(res)
    } else {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': total,
        ...(range ? { 'Accept-Ranges': 'bytes' } : {}),
        'Cache-Control': cacheControl,
      })
      fs.createReadStream(filePath).pipe(res)
    }
  } catch {
    res.writeHead(404)
    res.end('media not found')
  }
}

function ensureInside(res, root, filePath, { allowRoot = true } = {}) {
  if (isPathInside(root, filePath) && (allowRoot || path.resolve(root) !== path.resolve(filePath))) return true
  res.writeHead(403)
  res.end('forbidden')
  return false
}

export async function handleMediaRoutes(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/media/history') {
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '30'), 100)
    jsonResponse(res, 200, getMediaHistory(limit))
    return true
  }

  if (req.method === 'POST' && url.pathname === '/media/history') {
    try {
      const body = await readJsonBody(req)
      if (!body.url || !body.kind) {
        jsonResponse(res, 400, { ok: false, error: 'url and kind required' })
        return true
      }
      upsertMediaHistory(body)
      jsonResponse(res, 200, { ok: true })
    } catch (e) {
      jsonResponse(res, 400, { ok: false, error: e.message })
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/aivideo/generate') {
    try {
      const body = await readJsonBody(req, { maxBytes: 30 * 1024 * 1024 })
      const result = await execGenerateVideo({
        action: 'generate',
        prompt: body.prompt,
        images: Array.isArray(body.images) ? body.images : undefined,
        image_url: body.image_url || body.image,
        ratio: body.ratio,
        resolution: body.resolution,
        duration: body.duration,
      })
      const parsed = typeof result === 'string' ? JSON.parse(result) : result
      jsonResponse(res, parsed.ok ? 200 : 400, parsed)
    } catch (e) {
      const status = e.statusCode === 413 ? 413 : 400
      const message = e.statusCode === 413 ? 'Request body too large. Please keep images under about 18MB.' : e.message
      jsonResponse(res, status, { ok: false, error: message })
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/aivideo/draft') {
    try {
      const body = await readJsonBody(req, { maxBytes: 256 * 1024 })
      const { setAIVideoPanelState } = await import('../../capabilities/tools/media.js')
      setAIVideoPanelState({ open: body.open, prompt: body.prompt })
      jsonResponse(res, 200, { ok: true })
    } catch (e) {
      jsonResponse(res, e.statusCode === 413 ? 413 : 400, { ok: false, error: e.message })
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/aivideo/save') {
    try {
      const body = await readJsonBody(req)
      const result = saveGeneratedVideo(body.jobId)
      jsonResponse(res, result.ok ? 200 : 400, result)
    } catch (e) {
      jsonResponse(res, 400, { ok: false, error: e.message })
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/aivideo/history') {
    try {
      jsonResponse(res, 200, { ok: true, jobs: getVideoHistory() })
    } catch (e) {
      jsonResponse(res, 200, { ok: false, jobs: [], error: e.message })
    }
    return true
  }

  // ── 音乐库 API（供前端音乐面板直接浏览/扫描/添加本地曲库）──
  if (req.method === 'GET' && url.pathname === '/media/music/library') {
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100'), 300)
    const rows = listMusicLibrary(limit).map(t => ({
      id: t.id,
      title: t.title,
      artist: t.artist || '',
      album: t.album || '',
      lrc: t.lrc || '',
      url: '/media/music/' + encodeURIComponent(path.basename(t.file_path || '')),
    }))
    jsonResponse(res, 200, { ok: true, count: rows.length, tracks: rows })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/media/music/scan') {
    const added = scanMusicDirIntoLibrary(paths.musicDir)
    jsonResponse(res, 200, { ok: true, scanned: added.length, tracks: added })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/media/music/add') {
    try {
      const body = await readJsonBody(req)
      const filePath = String(body.path || '').trim()
      if (!filePath) { jsonResponse(res, 400, { ok: false, error: 'path required' }); return true }
      if (!fs.existsSync(filePath)) { jsonResponse(res, 400, { ok: false, error: `file not found: ${filePath}` }); return true }
      const base = path.basename(filePath)
      const ext = path.extname(base).toLowerCase()
      const MIME_AUDIO = new Set(['.mp3', '.flac', '.wav', '.aac', '.ogg', '.m4a', '.opus'])
      if (!MIME_AUDIO.has(ext)) { jsonResponse(res, 400, { ok: false, error: `unsupported audio format: ${ext}` }); return true }
      const clean = base.replace(/\.(mp3|flac|wav|aac|ogg|m4a|opus)$/i, '').trim()
      const parts = clean.split(/\s+-\s+/).map(p => p.trim()).filter(Boolean)
      const track = upsertMusicTrack({
        title: String(body.title || (parts.length >= 2 ? parts.slice(1).join(' - ') : clean)),
        artist: String(body.artist || (parts.length >= 2 ? parts[0] : '')),
        album: String(body.album || ''),
        filePath,
      })
      jsonResponse(res, 200, { ok: true, track })
    } catch (e) {
      jsonResponse(res, 400, { ok: false, error: e.message })
    }
    return true
  }

  if (req.method === 'GET' && url.pathname.startsWith('/media/music/')) {
    const raw = url.pathname.slice('/media/music/'.length)
    const filename = path.basename(decodeURIComponent(raw))
    const filePath = path.join(paths.musicDir, filename)
    if (!ensureInside(res, paths.musicDir, filePath)) return true
    const mimeMap = {
      '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav',
      '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
      '.opus': 'audio/ogg; codecs=opus',
    }
    const contentType = mimeMap[path.extname(filename).toLowerCase()] || 'audio/mpeg'
    streamFile(req, res, filePath, contentType, { range: true })
    return true
  }

  if (req.method === 'GET' && url.pathname.startsWith('/media/video/')) {
    const raw = url.pathname.slice('/media/video/'.length)
    const filename = path.basename(decodeURIComponent(raw))
    const videoDir = path.join(paths.sandboxDir, 'videos')
    const filePath = path.join(videoDir, filename)
    if (!ensureInside(res, videoDir, filePath)) return true
    const mimeMap = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' }
    const contentType = mimeMap[path.extname(filename).toLowerCase()] || 'video/mp4'
    streamFile(req, res, filePath, contentType, { range: true })
    return true
  }

  if (req.method === 'GET' && url.pathname.startsWith('/media/chat/')) {
    const raw = url.pathname.slice('/media/chat/'.length)
    const filename = path.basename(decodeURIComponent(raw))
    const mediaDir = paths.mediaDir
    const filePath = path.join(mediaDir, filename)
    if (!ensureInside(res, mediaDir, filePath, { allowRoot: false })) return true
    const contentType = mimeFromChatMediaExt(path.extname(filename).toLowerCase())
    streamFile(req, res, filePath, contentType, { cacheControl: 'public, max-age=31536000, immutable' })
    return true
  }

  if (req.method === 'GET' && url.pathname.startsWith('/audio/')) {
    const filename = path.basename(url.pathname)
    const filePath = path.join(paths.sandboxDir, 'audio', filename)
    streamFile(req, res, filePath, 'audio/mpeg')
    return true
  }

  return false
}
