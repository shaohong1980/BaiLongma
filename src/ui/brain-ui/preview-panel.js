// preview-panel.js —— 文件预览面板（AionUi Preview Panel 思路，vanilla JS 复刻）
//
// 打开方式：
//   1. 导航栏 👁 按钮 / 快捷键 P
//   2. 后端 preview_file 工具 → SSE `preview_file_mode` → openPreviewPanel(true, path)
//   3. 输入框直接填 sandbox 内路径，回车预览
//
// 支持的预览：图片 / PDF / Markdown / 代码与文本 / HTML（沙箱 iframe）/ Diff / 音视频。
// 纯前端 + 后端 /preview/* 接口，零新增依赖。
import { API } from './api-client.js'
import { renderMarkdown } from './markdown.js'

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}

const q = (id) => document.getElementById(id)
const rawUrl = (rel) => `${API}/preview/raw?path=${encodeURIComponent(rel)}`

function hideAll(el) {
  for (const child of el.children) child.hidden = true
}

export function openPreviewPanel(active, path = "") {
  const panel = q("preview-panel");
  if (!panel) return;
  if (active) {
    document.body.classList.add("preview-mode");
    if (path) {
      const input = q("preview-path-input");
      if (input) input.value = path;
      loadPreview(path);
    }
  } else {
    document.body.classList.remove("preview-mode");
  }
}

async function loadPreview(relPath) {
  const raw = String(relPath || "").trim();
  if (!raw) return;
  const stage = q("preview-stage");
  const status = q("preview-status");
  const loading = q("preview-loading");
  const empty = q("preview-empty");
  const fileLabel = q("preview-file-label");
  if (!stage) return;

  // 归一化：去掉可能的 sandbox/ 前缀，确保传给后端的是相对路径
  let rel = raw.replace(/^sandbox[\\/]/i, "").replace(/^[\\/]+/, "");
  status.hidden = true;
  loading.hidden = false;
  empty.hidden = true;
  hideAll(stage);
  fileLabel.textContent = rel;

  try {
    const meta = await fetch(`${API}/preview/meta?path=${encodeURIComponent(rel)}`).then(r => r.json());
    if (!meta || !meta.ok) {
      loading.hidden = true;
      empty.hidden = false;
      empty.textContent = `无法预览：${(meta && meta.error) || "文件不存在或路径非法"}`;
      return;
    }
    fileLabel.textContent = `${meta.rel} · ${formatSize(meta.size)}`;
    if (meta.sensitive) {
      loading.hidden = true;
      showUnsupported("敏感文件已拦截", "该路径命中 FileGuard 敏感文件策略，不允许预览。");
      return;
    }
    switch (meta.kind) {
      case "image": showImage(rel, meta); break;
      case "audio": showAudio(rel, meta); break;
      case "video": showVideo(rel, meta); break;
      case "pdf": showIframe(rawUrl(rel), "PDF"); break;
      case "html": showIframe(rawUrl(rel), "HTML", true); break;
      case "markdown": await showMarkdown(rel, meta); break;
      case "text": case "diff": await showText(rel, meta); break;
      default: showUnsupported(`该格式（${meta.format || meta.ext || "未知"}）暂不支持直接预览`, meta.format === "unknown" ? "" : "二进制办公文档建议用对应技能包转换为文本后再看。");
    }
    loading.hidden = true;
  } catch (err) {
    loading.hidden = true;
    empty.hidden = false;
    empty.textContent = "预览加载失败：" + (err?.message || String(err));
  }
}

function showImage(rel) {
  const img = q("preview-img");
  if (!img) return;
  img.hidden = false;
  img.onerror = () => { img.hidden = true; showUnsupported("图片加载失败", "文件可能已损坏或格式不受浏览器支持。"); };
  img.src = rawUrl(rel);
}

function showAudio(rel) {
  const audio = q("preview-audio");
  if (!audio) return;
  audio.hidden = false;
  audio.src = rawUrl(rel);
  audio.play().catch(() => {});
}

