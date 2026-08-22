// voice-rive.js —— 语音球的「脸」：用 OpenHuman 的 Rive 小助手(mascot)替代原有点阵球。
// 同时服务两个场景：
//   ① 悬浮语音球窗口（voice-orb.html）：主窗口经 IPC 每帧推 {状态 sk, 真实音量 vol}，
//     本窗口通过 window.voiceOrb 命令注入（enter/frame/text/exit）。
//   ② 主窗口 brain-ui 语音球（voice-panel.js）：voice-core 保留全部会话逻辑
//     （麦克风/ASR/TTS 打断），渲染器分支每帧把状态+音量推给本渲染器，由它驱动动画。
//
// 资产契约(tiny_mascot.riv，来自 OpenHuman，artboard/stateMachine/viewModel 见 riveMaps.ts):
//   stateMachine: MascotSM
//   viewModel:    ViewModel1
//   inputs:
//     pose            (enum poses)        —— 身体姿势动画
//     mouthVisemeCode (enum visme_codes)  —— 口型(Oculus 15 集)
//     primaryColor / secondaryColor       —— 主题色(默认用资产内值)
//
// 对外接口（两个场景共用）:
//   setStatus(sk) / setExternalVol(v) / startRenderLoop() / stopRenderLoop()
//   isReady() / hasFailed() —— 供外部判断 Rive 加载状态，决定是否显示回退 UI
//
// 低档 lip-sync：speaking 时用真实音量 vol 驱动口型开合（无声闭嘴），无需 viseme 流。
// 将来接入真实 viseme 数据流后，只需把 updateMouth 里 SPEAK_VISEMES 的取值换成 viseme code。

const RIVE_WASM = '/src/ui/brain-ui/vendor/rive/rive.wasm';
const RIVE_FALLBACK_WASM = '/src/ui/brain-ui/vendor/rive/rive_fallback.wasm';
const MASCOT_SRC = '/src/ui/brain-ui/vendor/rive/tiny_mascot.riv';
const MASCOT_STATE_MACHINE = 'MascotSM';

// 资产内 pose 枚举（tiny_mascot.riv 实际导出，比 OpenHuman riveMaps.ts 多一个 recording）
const RIVE_POSES = new Set([
  'celebration', 'thinking', 'bookreading', 'coffeedrink', 'writing',
  'bobbateadrink', 'recording', 'hand_wave', 'dancing', 'idle',
]);

// 语音球状态 → Rive pose
const SK_TO_POSE = {
  idle:        'idle',
  listening:   'recording',   // 在场聆听：录音姿态（资产自带的聆听/录制动画）
  recognizing: 'thinking',    // 识别中 → 思考
  processing:  'thinking',    // Agent 干活 → 思考
  done:        'celebration', // 识别完成确认 → 小小庆祝
  event:       'hand_wave',   // 事件提醒 → 挥手
  error:       'thinking',    // 出错 → 低头思考 + 红色调（颜色比姿势更醒目）
  speaking:    'idle',        // 说话时身体待命，口型由 viseme/音量驱动
};

// 错误状态的红色调：错误时把主/次色切红，恢复时回主题色，让"出错"一眼可辨。
const ERROR_PRIMARY   = { r: 248, g: 113, b: 113 };  // #f87171 danger
const ERROR_SECONDARY = { r: 191, g: 44,  b: 44  };  // #bf2c2c 深红

// 说话时的"发热"亮色：音量越大，主题色向这个亮暖色过渡（角色/头顶球随语音发亮）。
const SPEAK_HOT = { r: 255, g: 205, b: 110 };  // 亮暖黄

// idle 时的 ambient 姿势轮换（让助手"活着"，同时把资产里的 dancing/bookreading
// 等姿势用上）。只在纯空闲态轮换，listening/说话等真实状态不打扰。
const AMBIENT_IDLE_MIN_MS = 6000;
const AMBIENT_IDLE_MAX_MS = 12000;
const AMBIENT_HOLD_MIN_MS = 2500;
const AMBIENT_HOLD_MAX_MS = 5000;
const AMBIENT_POSES = [
  'thinking', 'bookreading', 'coffeedrink', 'writing',
  'bobbateadrink', 'dancing', 'hand_wave', 'celebration',
];

