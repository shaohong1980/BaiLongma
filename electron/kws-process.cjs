// kws-process.cjs —— 语音唤醒(KWS)子进程,跑在 Electron utilityProcess 里
//
// 为什么要独立进程:sherpa-onnx 自带一份 onnxruntime,而后端 @huggingface/transformers
// 走 onnxruntime-node 另带一份;同一进程加载两份 onnxruntime 会在构建会话时原生崩溃
// (已用 probe 坐实)。把 KWS 隔离到只加载 sherpa 的独立进程,从根上消除冲突。
//
// 协议(parentPort):
//   收 {type:'init', modelDir, logFile}  → 构建 KeywordSpotter,回 {type:'ready'} / {type:'error'}
//   收 {type:'pcm',  buf:ArrayBuffer}    → 喂 16kHz Float32,命中则写日志 + 回 {type:'hit', keyword}
const path = require('path')
const fs = require('fs')
// utilityProcess 子进程通过 process.parentPort 与主进程通信
const parentPort = process.parentPort

const KEYWORDS_THRESHOLD = 0.35 // 从 0.25 上调到 0.35，减少误触发
const KEYWORDS_SCORE = 3.0      // 实测 score=3 召回最佳(13/17 vs 2.0 的 9/17)
const COOLDOWN_MS = 800 // 命中后冷却:去重一次唤醒的多帧结果,又允许~1s 间隔的重试都触发

let spotter = null
let stream = null
let sherpa = null
let logFile = null
let lastHitAt = 0

function appendLog(msg) {
  if (!logFile) return
  try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`) } catch {}
}

// 加载 sherpa-onnx 并用 kws-model 目录下的 transducer 模型 + keywords.txt 构建 KeywordSpotter。
function buildSpotter(modelDir) {
  sherpa = require('sherpa-onnx-node')
  const config = {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: path.join(modelDir, 'encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx'),
        decoder: path.join(modelDir, 'decoder-epoch-13-avg-2-chunk-16-left-64.onnx'),
        joiner: path.join(modelDir, 'joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx'),
      },
      tokens: path.join(modelDir, 'tokens.txt'),
    },
    keywordsFile: path.join(modelDir, 'keywords.txt'),
    keywordsScore: KEYWORDS_SCORE,
    keywordsThreshold: KEYWORDS_THRESHOLD,
    maxActivePaths: 4,
  }
  spotter = new sherpa.KeywordSpotter(config)
  stream = spotter.createStream()
}

parentPort.on('message', (msg) => {
  if (!msg) return
  if (msg.type === 'init') {
    try {
      logFile = msg.logFile
      buildSpotter(msg.modelDir)
      appendLog('KWS ready: ' + msg.modelDir)
      parentPort.postMessage({ type: 'ready' })
    } catch (err) {
      appendLog('KWS init error: ' + (err?.message || err))
      parentPort.postMessage({ type: 'error', error: err?.message || String(err) })
    }
    return
  }
  if (msg.type === 'pcm' && spotter && stream) {
    try {
      const samples = new Float32Array(msg.buf)
      stream.acceptWaveform({ samples, sampleRate: 16000 })
      while (spotter.isReady(stream)) {
        spotter.decode(stream)
        const result = spotter.getResult(stream)
        if (result && result.token) {
          const now = Date.now()
          if (now - lastHitAt >= COOLDOWN_MS) {
            lastHitAt = now
            appendLog('hit: ' + result.token)
            parentPort.postMessage({ type: 'hit', keyword: result.token })
          }
        }
      }
    } catch (err) {
      appendLog('pcm error: ' + (err?.message || err))
    }
    return
  }
})