function showVideo(rel) {
  const video = q("preview-video");
  if (!video) return;
  video.hidden = false;
  video.src = rawUrl(rel);
}

function showIframe(src, label, sandboxed = false) {
  const frame = q("preview-iframe");
  if (!frame) return;
  frame.hidden = false;
  frame.title = label || "预览";
  if (sandboxed) frame.setAttribute("sandbox", "");
  else frame.removeAttribute("sandbox");
  frame.src = src;
}

async function showMarkdown(rel) {
  const md = q("preview-markdown");
  const res = await fetch(`${API}/preview/text?path=${encodeURIComponent(rel)}`);
  const data = await res.json();
  if (!data.ok) { showUnsupported("无法读取文本", data.error || ""); return; }
  md.hidden = false;
  md.innerHTML = renderMarkdown(data.content);
}

async function showText(rel) {
  const wrap = q("preview-text-wrap");
  const pre = q("preview-text");
  const res = await fetch(`${API}/preview/text?path=${encodeURIComponent(rel)}`);
  const data = await res.json();
  if (!data.ok) { showUnsupported("无法读取文本", data.error || ""); return; }
  wrap.hidden = false;
  pre.textContent = data.content + (data.truncated ? "\n\n…（内容过长已截断，请用 read_file 分段读取）" : "");
}

function showUnsupported(text, hint) {
  const box = q("preview-unsupported");
  const label = q("preview-unsupported-text");
  const hintEl = q("preview-unsupported-hint");
  if (!box) return;
  box.hidden = false;
  label.textContent = text || "该格式暂不支持直接预览";
  hintEl.textContent = hint || "";
}

function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function loadRecentList() {
  const listEl = q("preview-recent-list");
  if (!listEl) return;
  try {
    const data = await fetch(`${API}/preview/list?depth=2&max=60`).then(r => r.json());
    const files = (data.entries || []).filter(e => e.type === "file" && e.previewable);
    if (!files.length) {
      listEl.innerHTML = '<div class="preview-recent-empty">sandbox 里还没有可预览的文件</div>';
      return;
    }
    listEl.innerHTML = files.map(f => `
      <div class="preview-recent-item" data-rel="${escHtml(f.rel)}">
        <span class="pr-kind">${escHtml(f.kind || "file")}</span>
        <span class="pr-name">${escHtml(f.name)}</span>
      </div>`).join("");
    listEl.querySelectorAll(".preview-recent-item").forEach(item => {
      item.addEventListener("click", () => {
        const rel = item.dataset.rel;
        const input = q("preview-path-input");
        if (input) input.value = rel;
        loadPreview(rel);
      });
    });
  } catch {
    listEl.innerHTML = '<div class="preview-recent-empty">文件列表加载失败</div>';
  }
}

export function initPreviewPanel() {
  const btn = q("preview-btn");
  const exitBtn = q("preview-exit-btn");
  const loadBtn = q("preview-load-btn");
  const input = q("preview-path-input");
  if (btn) btn.addEventListener("click", () => {
    const active = document.body.classList.contains("preview-mode");
    openPreviewPanel(!active);
    if (!active) loadRecentList();
  });
  if (exitBtn) exitBtn.addEventListener("click", () => openPreviewPanel(false));
  if (loadBtn) loadBtn.addEventListener("click", () => loadPreview(input?.value || ""));
  if (input) input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadPreview(input.value);
  });

  window.addEventListener("keydown", (e) => {
    if (e.target?.tagName === "INPUT" || e.target?.tagName === "TEXTAREA" || e.target?.isContentEditable) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "p" || e.key === "P") {
      e.preventDefault();
      const active = document.body.classList.contains("preview-mode");
      openPreviewPanel(!active);
      if (!active) loadRecentList();
    }
    if (e.key === "Escape" && document.body.classList.contains("preview-mode")) {
      openPreviewPanel(false);
    }
  });

  loadRecentList();
}