// Oculus 15 集口型枚举（资产内 visme_codes，大小写敏感）
const RIVE_VISEME_SET = [
  'sil', 'PP', 'FF', 'TH', 'DD', 'kk', 'CH', 'SS', 'nn', 'RR', 'aa', 'E', 'ih', 'oh', 'ou',
];

// 说话口型候选：开口元音为主，靠时间抖动自然开合
const SPEAK_VISEMES = ['aa', 'ih', 'ou', 'oh', 'E', 'SS'];

// 音量阈值：低于此视为无声（闭嘴）
const TALK_VOL_THRESHOLD = 0.02;
// 口型换气周期基数(ms)与强度系数：音量越大换口型越快、张嘴越勤
const MOUTH_BASE_PERIOD_MS = 130;
const MOUTH_VOL_INTENSITY = 0.25;

// '#rrggbb'（或 'rrggbb'）→ { r,g,b }（0-255）；无法解析返回 null
function hexToRgb(hex) {
  if (typeof hex !== 'string') return null;
  const m = hex.replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return null;
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}
function randBetween(min, max) { return min + Math.random() * (max - min); }
function pickAmbientPose(exclude) {
  const pool = exclude ? AMBIENT_POSES.filter(p => p !== exclude) : AMBIENT_POSES;
  const list = pool.length ? pool : AMBIENT_POSES;
  return list[Math.min(list.length - 1, Math.floor(Math.random() * list.length))];
}

// ── 加载失败回退：在 canvas 上画一个简单的指示图形 ──
function drawFallback(canvas, text) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.clientWidth || canvas.width || 264;
  const h = canvas.clientHeight || canvas.height || 264;
  const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 3));
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  // 中心小圆点（脉冲感）
  const cx = w / 2, cy = h / 2;
  const r = 18;
  const t = Date.now() / 1000;
  const alpha = 0.35 + 0.15 * Math.sin(t * 2.5);

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(180,170,210,${alpha.toFixed(2)})`;
  ctx.fill();

  // 外圈
  ctx.beginPath();
  ctx.arc(cx, cy, r + 6, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(180,170,210,${(alpha * 0.5).toFixed(2)})`;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // 文字
  if (text) {
    ctx.fillStyle = 'rgba(200,195,220,0.85)';
    ctx.font = '13px -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(text, cx, cy + r + 28);
  }
}

let fallbackRafId = null;
function startFallbackLoop(canvas, text) {
  stopFallbackLoop();
  function loop() {
    drawFallback(canvas, text);
    fallbackRafId = requestAnimationFrame(loop);
  }
  loop();
}
function stopFallbackLoop() {
  if (fallbackRafId) { cancelAnimationFrame(fallbackRafId); fallbackRafId = null; }
}

