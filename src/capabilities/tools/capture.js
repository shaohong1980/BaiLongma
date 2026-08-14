// capture_screen —— 桌面截图（P1-4）
// 在 Windows 上用 PowerShell 捕获主屏幕，存到 sandbox/screenshots/，
// 返回路径供主 Agent 用 analyze_image 做视觉理解。
import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { paths } from '../../paths.js'

function toolJson(obj) { return JSON.stringify(obj, null, 2) }

function ensureDir() {
  const dir = path.join(paths.sandboxDir, 'screenshots')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function execCaptureScreen(args = {}) {
  const dir = ensureDir()
  const name = String(args.screenshot_name || 'screen').replace(/[^\w-]/g, '_')
  const filePath = path.join(dir, `${name}-${Date.now()}.png`)

  const psScript = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
    `$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)`,
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)',
    `$bmp.Save('${filePath.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    '$g.Dispose(); $bmp.Dispose()',
  ].join('; ')

  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
      timeout: 15000,
      stdio: 'pipe',
      windowsHide: true,
    })
  } catch (err) {
    return toolJson({ ok: false, tool: 'capture_screen', error: '截图失败：' + (err.message || String(err)), hint: '可能无显示器/远程会话/无 PowerShell。桌面应用需在物理桌面运行。' })
  }

  if (!fs.existsSync(filePath)) {
    return toolJson({ ok: false, tool: 'capture_screen', error: '截图文件未生成', hint: '请确认在物理桌面环境运行。' })
  }
  const stat = fs.statSync(filePath)
  const rel = path.relative(paths.sandboxDir, filePath).split(path.sep).join('/')
  return toolJson({
    ok: true,
    tool: 'capture_screen',
    screenshot_path: 'sandbox/' + rel,
    bytes: stat.size,
    hint: '截图已保存。用 analyze_image(image_path) 查看并描述屏幕内容，或 read_file 获取路径。',
  })
}
