import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { chromium } = require('playwright')
const fs = require('fs')

const browser = await chromium.launch({
  executablePath: 'C:/Users/1/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe',
  args: ['--enable-unsafe-swiftshader'],
})
const page = await browser.newPage()
await page.addInitScript(() => { window.__rivProbe = null })
await page.setContent('<canvas id="c" width="300" height="300"></canvas>')
await page.addScriptTag({ path: 'D:/BaiLongma/src/ui/brain-ui/vendor/rive/rive.js' })
await page.waitForTimeout(500)

const result = await page.evaluate(() => {
  const { Rive, RuntimeLoader } = window.rive
  const wasmUrl = RuntimeLoader.getWasmUrl ? RuntimeLoader.getWasmUrl() : null
  // 用本地 wasm
  RuntimeLoader.setWasmUrl && RuntimeLoader.setWasmUrl('http://127.0.0.1:3721/src/ui/brain-ui/vendor/rive/rive.wasm')
  return new Promise((resolve) => {
    const rive = new Rive({
      canvas: document.getElementById('c'),
      src: 'http://127.0.0.1:3721/src/ui/brain-ui/vendor/rive/tiny_mascot.riv',
      stateMachines: 'MascotSM',
      autoplay: false,
      onLoad: () => {
        try {
          const vm = rive.viewModelByName('ViewModel1')
          const props = vm ? vm.properties : []
          const out = []
          for (const p of props) {
            const kind = (p.runtimeType && p.runtimeType.name) || String(p.type || p.runtimeType || '')
            const name = p.name || ''
            let vals = null
            if (p.dataEnum && p.dataEnum.values) vals = p.dataEnum.values
            out.push({ name, kind, values: vals })
          }
          resolve({ ok: true, viewModelCount: rive.viewModelCount, props: out, wasmUrl })
        } catch (e) {
          resolve({ ok: false, err: String(e) })
        }
      },
      onLoadError: (e) => resolve({ ok: false, loadError: String(e) }),
    })
    setTimeout(() => resolve({ ok: false, timeout: true }), 15000)
  })
})
console.log(JSON.stringify(result, null, 2))
await browser.close()