export function createVoiceRive({ canvas, fallbackCanvas, primaryColor, secondaryColor, onStateChange } = {}) {
  // 失败回退绘制用 fallbackCanvas（独立 2D canvas）——主 canvas 被 Rive 拿 WebGL2 后
  // 无法再 getContext('2d')。未提供 fallbackCanvas 时退回尝试主 canvas。
  const fallbackTarget = fallbackCanvas || canvas;
  // rive.js 由 voice-orb.html 以普通 <script> 标签加载(UMD → window.rive)。
  const riveNs = (typeof window !== 'undefined' && window.rive) || null;

  let sk = 'listening';
  let lastVol = 0;           // 最近一次 setExternalVol 注入的音量
  let ready = false;         // Rive onLoad 已就绪
  let loadFailed = false;

  let rive = null;           // Rive 实例
  let poseInput = null;      // ViewModelInstanceEnum
  let mouthInput = null;     // ViewModelInstanceEnum
  let primaryColorInput = null;   // ViewModelInstanceColor
  let secondaryColorInput = null;

  // 主题色（hex → {r,g,b}）；错误时临时切红，恢复时回这里
  const themePrimary = hexToRgb(primaryColor) || null;
  const themeSecondary = hexToRgb(secondaryColor) || null;

  // 外部注入的真实 viseme code（真口型数据流）；null = 没接，退回音量模拟
  let visemeInput = null;

  // 说话时的颜色呼吸平滑量（0-1）：音量越大角色越亮越暖（头顶球随之变色）
  let speakColorSmooth = 0;

  // idle ambient 姿势轮换
  let ambientTimer = null;
  let ambientPose = null;    // 当前 ambient 姿势（null = 非 ambient）

  let rafId = null;
  let lastBeat = -1;         // 口型节拍索引

  function notifyState() {
    try { onStateChange && onStateChange(getState()); } catch (e) { /* 忽略 */ }
  }

  // Rive 失败 → 显示 fallback canvas（2D 占位），隐藏主 canvas；成功则反之。
  // 主 canvas 被 Rive 拿 WebGL2 后无法再 2D，fallback 必须是独立 canvas。
  function showFallback() {
    if (fallbackCanvas && fallbackCanvas !== canvas) {
      fallbackCanvas.hidden = false;
      canvas.hidden = true;
    }
    startFallbackLoop(fallbackTarget, '语音助手');
  }
  function showRive() {
    if (fallbackCanvas && fallbackCanvas !== canvas) {
      canvas.hidden = false;
      fallbackCanvas.hidden = true;
    }
    stopFallbackLoop();
  }

  // 加载 Rive 运行时并创建实例(懒加载,首次 enter 时才跑)
  function initRive() {
    if (!riveNs) {
      // rive.js 未加载（script 缺失/失败）→ 直接回退占位，避免空白
      showFallback();
      notifyState();
      return;
    }
    if (loadFailed) return;
    try {
      // 本地 wasm：Rive 默认从 unpkg CDN 拉，桌面应用不能依赖外网
      if (riveNs.RuntimeLoader) {
        if (riveNs.RuntimeLoader.getWasmUrl && !riveNs.RuntimeLoader.getWasmUrl().includes('unpkg')) {
          // 已本地化(同窗口只设一次)
        } else if (riveNs.RuntimeLoader.setWasmUrl) {
          riveNs.RuntimeLoader.setWasmUrl(RIVE_WASM);
        }
        if (riveNs.RuntimeLoader.setWasmFallbackUrl) {
          riveNs.RuntimeLoader.setWasmFallbackUrl(RIVE_FALLBACK_WASM);
        }
      }

      const layout = new riveNs.Layout({ fit: riveNs.Fit.Contain });
      rive = new riveNs.Rive({
        canvas,
        src: MASCOT_SRC,
        stateMachines: MASCOT_STATE_MACHINE,
        autoplay: true,
        autoBind: true, // 必须显式开启：否则 ViewModel inputs(pose/口型/颜色)不绑定到 artboard，设置无效
        layout,
        onLoad: () => {
          try {
            // 用 autoBind 已绑定的实例（rive.viewModelInstance），而非新建实例
            const instance = rive && rive.viewModelInstance ? rive.viewModelInstance : null;
            if (instance) {
              poseInput = instance.enum('pose') || null;
              mouthInput = instance.enum('mouthVisemeCode') || null;
              if (instance.color) {
                primaryColorInput = instance.color('primaryColor') || null;
                secondaryColorInput = instance.color('secondaryColor') || null;
              }
            }
          } catch (e) {
            console.warn('[voice-rive] 绑定 ViewModel 失败，只用默认动画:', e);
          }
          ready = true;
          showRive();
          applyStatus(sk);
          notifyState();
          console.info('[voice-rive] 助手就绪 pose=' + (poseInput && poseInput.value) +
            ' mouth=' + (mouthInput && mouthInput.value) +
            ' poses=' + (poseInput && poseInput.values && poseInput.values.join(',')));
        },
        onLoadError: (e) => {
          console.warn('[voice-rive] Rive 资产加载失败，显示回退图形:', e);
          loadFailed = true;
          ready = false;
          showFallback();
          notifyState();
        },
      });
    } catch (e) {
      console.warn('[voice-rive] Rive 初始化失败，显示回退图形:', e);
      loadFailed = true;
      showFallback();
      notifyState();
    }
  }

  function setPose(pose) {
    if (!ready || !rive || !poseInput) return;
    if (RIVE_POSES.has(pose) && poseInput.value !== pose) poseInput.value = pose;
  }

  // 颜色：错误态切红色调，其余用主题色（hex → rgb 已解析）
  function applyColor(newSk) {
    if (!primaryColorInput && !secondaryColorInput) return;
    const p = newSk === 'error' ? ERROR_PRIMARY : themePrimary;
    const s = newSk === 'error' ? ERROR_SECONDARY : themeSecondary;
    if (primaryColorInput && p) { try { primaryColorInput.rgb(p.r, p.g, p.b); } catch (e) {} }
    if (secondaryColorInput && s) { try { secondaryColorInput.rgb(s.r, s.g, s.b); } catch (e) {} }
  }

  // idle ambient 姿势轮换：纯空闲时让助手"活着"，把 dancing/bookreading 等用上
  function stopAmbient() {
    if (ambientTimer) { clearTimeout(ambientTimer); ambientTimer = null; }
    ambientPose = null;
  }
  function scheduleAmbient() {
    stopAmbient();
    if (sk !== 'idle') return;
    ambientTimer = setTimeout(() => {
      ambientTimer = null;
      if (sk !== 'idle') return;
      ambientPose = pickAmbientPose(ambientPose);
      setPose(ambientPose);
      ambientTimer = setTimeout(() => {
        ambientTimer = null;
        if (sk !== 'idle') return;
        ambientPose = null;
        setPose('idle');
        scheduleAmbient();
      }, randBetween(AMBIENT_HOLD_MIN_MS, AMBIENT_HOLD_MAX_MS));
    }, randBetween(AMBIENT_IDLE_MIN_MS, AMBIENT_IDLE_MAX_MS));
  }

  function applyStatus(newSk) {
    if (!ready || !rive) return;
    // idle 且 ambient 轮换中 → 保持 ambient 姿势；否则用驱动姿势
    const pose = newSk === 'idle' && ambientPose
      ? ambientPose
      : (SK_TO_POSE[newSk] || 'idle');
    setPose(pose);
    applyColor(newSk);
    // 非说话态闭嘴；说话态口型交给 updateMouth
    if (newSk !== 'speaking' && mouthInput && mouthInput.value !== 'sil') {
      mouthInput.value = 'sil';
    }
  }

  // 口型：speaking 时优先用外部真实 viseme 数据流；未接入时退回音量模拟开合
  function updateMouth(now) {
    if (!ready || !mouthInput) return;
    if (sk !== 'speaking') {
      lastBeat = -1;
      visemeInput = null;
      if (mouthInput.value !== 'sil') mouthInput.value = 'sil';
      return;
    }
    // 真 viseme 流：外部每帧 setViseme(code)，直接驱动
    if (visemeInput) {
      if (mouthInput.value !== visemeInput) mouthInput.value = visemeInput;
      return;
    }
    // 音量模拟兜底：无声闭嘴
    if (lastVol <= TALK_VOL_THRESHOLD) {
      lastBeat = -1;
      if (mouthInput.value !== 'sil') mouthInput.value = 'sil';
      return;
    }
    const intensity = Math.min(1, lastVol / MOUTH_VOL_INTENSITY);
    const period = MOUTH_BASE_PERIOD_MS - Math.round((1 - intensity) * 45); // 越响换得越快
    const beat = Math.floor(now / period);
    if (beat === lastBeat) return;
    lastBeat = beat;
    const v = intensity < 0.3
      ? 'sil'
      : SPEAK_VISEMES[Math.abs(beat) % SPEAK_VISEMES.length];
    if (mouthInput.value !== v) mouthInput.value = v;
  }

  // 说话时颜色呼吸：音量驱动主题色 → 亮暖色过渡（角色/头顶球随语音发亮）。
  // 快升慢降；非 speaking 或音量归零时回主题色/错误色。
  function updateVoiceColor() {
    if (!primaryColorInput && !secondaryColorInput) return;
    const target = (sk === 'speaking' && lastVol > TALK_VOL_THRESHOLD)
      ? Math.min(1, lastVol / MOUTH_VOL_INTENSITY)
      : 0;
    speakColorSmooth += (target - speakColorSmooth) * (target > speakColorSmooth ? 0.45 : 0.08);
    const t = speakColorSmooth;
    if (t < 0.02) { applyColor(sk); return; }
    if (sk === 'error') { applyColor('error'); return; } // 错误态保持红色，不做呼吸
    const mix = (base) => ({
      r: Math.round(base.r + (SPEAK_HOT.r - base.r) * t),
      g: Math.round(base.g + (SPEAK_HOT.g - base.g) * t),
      b: Math.round(base.b + (SPEAK_HOT.b - base.b) * t),
    });
    if (primaryColorInput && themePrimary) {
      const c = mix(themePrimary);
      try { primaryColorInput.rgb(c.r, c.g, c.b); } catch (e) {}
    }
    if (secondaryColorInput && themeSecondary) {
      const c = mix(themeSecondary);
      try { secondaryColorInput.rgb(c.r, c.g, c.b); } catch (e) {}
    }
  }

  // 每帧对齐 canvas buffer 与 CSS 逻辑尺寸。
  function syncSizeIfNeeded() {
    if (!rive || !canvas) return
    try {
      const cw = canvas.clientWidth, ch = canvas.clientHeight
      if (!(cw > 0 && ch > 0)) return
      const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 3))
      const w = Math.max(1, Math.round(cw * dpr))
      const h = Math.max(1, Math.round(ch * dpr))
      if (canvas.width === w && canvas.height === h) return
      canvas.width = w
      canvas.height = h
      if (rive.resizeToCanvas) rive.resizeToCanvas()
    } catch (e) { /* 尺寸对齐失败不影响渲染 */ }
  }

  function frame(now) {
    syncSizeIfNeeded();
    updateVoiceColor();
    updateMouth(now);
    rafId = requestAnimationFrame(frame);
  }

  function setStatus(newSk) {
    sk = newSk;
    if (!rive && !loadFailed) initRive(); // 首次 enter 触发加载
    applyStatus(sk);
    if (newSk === 'idle') scheduleAmbient(); else stopAmbient();
  }

  function setExternalVol(v) {
    lastVol = (v == null ? 0 : Number(v) || 0);
  }

  // 外部注入真实 viseme code（真口型数据流，每帧调用）
  function setViseme(code) {
    visemeInput = (code && RIVE_VISEME_SET.includes(code)) ? code : null;
  }

  function getState() {
    if (!riveNs) return 'disabled';
    if (loadFailed) return 'failed';
    if (ready) return 'ready';
    return 'loading';
  }

  function startRenderLoop() {
    if (rive && !loadFailed) {
      try { if (!rive.isPlaying) rive.play(); } catch (e) { /* 未加载完成时访问 isPlaying 可能抛错，忽略 */ }
    }
    if (!rive && !loadFailed) initRive();
    if (sk === 'idle' && !ambientTimer) scheduleAmbient();
    if (!rafId) rafId = requestAnimationFrame(frame);
  }

  function stopRenderLoop() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    lastBeat = -1;
    stopAmbient();
    if (rive && !loadFailed) {
      try { if (rive.isPlaying) rive.pause(); } catch (e) { /* 忽略 */ }
    }
  }

  return {
    setStatus, setExternalVol, startRenderLoop, stopRenderLoop,
    setViseme,
    isReady: () => ready,
    hasFailed: () => loadFailed,
    getState,
  };
}
