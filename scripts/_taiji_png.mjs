import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { chromium } from 'playwright'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
function ct(fp){const m={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8'};return m[path.extname(fp)]||'text/plain; charset=utf-8'}
function sendFile(res,fp){try{const st=fs.statSync(fp);res.writeHead(200,{'Content-Type':ct(fp),'Content-Length':st.size});fs.createReadStream(fp).pipe(res)}catch{res.writeHead(404);res.end('nf')}}
const server=http.createServer((req,res)=>{const u=new URL(req.url,'http://127.0.0.1');if(u.pathname==='/'){sendFile(res,path.join(root,'brain-ui.html'));return}if(u.pathname.startsWith('/src/ui/brain-ui/')){sendFile(res,path.join(root,'src','ui','brain-ui',decodeURIComponent(u.pathname.slice('/src/ui/brain-ui/'.length))));return}res.writeHead(404);res.end('nf')})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const port=server.address().port
const browser=await chromium.launch({executablePath:'C:/Users/1/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe'})
const page=await browser.newPage()
try{
  await page.goto(`http://127.0.0.1:${port}/`,{waitUntil:'domcontentloaded'})
  // 直接 import 模块的 createVoiceBagua，但只渲染太极(冻结旋转)到 400px PNG
  const result = await page.evaluate(async () => {
    const mod = await import('/src/ui/brain-ui/voice-bagua.js')
    // 用模块内部逻辑手画(rot=0, 大尺寸)
    // 但我们无法访问内部 drawTaiji。改为: 从 createVoiceBagua 导出的 debug 不可用。
    // 改为直接在 evaluate 里复制模块 drawTaiji 逻辑(rot=0)渲染
    function hexToRgb(hex){const m=hex.replace('#','').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);return m?{r:parseInt(m[1],16),g:parseInt(m[2],16),b:parseInt(m[3],16)}:null}
    function rgba(c,a){return `rgba(${c.r},${c.g},${c.b},${a})`}
    function drawTaiji(ctx,cx,cy,r,yin,yang,rim){
      ctx.save();ctx.translate(cx,cy);
      ctx.fillStyle=yang;ctx.beginPath();ctx.arc(0,0,r,-Math.PI/2,Math.PI/2);ctx.closePath();ctx.fill();
      ctx.fillStyle=yin;ctx.beginPath();ctx.arc(0,0,r,Math.PI/2,Math.PI*3/2);ctx.closePath();ctx.fill();
      ctx.beginPath();ctx.arc(r/2,0,r/2,Math.PI,Math.PI*2);ctx.closePath();ctx.fill();
      ctx.fillStyle=yang;ctx.beginPath();ctx.arc(-r/2,0,r/2,0,Math.PI);ctx.closePath();ctx.fill();
      ctx.fillStyle=yang;ctx.beginPath();ctx.arc(r/2,0,r*0.16,0,Math.PI*2);ctx.fill();
      ctx.fillStyle=yin;ctx.beginPath();ctx.arc(-r/2,0,r*0.16,0,Math.PI*2);ctx.fill();
      ctx.restore();
    }
    const c=document.createElement('canvas');c.width=400;c.height=400
    const ctx=c.getContext('2d')
    ctx.fillStyle='rgba(20,26,40,1)';ctx.fillRect(0,0,400,400)
    drawTaiji(ctx,200,200,180,rgba(hexToRgb('#182448'),0.95),rgba(hexToRgb('#f5ebd7'),0.96),{r:255,g:200,b:140})
    return c.toDataURL('image/png')
  })
  const b = Buffer.from(result.split(',')[1], 'base64')
  fs.writeFileSync('scripts/_taiji.png', b)
  console.log('saved', b.length, 'bytes')
}catch(e){console.log('CAUGHT:',e.message)}
finally{await browser.close();server.close()}
