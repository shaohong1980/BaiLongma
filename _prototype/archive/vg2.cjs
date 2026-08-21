const http = require('http'), fs = require('fs'), path = require('path')
const { chromium } = require('playwright')
const root = process.cwd()
function ct(f){ switch(path.extname(f).toLowerCase()){ case '.html':return 'text/html; charset=utf-8'; case '.js':return 'text/javascript; charset=utf-8'; case '.mjs':return 'text/javascript; charset=utf-8'; case '.css':return 'text/css; charset=utf-8'; case '.json':return 'application/json; charset=utf-8'; default:return 'text/plain; charset=utf-8' } }
function sj(res,b){ res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(b)) }
function sf(res,fp){ try{ const st=fs.statSync(fp); if(!st.isFile()) throw 0; res.writeHead(200,{'Content-Type':ct(fp),'Content-Length':st.size,'Cache-Control':'no-cache'}); fs.createReadStream(fp).pipe(res) }catch{ res.writeHead(404); res.end('nf') } }
const srv = http.createServer((req,res)=>{
  const u = new URL(req.url, 'http://x')
  if (u.pathname==='/'||u.pathname==='/brain-ui'){ sf(res, path.join(root,'brain-ui.html')); return }
  if (u.pathname==='/vendor/d3/d3.min.js'){ sf(res, path.join(root,'node_modules','d3','dist','d3.min.js')); return }
  if (u.pathname.startsWith('/src/ui/')){ const rel=decodeURIComponent(u.pathname.slice('/src/ui/'.length)); const fp=path.resolve(path.join(root,'src','ui'), rel); if(!fp.startsWith(path.resolve(path.join(root,'src','ui')))){ res.writeHead(403); res.end('f'); return } sf(res, fp); return }
  if (u.pathname==='/agent-profile'){ sj(res,{name:'爻台'}); return }
  if (u.pathname==='/memories'){ 
    const rows = Array.from({length: 10}, (_,i)=>({id:i+1, mem_id:'m'+i, title:'记忆'+i, event_type: i%2?'knowledge':'fact', content:'内容'+i, detail:'', created_at:new Date().toISOString()}));
    sj(res, rows); return }
  if (u.pathname==='/conversations'){ sj(res,[]); return }
  if (u.pathname==='/audit/stats'){ sj(res,{windowHours:1,sinceIso:new Date().toISOString(),recall:{},extract:{}}); return }
  if (u.pathname==='/docs'){ sj(res,{ok:true,topics:[]}); return }
  if (u.pathname.startsWith('/docs/')){ sj(res,{ok:true,doc:{id:'x',title:'D',body:''}}); return }
  if (u.pathname==='/aivideo/history'){ sj(res,{ok:true,jobs:[]}); return }
  if (u.pathname==='/settings'){ sj(res,{llm:{activated:true,provider:'deepseek',model:'smoke',models:[{id:'smoke',label:'S'}]},providers:{deepseek:{models:[{id:'smoke',label:'S'}]}},minimax:{configured:false}}); return }
  if (u.pathname==='/settings/tts'){ sj(res,{ok:true,tts:{ttsProvider:'minimax',ttsVoiceId:'x'},providers:[{id:'minimax',label:'M',streaming:false}],voices:{minimax:[{id:'x',label:'X'}]}}); return }
  if (u.pathname==='/hotspots'){ sj(res,{ok:true,refreshMinutes:30,fetchedAt:new Date().toISOString(),stale:false,platforms:{douyin:[]}}); return }
  if (u.pathname==='/person-card'||u.pathname==='/person-card-state'){ sj(res,{ok:true,state:{active:true}}); return }
  if (u.pathname==='/workbench'){ sj(res,{pending:[],done:[],reviews:[],currentWeekKey:'2026-W33'}); return }
  if (u.pathname==='/workbench/todos'){ sj(res,[]); return }
  if (u.pathname==='/workbench/reviews'){ sj(res,[]); return }
  if (u.pathname==='/task'){ sj(res,{tasks:[]}); return }
  if (u.pathname==='/agents'){ sj(res,{agents:[]}); return }
  if (u.pathname==='/room'){ sj(res,{messages:[],round:0}); return }
  if (u.pathname==='/room/message'){ sj(res,{ok:true,responses:[]}); return }
  if (u.pathname==='/room/reset'||u.pathname==='/map/status'){ sj(res,{ok:true}); return }
  if (u.pathname==='/version'){ sj(res,{version:'s',update:null}); return }
  if (u.pathname==='/insights'){ sj(res,{ok:true,report:{}}); return }
  if (u.pathname==='/skills'||u.pathname==='/mcp'||u.pathname==='/mcp/presets'){ sj(res,{ok:true,skills:[],servers:[],presets:[]}); return }
  if (u.pathname==='/health'){ sj(res,{ok:true}); return }
  sj(res,{ok:true})
})
srv.listen(0,'127.0.0.1', async ()=>{
  const port = srv.address().port
  const browser = await chromium.launch({ executablePath:'C:/Users/1/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe', headless:true })
  const page = await browser.newPage({ viewport:{ width:1920, height:990 } })
  const errors=[]
  page.on('pageerror', e=>errors.push('PAGEERR: '+e.message))
  page.on('console', m=>{ if(m.type()==='error') errors.push(m.text()) })
  await page.goto('http://127.0.0.1:'+port+'/brain-ui', { waitUntil:'networkidle' })
  await page.waitForTimeout(3500)
  const info = await page.evaluate(()=>{
    const s = window.__knowledgeSphere
    return {
      sphereReady: !!s,
      nodes: s ? s.nodes.length : null,
      spriteMapSize: s ? s.spriteMap.size : null,
      nodeDataLen: (typeof window !== 'undefined' && window.__nodeDataLen) || null,
    }
  })
  // 点八卦图放大
  await page.evaluate(()=>{ document.getElementById('voice-canvas').dispatchEvent(new MouseEvent('click',{bubbles:true})) })
  await page.waitForTimeout(800)
  const enlarged = await page.evaluate(()=>{
    const s = window.__knowledgeSphere
    const c = document.getElementById('graph')
    return { enlarged: c.classList.contains('enlarged'), spriteMapSize: s? s.spriteMap.size : null, canvasW: c.width, canvasH: c.height }
  })
  await page.screenshot({ path:'vg2.png', fullPage:true })
  console.log('INFO:', JSON.stringify(info))
  console.log('ENLARGED:', JSON.stringify(enlarged))
  console.log('JS ERRORS:', errors.filter(e=>!e.includes('EventSource')&&!e.includes('WebSocket')&&!e.includes('scene')).slice(0,8)||'none')
  await browser.close(); srv.close()
})
