// viseme.js —— 文本 → 口型 viseme 序列（真口型数据流）
//
// 用 pinyin-pro 把中文文本转拼音，声母/韵母映射到 Oculus 15 集 viseme
// （与 tiny_mascot.riv 的 mouthVisemeCode 枚举一致），生成与文本等长的
// viseme code 数组。播放时按 audio.currentTime/duration 取当前口型。
//
// 这是「文本驱动」的真实口型：每个字的开口（a→aa / o→oh / u→ou 等）与
// 实际发音节奏对齐，替代原来纯音量模拟的假口型。
// pinyin-pro（~550KB）改为懒加载：仅在构建 viseme 时间线（语音口型）时才动态 import，
// 避免随主页面首屏一起下载。模块级缓存，首次后不再重复加载。

let _pinyinProPromise = null
function loadPinyinPro() {
  if (!_pinyinProPromise) {
    _pinyinProPromise = import('./vendor/pinyin-pro/pinyin-pro.mjs')
  }
  return _pinyinProPromise
}

// 韵母 → viseme：尾元音决定口型（a→大张嘴 aa，o→圆 oh，e→中 E，i/ü→展 ih，u→嘟 ou）
// 鼻韵尾(n/ng)与儿化(r)接近闭口。
function finalToViseme(f) {
  if (!f) return 'sil';
  const last = f[f.length - 1];
  switch (last) {
    case 'a': return 'aa';
    case 'o': return 'oh';
    case 'e': return 'E';
    case 'i': return 'ih';
    case 'u': return 'ou';
    case 'v': return 'ih'; // ü
    case 'n': case 'g': case 'r': return 'nn'; // 鼻/儿韵尾闭口
    default: return 'E';
  }
}

// 单字符 viseme（英文/数字/符号近似）
function asciiViseme(ch) {
  if (/\s/.test(ch)) return 'sil';
  const c = ch.toLowerCase();
  if (c === 'a') return 'aa';
  if (c === 'o') return 'oh';
  if (c === 'i' || c === 'y') return 'ih';
  if (c === 'u') return 'ou';
  if (c === 'e') return 'E';
  if (/[0-9]/.test(c)) return 'sil';
  return 'E';
}

// 把一段非中文串逐字符展开成 viseme
function expandAscii(str, codes) {
  for (const ch of String(str || '')) codes.push(asciiViseme(ch));
}

// 尝试把无空格串当拼音解析（声母+韵母）；成功返回 true
function tryAsPinyin(s, codes, pinyinPro) {
  if (!s || s.length > 6) return false;
  try {
    const parts = pinyinPro.getInitialAndFinal(s);
    if (!parts || !parts.final) return false;
    codes.push(finalToViseme(parts.final) || 'E');
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 文本 → viseme code 数组（每字符一个主口型）。
 */
export async function buildVisemeTimeline(text) {
  const pinyinPro = await loadPinyinPro();
  const { pinyin } = pinyinPro;
  const codes = [];
  let list;
  try {
    // type:'array' → 每汉字一个拼音音节；连续非中文(nonZh:'consecutive')一个元素
    list = pinyin(String(text || ''), { type: 'array', toneType: 'none', v: true, nonZh: 'consecutive' });
  } catch (e) {
    list = [];
  }
  for (const item of list) {
    if (/\s/.test(item)) {
      // 含空格 → 非中文串（英文短语/数字），逐字符近似
      expandAscii(item, codes);
      continue;
    }
    if (!/[a-zA-Zü]/.test(item)) {
      // 纯符号/数字
      expandAscii(item, codes);
      continue;
    }
    // 无空格字母串：优先当拼音（单音节），失败则当英文单词展开
    if (!tryAsPinyin(item, codes, pinyinPro)) {
      expandAscii(item, codes);
    }
  }
  if (!codes.length) codes.push('sil');
  return codes;
}

/**
 * 按播放进度(0-1)取当前 viseme code。
 */
export function getVisemeAt(timeline, progress) {
  if (!timeline || !timeline.length) return 'sil';
  const p = Math.max(0, Math.min(1, Number(progress) || 0));
  const idx = Math.min(timeline.length - 1, Math.floor(p * timeline.length));
  return timeline[idx];
}
