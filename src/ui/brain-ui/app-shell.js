import { createHotspotPanel } from './hotspot-panel.js';
import { createWorldcupPanel } from './worldcup-panel.js';
import { createTyphoonPanel } from './typhoon-panel.js';
import { createPersonCardPanel } from './person-card-panel.js';
import { createDocPanel } from './doc-panel.js';
import { createBaguaPanel } from './bagua-panel.js';

const createGraphStage = () => `
<div class="grid-overlay"></div>

<!-- 图谱记忆球画布：默认隐藏；由作战指挥页「全屏图谱」按钮 / 点画布空白 全屏展开 -->
<canvas id="graph" aria-label="爻台 记忆节点图" hidden></canvas>

<!-- 图谱记忆球全屏展开时的分类图例（节点类型颜色说明） -->
<div class="legend" id="legend"></div>

<!-- 图谱记忆球全屏展开时的控制条：重置节点图 / 图谱调节 / 关闭 -->
<div class="graph-controls" id="graph-controls">
  <button class="reset-view" id="reset-view-btn" type="button">↻ 重置节点图</button>
  <section class="physics-control" id="physics-control">
    <button class="physics-toggle" id="physics-toggle" type="button" aria-expanded="false">
      <span class="physics-toggle-label">图谱调节</span>
      <span class="physics-toggle-icon">▾</span>
    </button>
    <div class="physics-panel" id="physics-panel">
      <div class="physics-panel-inner">
        <div class="physics-field">
          <div class="physics-field-head">
            <label class="physics-field-label" for="gravity-slider">引力</label>
            <span class="physics-field-value" id="gravity-value">1.00x</span>
          </div>
          <input class="physics-slider" id="gravity-slider" type="range" min="0" max="5" step="0.02" value="2">
        </div>
        <div class="physics-field">
          <div class="physics-field-head">
            <label class="physics-field-label" for="repulsion-slider">斥力</label>
            <span class="physics-field-value" id="repulsion-value">1.00x</span>
          </div>
          <input class="physics-slider" id="repulsion-slider" type="range" min="0" max="5" step="0.02" value="2">
        </div>
        <div class="physics-field">
          <div class="physics-field-head">
            <label class="physics-field-label" for="node-size-slider">节点大小</label>
            <span class="physics-field-value" id="node-size-value">1.00x</span>
          </div>
          <input class="physics-slider" id="node-size-slider" type="range" min="0" max="5" step="0.02" value="2">
        </div>
      </div>
    </div>
  </section>
  <button class="graph-close" id="graph-close-btn" type="button" title="关闭图谱 (Esc)">✕</button>
</div>

<!-- 晨间简报（浮层卡片，默认隐藏；AI 生成简报后出现） -->
<div class="brief-card brief-float" id="brief-card" hidden>
  <div class="brief-head">
    <span class="brief-title">🌅 晨间简报</span>
    <button class="brief-close" id="brief-close" type="button" title="关闭">×</button>
  </div>
  <div class="brief-body" id="brief-body"></div>
  <div class="brief-goals" id="brief-goals"></div>
  <button class="brief-gen" id="brief-gen" type="button">生成 / 刷新简报</button>
</div>

<!-- 用户消息处理流（L1）隐藏容器：保持功能、不占界面 -->
<div id="si-l1" hidden></div>

<!-- 知识图谱节点详情弹层：点击记忆节点弹出内容 + 相关记忆（P2-1） -->
<div class="graph-detail-overlay" id="graph-detail-overlay" hidden>
  <div class="graph-detail-card">
    <div class="graph-detail-head">
      <span class="graph-detail-type" id="graph-detail-type"></span>
      <button class="graph-detail-close" id="graph-detail-close" type="button" title="关闭">×</button>
    </div>
    <div class="graph-detail-title" id="graph-detail-title"></div>
    <div class="graph-detail-meta" id="graph-detail-meta"></div>
    <div class="graph-detail-body" id="graph-detail-body"></div>
    <div class="graph-detail-section-title">相关记忆</div>
    <div class="graph-detail-related" id="graph-detail-related">
      <div class="graph-detail-empty">加载中…</div>
    </div>
    <div class="graph-detail-actions">
      <button class="graph-detail-btn" id="graph-detail-focus" type="button">聚焦此节点</button>
      <button class="graph-detail-btn" id="graph-detail-search" type="button">以此搜索记忆</button>
    </div>
  </div>
</div>
`;

const createNavbar = () => `
<header class="navbar" id="navbar">
  <div class="nav-left">
    ${createVoicePanel()}
    <div class="nav-brand">
      <span class="brand-title" id="agent-brand-name">爻台 · Yaotai Agent Studio</span>
    </div>
    <span class="conn-badge" id="conn-state"><span class="live-dot"></span>Token流</span>
  </div>
  <div class="nav-center">
    <span class="nav-stat"><span class="label">节点</span><span class="val" id="node-count">0</span></span>
    <span class="nav-stat"><span class="label">连线</span><span class="val" id="link-count">0</span></span>
    <span class="nav-stat"><span class="label">TOK/S</span><span class="val" id="tok-rate">—</span></span>
    <span class="nav-stat" id="mem-recall-stat" title="近 1 小时记忆召回次数 / 平均拉取条数。点击查看明细"><span class="label">召回/H</span><span class="val" id="mem-recall-rate">—</span></span>
    <span class="nav-stat" id="mem-extract-stat" title="近 1 小时记忆抽取次数 / 平均写入条数。点击查看明细"><span class="label">抽取/H</span><span class="val" id="mem-extract-rate">—</span></span>
  </div>
  <div class="nav-right">
    <button class="nav-icon" id="project-btn" type="button" title="投影界面（scene 声明式界面）">◉</button>
    <button class="nav-icon" id="video-btn" title="视频模式 (V)：粘贴链接播放" type="button">⊞</button>
    <button class="nav-icon" id="music-btn" title="音乐模式 (M)：本地曲库播放" type="button">♪</button>
    <button class="nav-icon" id="approvals-btn" type="button" title="审批中心（人工确认）">
      ☑<span class="nav-badge" id="approvals-badge" style="display:none">0</span>
    </button>
    <button class="nav-icon" id="settings-btn" title="设置" type="button">⚙</button>
    <button class="nav-icon" id="fullscreen-btn" title="全屏" type="button">⛶</button>
  </div>
</header>
`;

const createSecondaryPanel = () => `
<aside id="panel-l2" class="panel panel-right">
  <!-- 自主行动机制 · Tick 活动流（右上角） -->
  <section class="section tick-section">
    <div class="section-title"><span>自主行动机制 · Tick</span><span class="pill pill-warm" id="pill-l2">流式传输</span></div>
    <div class="tick-stream" id="si-l2"></div>
  </section>
</aside>
`;

const createWorkbenchPanel = () => `
<section class="workbench" id="workbench">
  <header class="workbench-head">
    <span class="workbench-title">▦ 待办工作台</span>
    <span class="workbench-counts">
      <span class="wb-count" data-count="pending" title="待办事项">待办 <b id="wb-pending-count">0</b></span>
      <span class="wb-count" data-count="done" title="完成事项">完成 <b id="wb-done-count">0</b></span>
    </span>
    <button class="workbench-toggle" id="workbench-toggle" type="button" title="展开 / 收起工作台" aria-expanded="true">▾</button>
  </header>

  <div class="workbench-body" id="workbench-body">
    <nav class="workbench-tabs">
      <button class="wb-tab active" data-tab="todo" type="button">待办事项</button>
      <button class="wb-tab" data-tab="done" type="button">完成事项</button>
      <button class="wb-tab" data-tab="review" type="button">每周复盘</button>
    </nav>

    <div class="workbench-content">
      <!-- 待办事项 -->
      <div class="wb-pane active" data-pane="todo" id="wb-pane-todo">
        <div class="wb-add-row">
          <input id="wb-todo-input" type="text" placeholder="添加待办…（回车确认）" autocomplete="off" spellcheck="false" />
          <button id="wb-todo-add" type="button" title="添加待办">＋</button>
        </div>
        <div class="wb-list" id="wb-todo-list"></div>
      </div>

      <!-- 完成事项 -->
      <div class="wb-pane" data-pane="done" id="wb-pane-done">
        <div class="wb-list" id="wb-done-list"></div>
      </div>

      <!-- 每周复盘 -->
      <div class="wb-pane" data-pane="review" id="wb-pane-review">
        <div class="wb-review-head">
          <span class="wb-review-week" id="wb-review-week">—</span>
          <span class="wb-review-spacer"></span>
          <button class="wb-review-edit" id="wb-review-edit" type="button" title="写 / 更新本周复盘">✎ 本周复盘</button>
        </div>
        <div class="wb-review-mood" id="wb-review-mood"></div>
        <div class="wb-review-content" id="wb-review-content"></div>
        <div class="wb-review-history" id="wb-review-history"></div>
      </div>
    </div>
  </div>
</section>
`;

const createConsole = () => `
<section class="console" id="chat-area">
  <!-- 顶部状态条：心跳 / 思考 / AI 活动 -->
  <div class="chat-top" id="chat-top">
    <div class="chat-top-left">
      <span class="chat-heart">♡ 心跳</span>
      <span class="chat-tick" id="chat-tick">--:--:--</span>
      <span class="chat-divider">|</span>
      <div class="ai-activity" id="ai-activity">
        <span class="ai-activity-dot" id="ai-activity-dot"></span>
        <span class="ai-activity-label" id="ai-activity-label">空闲</span>
        <span class="ai-activity-detail" id="ai-activity-detail"></span>
      </div>
    </div>
    <div class="chat-top-right">
      <span class="chat-stream-pill">流式传输</span>
    </div>
  </div>

  <div id="chat-history">
    <div id="chat-messages"></div>
  </div>
  <div id="paste-attachments" class="paste-attachments" hidden></div>
  <div id="input-row">
    <div id="slash-menu" class="slash-menu" role="listbox" aria-label="命令" hidden></div>
    <button class="input-mic" id="voice-btn" title="麦克风 开/关" type="button">🎤</button>
    <textarea id="msg-input" rows="1" placeholder="向爻台发送消息…（输入 / 调出命令，Shift+Enter 换行）" autocomplete="off"></textarea>
    <button id="send-btn" type="button">发送</button>
  </div>
</section>
`;

const createThemeSwitcher = () => `
<div class="theme-switcher" id="theme-switcher">
  <div class="theme-dot active" data-t="neon" title="Neon 霓虹"></div>
  <div class="theme-dot" data-t="midnight" title="Midnight Steel"></div>
  <div class="theme-dot" data-t="phosphor" title="Phosphor CRT"></div>
  <div class="theme-dot" data-t="violet" title="Violet Lab"></div>
  <div class="theme-dot" data-t="rose" title="Rose Dusk"></div>
  <div class="theme-dot" data-t="arctic" title="Arctic"></div>
  <div class="theme-dot" data-t="sand" title="Warm Sand"></div>
</div>
`;

const createTooltip = () => `
<div id="tip"></div>
`;

// 多 Agent 办公室：成员配置弹层（全局 fixed，从军机处打开）
const createMultiAgentConfigOverlay = () => `
<div class="ma-config-overlay" id="ma-config-overlay" hidden>
  <div class="ma-config-modal">
    <div class="ma-config-head">
      <span id="ma-config-title">配置成员</span>
      <button class="ma-config-close" id="ma-config-close" type="button" title="关闭">×</button>
    </div>
    <div class="ma-config-body">
      <label>头像 emoji<input id="cfg-avatar" type="text" placeholder="🤖" autocomplete="off" spellcheck="false"></label>
      <label>头像图片 URL<input id="cfg-avatar-image" type="text" placeholder="https://…" autocomplete="off" spellcheck="false"></label>
      <label>名称<input id="cfg-name" type="text" autocomplete="off" spellcheck="false"></label>
      <label>官职 / 角色<input id="cfg-role" type="text" autocomplete="off" spellcheck="false"></label>
      <label>引擎<select id="cfg-engine"><option value="internal">internal</option><option value="custom">custom</option><option value="cli">cli</option></select></label>
      <div id="cfg-custom-fields" hidden>
        <label>Base URL<input id="cfg-base-url" type="text" placeholder="http://localhost:11434/v1" autocomplete="off" spellcheck="false"></label>
        <label>API Key<input id="cfg-api-key" type="password" placeholder="留空保持原值" autocomplete="new-password"></label>
        <label>模型<input id="cfg-model" type="text" placeholder="qwen2.5 / gpt-4o…" autocomplete="off" spellcheck="false"></label>
      </div>
      <div id="cfg-cli-fields" hidden>
        <label>CLI 命令<input id="cfg-cli-command" type="text" placeholder="claude --output-format json" autocomplete="off" spellcheck="false"></label>
      </div>
      <label>温度<input id="cfg-temperature" type="number" min="0" max="2" step="0.1" value="0.5"></label>
      <label style="flex-direction:row;align-items:center;gap:8px;">开启语音<input id="cfg-voice-enabled" type="checkbox" style="width:auto;flex:none;"></label>
      <label>语音音色 ID<input id="cfg-voice-id" type="text" placeholder="留空用默认" autocomplete="off" spellcheck="false"></label>
      <label>私库记忆<textarea id="cfg-private-memory" placeholder="该成员的专属记忆（可为空）" autocomplete="off" spellcheck="false"></textarea></label>
    </div>
    <div class="ma-config-actions">
      <button class="ma-config-task" id="ma-config-task" type="button">布置任务</button>
      <button class="ma-config-save" id="ma-config-save" type="button">保存</button>
      <button id="ma-config-cancel" type="button">取消</button>
    </div>
  </div>
</div>
`;

const createSettingsModal = () => `
<div class="settings-overlay" id="settings-overlay" hidden>
  <div class="settings-modal" role="dialog" aria-modal="true" aria-label="设置">
    <div class="settings-header">
      <span class="settings-title">设置</span>
      <button class="settings-close" id="settings-close" type="button" aria-label="关闭">×</button>
    </div>
    <div class="settings-body">

      <!-- 侧栏导航 -->
      <nav class="settings-nav">
        <button class="settings-nav-item active" data-tab="appearance" type="button">外观</button>
        <button class="settings-nav-item" data-tab="llm" type="button">LLM 模型</button>
        <button class="settings-nav-item" data-tab="media" type="button">媒体能力</button>
        <button class="settings-nav-item" data-tab="social" type="button">社交媒体</button>
        <button class="settings-nav-item" data-tab="voice" type="button">语音对话</button>
        <button class="settings-nav-item" data-tab="web-search" type="button">上网搜索</button>
        <button class="settings-nav-item" data-tab="security" type="button">安全沙箱</button>
        <button class="settings-nav-item" data-tab="skills" type="button">技能</button>
        <button class="settings-nav-item" data-tab="mcp" type="button">MCP</button>
        <button class="settings-nav-item" data-tab="insights" type="button">用量</button>
        <button class="settings-nav-item" data-tab="advanced" type="button">高级功能</button>
        <button class="settings-nav-item" data-tab="update" type="button">更新</button>
      </nav>

      <!-- 内容区 -->
      <div class="settings-content">

        <!-- ── 外观 tab ── -->
        <div class="settings-tab active" data-tab="appearance">
          <div class="settings-section">
            <div class="settings-section-label">主题</div>
            ${createThemeSwitcher()}
          </div>
          <div class="settings-section">
            <div class="settings-section-label">AI 名字</div>
            <div class="settings-row">
              <label class="settings-label" for="settings-agent-name">显示名</label>
              <input class="settings-input" id="settings-agent-name" type="text" maxlength="32" autocomplete="off" spellcheck="false" placeholder="爻台">
            </div>
            <div class="settings-row-action">
              <button class="settings-save-btn" id="settings-save-agent-name" type="button">保存</button>
              <span class="settings-feedback" id="settings-agent-name-feedback"></span>
            </div>
          </div>
          <div class="settings-section">
            <div class="settings-section-label">记忆节点图</div>
            <p class="settings-hint">开启后在「作战指挥」页右侧显示记忆节点图谱，会占用额外 CPU/GPU 资源，低配设备建议关闭。修改后需刷新页面生效。</p>
            <div class="settings-row">
              <label class="settings-label" for="settings-memory-graph-toggle">显示记忆节点图</label>
              <input id="settings-memory-graph-toggle" type="checkbox" style="width:auto;flex:none;">
              <span class="settings-feedback" id="settings-memory-graph-feedback" style="margin-left:8px;"></span>
            </div>
          </div>
          <div class="settings-section">
            <div class="settings-section-label">Obsidian 记忆库</div>
            <p class="settings-hint">把记忆导出为 Obsidian Vault（每个实体一个 Markdown 文件，双链互连），可用 Obsidian 打开阅读、编辑 AI 的记忆。记忆整理循环会自动同步。</p>
            <div class="vault-card">
              <div class="vault-actions">
                <button id="vault-export-btn" type="button" class="settings-action-btn" title="导出为 Obsidian Vault">
                  <span class="sab-icon">📤</span>
                  <span class="sab-text">导出记忆库</span>
                </button>
                <button id="vault-open-btn" type="button" class="settings-action-btn" title="在文件管理器中打开记忆库目录">
                  <span class="sab-icon">📂</span>
                  <span class="sab-text">打开文件夹</span>
                </button>
              </div>
              <div class="vault-status-line">
                <span class="vault-status-label">记忆库状态</span>
                <span class="settings-hint" id="vault-status" style="margin:0;">—</span>
              </div>
              <div class="vault-feedback-line">
                <span class="settings-feedback" id="vault-feedback"></span>
              </div>
            </div>
          </div>
        </div>

        <!-- ── LLM 模型 tab ── -->
        <div class="settings-tab" data-tab="llm">
          <div class="settings-section">
            <div class="settings-section-label">当前状态</div>
            <div class="settings-config-row">
              <span class="settings-config-type">LLM</span>
              <span class="settings-config-info" id="settings-cfg-llm">—</span>
              <span class="settings-config-dot" id="settings-cfg-llm-dot"></span>
            </div>
          </div>
          <div class="settings-section">
            <div class="settings-section-label">切换配置</div>
            <div class="settings-row">
              <label class="settings-label" for="settings-provider-select">提供商</label>
              <select class="settings-select" id="settings-provider-select">
                <option value="auto">自动识别</option>
                <option value="deepseek">DeepSeek</option>
                <option value="minimax">MiniMax</option>
                <option value="mimo">小米 MiMo</option>
                <option value="custom">自定义端点（本地/其他）</option>
              </select>
            </div>
            <div class="settings-row" id="settings-model-row">
              <label class="settings-label" for="settings-model-select">模型</label>
              <select class="settings-select" id="settings-model-select"></select>
            </div>
            <div class="settings-row" id="settings-official-custom-model-row" style="display:none;">
              <label class="settings-label" for="settings-official-custom-model">自定义模型名</label>
              <input class="settings-input" id="settings-official-custom-model" type="text" placeholder="如 kimi-k2.8, gpt-5.2, glm-6" autocomplete="off" spellcheck="false">
            </div>
            <!-- 自定义端点字段（选择"自定义端点"时显示） -->
            <div id="settings-custom-llm-section" style="display:none;">
              <div class="settings-row">
                <label class="settings-label" for="settings-custom-baseurl">Base URL</label>
                <input class="settings-input" id="settings-custom-baseurl" type="text" placeholder="如 http://localhost:11434/v1">
              </div>
              <div class="settings-row">
                <label class="settings-label" for="settings-custom-model">模型名称</label>
                <input class="settings-input" id="settings-custom-model" type="text" placeholder="如 llama3.2, qwen2.5, mistral">
              </div>
            </div>
            <div class="settings-row">
              <label class="settings-label" for="settings-llm-key">API Key</label>
              <div class="settings-secret-wrap">
                <input class="settings-input" id="settings-llm-key" type="password" placeholder="已保存的 Key 会在这里显示" autocomplete="new-password">
                <button class="settings-secret-toggle" id="settings-llm-key-toggle" type="button" aria-label="显示 API Key" title="显示/隐藏 API Key">👁</button>
              </div>
            </div>
            <div class="settings-row-action">
              <button class="settings-save-btn" id="settings-save-llm" type="button">保存</button>
              <span class="settings-feedback" id="settings-llm-feedback"></span>
            </div>
          </div>
          <div class="settings-section">
            <div class="settings-section-label">模型温度</div>
            <p class="settings-hint">控制回复的随机性。0 = 确定性最高，1 = 正常创意，1.5 = 更随机。推荐 0.3–0.7。</p>
            <div class="settings-row">
              <label class="settings-label" for="settings-temperature">Temperature</label>
              <input type="range" id="settings-temperature" min="0" max="1.5" step="0.05" value="0.5" style="flex:1;cursor:pointer;">
              <span id="settings-temperature-val" style="min-width:2.8em;text-align:right;color:var(--ink2);font-size:13px;">0.50</span>
            </div>
            <div class="settings-row-action">
              <button class="settings-save-btn" id="settings-save-temperature" type="button">保存</button>
              <span class="settings-feedback" id="settings-temperature-feedback"></span>
            </div>
          </div>
          <div class="settings-section">
            <div class="settings-section-label">思考模式</div>
            <p class="settings-hint">默认关闭：直接作答，响应更快、更省 token。开启后模型会先推理再回答，复杂任务更可靠（具体想多深由模型自己决定），但响应更慢。遇到难题想要更高质量时再开启。</p>
            <div class="settings-row">
              <label class="settings-label" for="settings-thinking">启用思考模式</label>
              <label class="settings-toggle">
                <input type="checkbox" id="settings-thinking">
                <span class="settings-toggle-track"></span>
              </label>
              <span class="settings-feedback" id="settings-thinking-feedback"></span>
            </div>
          </div>
        </div>

        <!-- ── 媒体能力 tab ── -->
        <div class="settings-tab" data-tab="media">
          <div class="settings-section">
            <div class="settings-section-label">当前状态</div>
            <div class="settings-config-row">
              <span class="settings-config-type">媒体</span>
              <span class="settings-config-info" id="settings-cfg-media">—</span>
              <span class="settings-config-dot" id="settings-cfg-media-dot"></span>
            </div>
          </div>
          <div class="settings-section">
            <div class="settings-section-label">MiniMax API Key</div>
            <div class="settings-row">
              <label class="settings-label" for="settings-minimax-key">API Key</label>
              <input class="settings-input" id="settings-minimax-key" type="password" placeholder="填入 MiniMax API Key…" autocomplete="new-password">
            </div>
            <div class="settings-row-action">
              <button class="settings-save-btn" id="settings-save-minimax" type="button">保存</button>
              <span class="settings-feedback" id="settings-minimax-feedback"></span>
            </div>
          </div>
        </div>

        <!-- ── 社交媒体 tab ── -->
        <div class="settings-tab" data-tab="social">
          <div class="settings-section">
            <div class="settings-section-label">Discord</div>
            <div class="settings-platform-status" id="social-status-discord"></div>
            <div class="settings-row">
              <label class="settings-label" for="social-discord-token">Bot Token</label>
              <input class="settings-input" id="social-discord-token" type="password" placeholder="留空保持原值不变…" autocomplete="new-password">
            </div>
          </div>
          <div class="settings-section">
            <div class="settings-section-label">飞书</div>
            <div class="settings-platform-status" id="social-status-feishu"></div>
            <div class="settings-row">
              <label class="settings-label" for="social-feishu-appid">App ID</label>
              <input class="settings-input" id="social-feishu-appid" type="password" placeholder="留空保持原值…" autocomplete="new-password">
            </div>
            <div class="settings-row">
              <label class="settings-label" for="social-feishu-secret">App Secret</label>
              <input class="settings-input" id="social-feishu-secret" type="password" placeholder="留空保持原值…" autocomplete="new-password">
            </div>
            <div class="settings-row">
              <label class="settings-label" for="social-feishu-token">Verify Token</label>
              <input class="settings-input" id="social-feishu-token" type="password" placeholder="留空保持原值…" autocomplete="new-password">
            </div>
          </div>
          <div class="settings-section">
            <div class="settings-section-label">微信公众号</div>
            <div class="settings-platform-status" id="social-status-wechat"></div>
            <div class="settings-row">
              <label class="settings-label" for="social-wechat-appid">App ID</label>
              <input class="settings-input" id="social-wechat-appid" type="password" placeholder="留空保持原值…" autocomplete="new-password">
            </div>
            <div class="settings-row">
              <label class="settings-label" for="social-wechat-secret">App Secret</label>
              <input class="settings-input" id="social-wechat-secret" type="password" placeholder="留空保持原值…" autocomplete="new-password">
            </div>
            <div class="settings-row">
              <label class="settings-label" for="social-wechat-token">Token</label>
              <input class="settings-input" id="social-wechat-token" type="password" placeholder="留空保持原值…" autocomplete="new-password">
            </div>
          </div>
          <div class="settings-section">
            <div class="settings-section-label">企业微信</div>
            <div class="settings-platform-status" id="social-status-wecom"></div>
            <div class="settings-row">
              <label class="settings-label" for="social-wecom-botkey">Bot Key</label>
              <input class="settings-input" id="social-wecom-botkey" type="password" placeholder="留空保持原值…" autocomplete="new-password">
            </div>
            <div class="settings-row">
              <label class="settings-label" for="social-wecom-token">Incoming Token</label>
              <input class="settings-input" id="social-wecom-token" type="password" placeholder="留空保持原值…" autocomplete="new-password">
            </div>
          </div>
          <div class="settings-section">
            <div class="settings-section-label">微信 ClawBot（个人微信）</div>
            <div class="settings-platform-status" id="social-status-clawbot">○ 未连接</div>
            <p class="settings-hint">点击「连接微信」后会生成二维码，用微信扫码即可绑定个人账号。凭证保存在本地，重启后无需重新扫码。</p>
            <div class="settings-row" style="gap:8px;flex-wrap:wrap;">
              <button class="settings-save-btn" id="clawbot-connect-btn" type="button" style="width:auto;padding:0 16px;">连接微信</button>
              <button class="settings-save-btn" id="clawbot-logout-btn" type="button" style="width:auto;padding:0 16px;background:var(--danger,#c0392b);">断开</button>
            </div>
            <div id="clawbot-qr-area" style="display:none;margin-top:12px;text-align:center;">
              <p class="settings-hint" style="margin-bottom:8px;">用微信扫描下方二维码：</p>
              <img id="clawbot-qr-img" src="" alt="微信二维码" style="width:200px;height:200px;border:1px solid var(--border);border-radius:4px;">
              <p class="settings-hint" style="margin-top:6px;font-size:11px;" id="clawbot-qr-hint">等待扫码…</p>
            </div>
            <span class="settings-feedback" id="clawbot-feedback"></span>
          </div>
          <div class="settings-section settings-section-action">
            <button class="settings-save-btn" id="settings-save-social" type="button">保存所有</button>
            <span class="settings-feedback" id="settings-social-feedback"></span>
          </div>
        </div>

        <!-- ── 语音 tab ── -->
        <div class="settings-tab" data-tab="voice">
          <div class="settings-section">
            <div class="settings-section-label">语音识别配置</div>
            <div class="settings-row">
              <label class="settings-label" for="voice-auto-key">粘贴 Key 自动识别厂商</label>
              <input class="settings-input" type="password" id="voice-auto-key" placeholder="阿里云 / 腾讯云 / 讯飞 / 火山豆包 ASR Key">
              <span id="voice-auto-detect" style="color:var(--cool);font-size:12px;min-width:86px;text-align:right;"></span>
            </div>
            <div class="settings-row">
              <label class="settings-label" for="voice-provider-select">服务商</label>
              <select class="settings-select" id="voice-provider-select">
                <option value="local">本机识别（macOS）</option>
                <option value="aliyun">阿里云百炼（推荐）</option>
                <option value="volcengine">火山引擎豆包 ASR</option>
                <option value="tencent">腾讯云 ASR</option>
                <option value="xunfei">科大讯飞 RTASR</option>
              </select>
            </div>
            <div id="voice-cred-aliyun">
              <div class="settings-row">
                <label class="settings-label" for="voice-aliyun-key">阿里云 API Key</label>
                <input class="settings-input" type="password" id="voice-aliyun-key" placeholder="留空则不修改">
              </div>
            </div>
            <div id="voice-cred-tencent" style="display:none;">
              <div class="settings-row">
                <label class="settings-label" for="voice-tencent-sid">SecretId</label>
                <input class="settings-input" type="password" id="voice-tencent-sid" placeholder="留空则不修改">
              </div>
              <div class="settings-row">
                <label class="settings-label" for="voice-tencent-skey">SecretKey</label>
                <input class="settings-input" type="password" id="voice-tencent-skey" placeholder="留空则不修改">
              </div>
              <div class="settings-row">
                <label class="settings-label" for="voice-tencent-appid">AppId</label>
                <input class="settings-input" type="text" id="voice-tencent-appid" placeholder="腾讯云 AppId">
              </div>
            </div>
            <div id="voice-cred-volcengine" style="display:none;">
              <div class="settings-row">
                <label class="settings-label" for="voice-volc-apikey">API Key</label>
                <div class="settings-secret-wrap">
                  <input class="settings-input" type="password" id="voice-volc-apikey" placeholder="输入后自动保存" autocomplete="new-password">
                  <button class="settings-secret-toggle" id="voice-volc-apikey-toggle" type="button" aria-label="显示 API Key" title="显示/隐藏 API Key">👁</button>
                </div>
              </div>
            </div>
            <div id="voice-cred-xunfei" style="display:none;">
              <div class="settings-row">
                <label class="settings-label" for="voice-xunfei-appid">AppId</label>
                <input class="settings-input" type="text" id="voice-xunfei-appid" placeholder="讯飞 AppId">
              </div>
              <div class="settings-row">
                <label class="settings-label" for="voice-xunfei-apikey">ApiKey</label>
                <input class="settings-input" type="password" id="voice-xunfei-apikey" placeholder="留空则不修改">
              </div>
            </div>
          </div>

          <div class="settings-section">
            <div class="settings-section-label">语音识别灵敏度</div>
            <p class="settings-hint">调节麦克风触发阈值。越低越灵敏，越高越需要大声说话。默认 0.008。</p>
            <div class="settings-row">
              <label class="settings-label" for="settings-voice-threshold">触发阈值</label>
              <input type="range" id="settings-voice-threshold" min="0.002" max="0.04" step="0.001" value="0.008" style="flex:1;cursor:pointer;">
              <span id="settings-voice-threshold-val" style="min-width:3.5em;text-align:right;color:var(--ink2);font-size:13px;">0.008</span>
            </div>
          </div>

          <div class="settings-section" id="settings-tts-section">
            <div class="settings-section-label">语音合成（TTS）</div>
            <p class="settings-hint">用语音发消息时，Agent 回复会自动转为语音播放。首选推荐豆包语音合成 2.0（https://console.volcengine.com/speech/new/），也支持 MiniMax、OpenAI、ElevenLabs、火山引擎。</p>
            <div class="settings-row">
              <label class="settings-label" for="tts-provider-select">服务商</label>
              <select class="settings-select" id="tts-provider-select">
                <option value="doubao">豆包（方舟，流式，中文最自然）</option>
                <option value="openai">OpenAI TTS（流式，$0.015/千字）</option>
                <option value="elevenlabs">ElevenLabs（流式，高质量）</option>
                <option value="volcano">火山引擎（中文，有免费额度）</option>
                <option value="minimax">MiniMax（已有配置）</option>
              </select>
            </div>
            <div class="settings-row">
              <label class="settings-label" for="tts-voice-select">声音</label>
              <select class="settings-select" id="tts-voice-select"></select>
            </div>
            <div class="settings-row">
              <label class="settings-label" for="tts-streaming-toggle">流式合成</label>
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;color:var(--ink2);">
                <input type="checkbox" id="tts-streaming-toggle" />
                边合成边播放，回复更快出声（默认开）
              </label>
            </div>
            <div class="settings-row">
              <label class="settings-label" for="tts-fx-toggle">机器人音效</label>
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;color:var(--ink2);">
                <input type="checkbox" id="tts-fx-toggle" />
                给当前声音叠加混响 / 机械质感（默认关）
              </label>
            </div>
            <div id="tts-fx-lock" style="display:none;flex-direction:column;align-items:stretch;gap:6px;padding:8px 0 4px;">
              <p class="settings-hint" style="margin:0;color:#e0a64d;">机器人音效需要付费，这是维持这个项目动力，请联系作者索要密码</p>
              <div style="display:flex;gap:8px;align-items:center;">
                <input class="settings-input" type="text" id="tts-fx-pw" placeholder="输入密码解锁" style="flex:1;">
                <button class="settings-save-btn" id="tts-fx-unlock" type="button" style="padding:4px 14px;font-size:12px;">解锁</button>
              </div>
              <span id="tts-fx-unlock-msg" style="font-size:11px;color:var(--ink2);"></span>
            </div>
            <div id="tts-fx-sliders" style="display:none;flex-direction:column;gap:7px;padding:8px 0 4px;">
              <div class="tts-fx-srow"><label for="tts-fx-wet">混响</label><input type="range" id="tts-fx-wet" min="0" max="2" step="0.01"><span id="tts-fx-wet-val"></span></div>
              <div class="tts-fx-srow"><label for="tts-fx-reverbSeconds">混响长度</label><input type="range" id="tts-fx-reverbSeconds" min="0.2" max="3.5" step="0.1"><span id="tts-fx-reverbSeconds-val"></span></div>
              <div class="tts-fx-srow"><label for="tts-fx-driveMix">失真 / 重量</label><input type="range" id="tts-fx-driveMix" min="0" max="2" step="0.01"><span id="tts-fx-driveMix-val"></span></div>
              <div class="tts-fx-srow"><label for="tts-fx-metallic">金属感</label><input type="range" id="tts-fx-metallic" min="0" max="2" step="0.01"><span id="tts-fx-metallic-val"></span></div>
              <div class="tts-fx-srow"><label for="tts-fx-ring">机器人感</label><input type="range" id="tts-fx-ring" min="0" max="2" step="0.01"><span id="tts-fx-ring-val"></span></div>
              <div class="tts-fx-srow"><label for="tts-fx-chorus">合成厚度</label><input type="range" id="tts-fx-chorus" min="0" max="2" step="0.01"><span id="tts-fx-chorus-val"></span></div>
              <div class="tts-fx-srow"><label for="tts-fx-metallicFeedback">金属共振</label><input type="range" id="tts-fx-metallicFeedback" min="0" max="0.92" step="0.01"><span id="tts-fx-metallicFeedback-val"></span></div>
              <div class="tts-fx-srow"><label for="tts-fx-metallicDelayMs">金属音调</label><input type="range" id="tts-fx-metallicDelayMs" min="2" max="20" step="0.5"><span id="tts-fx-metallicDelayMs-val"></span></div>
              <div class="tts-fx-srow"><label for="tts-fx-ringHz">机器人音调</label><input type="range" id="tts-fx-ringHz" min="30" max="600" step="5"><span id="tts-fx-ringHz-val"></span></div>
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <span class="settings-hint" style="margin:0;">拖动即时生效，下次播放 / 试听可听到</span>
                <button class="settings-save-btn" id="tts-fx-reset" type="button" style="padding:3px 10px;font-size:12px;">恢复默认</button>
              </div>
            </div>

            <div id="tts-creds-doubao" style="display:none;">
              <div class="settings-row">
                <label class="settings-label" for="tts-doubao-key">API Key</label>
                <div class="settings-secret-wrap">
                  <input class="settings-input" type="password" id="tts-doubao-key" placeholder="已保存的 Key 会在这里显示" autocomplete="new-password">
                  <button class="settings-secret-toggle" id="tts-doubao-key-toggle" type="button" aria-label="显示 API Key" title="显示/隐藏 API Key">👁</button>
                </div>
              </div>
              <div class="settings-row">
                <label class="settings-label" for="tts-doubao-resource">Resource ID</label>
                <input class="settings-input" type="text" id="tts-doubao-resource" placeholder="自动匹配，或填 seed-tts-2.0 / seed-tts-1.0">
              </div>
              <div class="tts-fx-srow" style="margin-bottom:8px;">
                <label for="tts-doubao-rate">语速</label>
                <input type="range" id="tts-doubao-rate" min="-50" max="100" step="5">
                <span id="tts-doubao-rate-val"></span>
              </div>
              <p class="settings-hint">在<a href="https://console.volcengine.com/speech/new/" target="_blank" style="color:var(--cool)">豆包语音合成控制台</a>获取 API Key。2.0 音色使用 seed-tts-2.0；1.0/moon/BV 音色使用 seed-tts-1.0 或控制台对应资源。</p>
            </div>

            <div id="tts-creds-minimax" style="display:none;">
              <div class="settings-row">
                <label class="settings-label" for="tts-minimax-key">MiniMax API Key</label>
                <input class="settings-input" type="password" id="tts-minimax-key" placeholder="留空则不修改（可与 LLM 共用）">
              </div>
              <p class="settings-hint">可用声音：male-qn-qingse · male-qn-jingying · female-shaonv · female-yujie · presenter_female 等。</p>
            </div>

            <div id="tts-creds-openai">
              <div class="settings-row">
                <label class="settings-label" for="tts-openai-key">OpenAI API Key</label>
                <input class="settings-input" type="password" id="tts-openai-key" placeholder="留空则不修改（可与 LLM 共用）">
              </div>
              <div class="settings-row">
                <label class="settings-label" for="tts-openai-baseurl">Base URL（选填）</label>
                <input class="settings-input" type="text" id="tts-openai-baseurl" placeholder="自定义端点，如 https://api.deepseek.com">
              </div>
              <p class="settings-hint">可用声音：nova · shimmer · alloy · echo · fable · onyx</p>
            </div>

            <div id="tts-creds-elevenlabs" style="display:none;">
              <div class="settings-row">
                <label class="settings-label" for="tts-elevenlabs-key">ElevenLabs API Key</label>
                <input class="settings-input" type="password" id="tts-elevenlabs-key" placeholder="留空则不修改">
              </div>
              <p class="settings-hint">免费套餐每月 10,000 字符。声音 ID 在 ElevenLabs 控制台获取。</p>
            </div>

            <div id="tts-creds-volcano" style="display:none;">
              <div class="settings-row">
                <label class="settings-label" for="tts-volcano-appid">AppId</label>
                <input class="settings-input" type="text" id="tts-volcano-appid" placeholder="火山引擎 TTS AppId">
              </div>
              <div class="settings-row">
                <label class="settings-label" for="tts-volcano-token">Access Token</label>
                <input class="settings-input" type="password" id="tts-volcano-token" placeholder="留空则不修改">
              </div>
              <p class="settings-hint">可用声音：BV001_streaming（通用女声）· BV002_streaming（通用男声）等，在火山引擎控制台查看全部。</p>
            </div>

            <div class="settings-row" style="margin-top:8px;">
              <button class="settings-save-btn" id="tts-test-btn" type="button" style="padding:4px 12px;font-size:12px;">试听</button>
              <span id="tts-test-status" style="color:var(--ink2);font-size:12px;margin-left:8px;"></span>
            </div>
          </div>

          <div class="settings-section">
            <div class="settings-section-label">设备设置</div>
            <div class="settings-row">
              <label class="settings-label" for="voice-lang-select">识别语言</label>
              <select class="settings-select" id="voice-lang-select">
                <option value="zh-CN">中文（普通话）</option>
                <option value="en-US">English (US)</option>
              </select>
            </div>
            <div class="settings-row">
              <label class="settings-label" for="voice-mic-select">麦克风</label>
              <select class="settings-select" id="voice-mic-select">
                <option value="">系统默认麦克风</option>
              </select>
              <button class="settings-save-btn" id="voice-refresh-mics" type="button" style="padding:0 10px;">刷新</button>
            </div>
            <p class="settings-hint" id="voice-mic-status" style="margin-top:-2px;">更换麦克风后，重新开启语音对话生效。</p>
            <div class="settings-row">
              <label class="settings-label" for="voice-output-select">输出设备</label>
              <select class="settings-select" id="voice-output-select">
                <option value="">自动（跟随系统，避开虚拟设备）</option>
              </select>
              <button class="settings-save-btn" id="voice-refresh-outputs" type="button" style="padding:0 10px;">刷新</button>
            </div>
            <p class="settings-hint" id="voice-output-status" style="margin-top:-2px;">语音从这里发声。默认自动选择；拔耳机会自动切回扬声器，不会被串流/虚拟声卡占用。</p>
            <div class="settings-row">
              <label class="settings-label" for="voice-auto-send">识别后自动发送</label>
              <input id="voice-auto-send" type="checkbox" checked style="width:auto;flex:none;">
            </div>
            <div class="settings-row">
              <label class="settings-label" for="voice-auto-mic">启动时自动开启麦克风</label>
              <input id="voice-auto-mic" type="checkbox" style="width:auto;flex:none;">
            </div>
          </div>

          <div class="settings-section settings-section-action">
            <button class="settings-save-btn" id="settings-save-voice" type="button">保存</button>
            <span class="settings-feedback" id="settings-voice-feedback"></span>
          </div>
        </div>

        <!-- ── 上网搜索 tab ── -->
        <div class="settings-tab" data-tab="web-search">
          <div class="settings-section">
            <div class="settings-section-label">搜索引擎</div>
            <p class="settings-hint">Agent 调用 web_search 时分两梯队：第一梯队（带 key 的 API：Serper → Brave → Tavily → SearXNG）按优先级尝试；都没结果时，第二梯队（Bing / Jina / DuckDuckGo，无需配置）并行兜底。配任意一个 key 都能显著提升质量和稳定性，多配几个可避免单一额度用尽时搜索失败。</p>

            <div class="settings-row">
              <label class="settings-label" for="websearch-serper-key">Serper API Key</label>
              <input class="settings-input" type="password" id="websearch-serper-key" placeholder="留空则不修改">
            </div>
            <p class="settings-hint">在 <a href="https://serper.dev" target="_blank" style="color:var(--cool)">serper.dev</a> 注册后获取（每月 2500 次免费）。Google SERP JSON 接口，最稳定。</p>

            <div class="settings-row">
              <label class="settings-label" for="websearch-brave-key">Brave API Key</label>
              <input class="settings-input" type="password" id="websearch-brave-key" placeholder="留空则不修改">
            </div>
            <p class="settings-hint">在 <a href="https://brave.com/search/api" target="_blank" style="color:var(--cool)">brave.com/search/api</a> 获取（每月 2000 次免费）。独立索引，Serper 的可靠兜底。</p>

            <div class="settings-row">
              <label class="settings-label" for="websearch-tavily-key">Tavily API Key</label>
              <input class="settings-input" type="password" id="websearch-tavily-key" placeholder="留空则不修改">
            </div>
            <p class="settings-hint">在 <a href="https://tavily.com" target="_blank" style="color:var(--cool)">tavily.com</a> 获取（每月 1000 次免费）。面向 LLM 的搜索接口。</p>

            <div class="settings-row">
              <label class="settings-label" for="websearch-jina-key">Jina API Key</label>
              <input class="settings-input" type="password" id="websearch-jina-key" placeholder="留空则不修改">
            </div>
            <p class="settings-hint">在 <a href="https://jina.ai" target="_blank" style="color:var(--cool)">jina.ai</a> 获取（有免费额度）。s.jina.ai 搜索接口，第二梯队兜底之一。</p>

            <div class="settings-row">
              <label class="settings-label" for="websearch-searxng-url">SearXNG URL</label>
              <input class="settings-input" type="text" id="websearch-searxng-url" placeholder="https://your-searxng-instance.com">
            </div>
            <p class="settings-hint">选填。自托管 SearXNG 实例地址（去隐私的元搜索引擎）。要带 http:// 或 https://。</p>
          </div>

          <div class="settings-section">
            <div class="settings-section-label">当前状态</div>
            <div class="settings-config-row">
              <span class="settings-config-type">Serper</span>
              <span class="settings-config-info" id="websearch-status-serper">—</span>
            </div>
            <div class="settings-config-row">
              <span class="settings-config-type">Brave</span>
              <span class="settings-config-info" id="websearch-status-brave">—</span>
            </div>
            <div class="settings-config-row">
              <span class="settings-config-type">Tavily</span>
              <span class="settings-config-info" id="websearch-status-tavily">—</span>
            </div>
            <div class="settings-config-row">
              <span class="settings-config-type">Jina</span>
              <span class="settings-config-info" id="websearch-status-jina">—</span>
            </div>
            <div class="settings-config-row">
              <span class="settings-config-type">SearXNG</span>
              <span class="settings-config-info" id="websearch-status-searxng">—</span>
            </div>
          </div>

          <div class="settings-section settings-section-action">
            <button class="settings-save-btn" id="settings-save-web-search" type="button">保存</button>
            <span class="settings-feedback" id="settings-web-search-feedback"></span>
          </div>
        </div>

        <!-- ── 安全沙箱 tab ── -->
        <div class="settings-tab" data-tab="security">
          <div class="settings-section">
            <div class="settings-section-label">文件沙箱</div>
            <p class="settings-hint">开启后文件读写只允许在 sandbox/ 目录内。关闭后 Agent 可操作系统任意位置的文件，请谨慎使用。</p>
            <div class="settings-row">
              <label class="settings-label" for="security-file-sandbox">启用文件沙箱</label>
              <label class="settings-toggle">
                <input type="checkbox" id="security-file-sandbox" checked>
                <span class="settings-toggle-track"></span>
              </label>
            </div>
          </div>
          <div class="settings-section">
            <div class="settings-section-label">命令执行沙箱</div>
            <p class="settings-hint">开启后 exec_command 工作目录锁定在 sandbox/，且禁止使用绝对路径和父目录引用。关闭后命令可访问系统任意目录。</p>
            <div class="settings-row">
              <label class="settings-label" for="security-exec-sandbox">启用执行沙箱</label>
              <label class="settings-toggle">
                <input type="checkbox" id="security-exec-sandbox" checked>
                <span class="settings-toggle-track"></span>
              </label>
            </div>
          </div>
          <div class="settings-section">
            <div class="settings-section-label">局域网访问</div>
            <p class="settings-hint">允许同一局域网内的设备访问本机爻台 API，用于多台爻台互相通信。开启或关闭后需要重启应用生效。</p>
            <div class="settings-row">
              <label class="settings-label" for="security-lan-access">允许局域网访问</label>
              <label class="settings-toggle">
                <input type="checkbox" id="security-lan-access">
                <span class="settings-toggle-track"></span>
              </label>
            </div>
          </div>
          <div class="settings-section">
            <div class="settings-section-label">工具黑名单</div>
            <p class="settings-hint">勾选后该工具将被拒绝执行，对话中 Agent 调用时会收到"已被安全策略禁用"错误。</p>
            <div class="settings-row"><label class="settings-label"><input type="checkbox" class="security-blocked-tool" value="exec_command"> exec_command &nbsp;<span style="color:var(--ink2);font-size:12px;">（执行 shell 命令）</span></label></div>
            <div class="settings-row"><label class="settings-label"><input type="checkbox" class="security-blocked-tool" value="browser_read"> browser_read &nbsp;<span style="color:var(--ink2);font-size:12px;">（浏览器渲染访问）</span></label></div>
            <div class="settings-row"><label class="settings-label"><input type="checkbox" class="security-blocked-tool" value="fetch_url"> fetch_url &nbsp;<span style="color:var(--ink2);font-size:12px;">（HTTP 请求）</span></label></div>
            <div class="settings-row"><label class="settings-label"><input type="checkbox" class="security-blocked-tool" value="web_search"> web_search &nbsp;<span style="color:var(--ink2);font-size:12px;">（网页搜索）</span></label></div>
            <div class="settings-row"><label class="settings-label"><input type="checkbox" class="security-blocked-tool" value="ui_set"> ui_set &nbsp;<span style="color:var(--ink2);font-size:12px;">（投影声明式界面 surface）</span></label></div>
          </div>
          <div class="settings-section settings-section-action">
            <button class="settings-save-btn" id="settings-save-security" type="button">保存</button>
            <button class="settings-save-btn hidden" id="settings-restart-security" type="button" style="width:auto;padding:0 14px;">立即重启</button>
            <span class="settings-feedback" id="settings-security-feedback"></span>
          </div>
        </div>

        <!-- ── 技能 tab ── -->
        <div class="settings-tab" data-tab="skills">
          <div class="settings-section">
            <div class="settings-section-label">Agent Skills（技能包）</div>
            <p class="settings-hint">可复用的 SKILL.md 工作流包。让 AI 用 <code>learn_skill</code> 从经验里学新技能，或用 <code>improve_skill</code> 在使用中改进。此处查看/删除已安装技能。</p>
            <div class="settings-row">
              <button id="skills-refresh-btn" type="button" class="settings-save-btn">刷新列表</button>
              <span class="settings-feedback" id="skills-feedback" style="margin-left:8px;"></span>
            </div>
            <div id="skills-list" class="settings-list"><div class="settings-hint">加载中…</div></div>
          </div>
        </div>

        <!-- ── MCP tab ── -->
        <div class="settings-tab" data-tab="mcp">
          <div class="settings-section">
            <div class="settings-section-label">MCP 服务器</div>
            <p class="settings-hint">Model Context Protocol 服务器白名单（存于 <code>data/mcp-servers.json</code>）。配置后可用 <code>mcp_list_servers</code> / <code>mcp_call</code> 调用外部服务。只会运行这里显式列出的服务器。</p>
            <div class="settings-row">
              <button id="mcp-refresh-btn" type="button" class="settings-save-btn">刷新列表</button>
              <span class="settings-feedback" id="mcp-feedback" style="margin-left:8px;"></span>
            </div>
            <div id="mcp-list" class="settings-list"><div class="settings-hint">加载中…</div></div>
          </div>
          <div class="settings-section">
            <div class="settings-section-label">常用模板</div>
            <p class="settings-hint">点击一个模板即可填入下方的添加表单，确认后点击「添加」。filesystem 模板需要额外填写一个路径参数。</p>
            <div class="mcp-presets" id="mcp-presets"></div>
          </div>
          <div class="settings-section">
            <div class="settings-section-label">添加服务器</div>
            <div class="settings-row">
              <label class="settings-label" for="mcp-new-name">名称</label>
              <input class="settings-input" id="mcp-new-name" type="text" placeholder="如 filesystem" autocomplete="off" spellcheck="false">
            </div>
            <div class="settings-row">
              <label class="settings-label" for="mcp-new-command">命令</label>
              <input class="settings-input" id="mcp-new-command" type="text" placeholder="如 npx / node / python" autocomplete="off" spellcheck="false">
            </div>
            <div class="settings-row">
              <label class="settings-label" for="mcp-new-args">参数</label>
              <input class="settings-input" id="mcp-new-args" type="text" placeholder="JSON 数组，如 [\"-y\",\"@modelcontextprotocol/server-filesystem\"]" autocomplete="off" spellcheck="false">
            </div>
            <div class="settings-row-action">
              <button class="settings-save-btn" id="mcp-add-btn" type="button">添加</button>
            </div>
          </div>
        </div>

        <!-- ── 用量 tab ── -->
        <div class="settings-tab" data-tab="insights">
          <div class="settings-section">
            <div class="settings-section-label">用量洞察</div>
            <p class="settings-hint">最近 7 天的 LLM 调用、token 消耗、估算成本与常用工具。数据来自每次 LLM 调用持久化的用量记录。</p>
            <div class="settings-row">
              <button id="insights-refresh-btn" type="button" class="settings-save-btn">刷新</button>
              <span class="settings-feedback" id="insights-feedback" style="margin-left:8px;"></span>
            </div>
            <div id="insights-report" class="settings-list"><div class="settings-hint">加载中…</div></div>
          </div>
        </div>

        <!-- ── 高级功能 tab ── -->
        <div class="settings-tab" data-tab="advanced">
          <div class="settings-section">
            <div class="settings-section-label">地图服务</div>
            <p class="settings-hint">为台风监测、位置、行程等功能提供统一真实地图。凭证仅保存在本机加密存储中，不会写入项目源码或返回安全密钥明文。</p>
            <div class="settings-config-row">
              <span class="settings-config-type">状态</span>
              <span class="settings-config-info" id="settings-map-status">正在检查…</span>
              <span class="settings-config-dot" id="settings-map-status-dot"></span>
            </div>
            <div class="settings-row">
              <label class="settings-label" for="settings-map-provider">地图服务商</label>
              <select class="settings-select" id="settings-map-provider">
                <option value="amap">高德地图 JS API 2.0</option>
              </select>
            </div>
            <div class="settings-row">
              <label class="settings-label" for="settings-amap-key">Web 端 Key</label>
              <input class="settings-input" id="settings-amap-key" type="password" placeholder="留空保持现有 Key 不变" autocomplete="new-password" spellcheck="false">
            </div>
            <div class="settings-row">
              <label class="settings-label" for="settings-amap-security">安全密钥</label>
              <input class="settings-input" id="settings-amap-security" type="password" placeholder="securityJsCode，留空保持不变" autocomplete="new-password" spellcheck="false">
            </div>
            <p class="settings-hint">请在高德开放平台创建“Web端（JS API）”Key。安全密钥只在本地代理请求中使用，地图页面无法读取其明文。配置好后在对话里说「打开地图看看北京」即可调用。</p>
            <div class="settings-row-action" style="gap:8px;flex-wrap:wrap;">
              <button class="settings-save-btn" id="settings-save-map" type="button">保存地图配置</button>
              <button class="settings-save-btn" id="settings-test-map" type="button" style="width:auto;padding:0 14px;">测试地图</button>
              <button class="settings-save-btn" id="settings-clear-map" type="button" style="width:auto;padding:0 14px;background:transparent;border:1px solid var(--line);color:var(--ink2);">清除</button>
              <a href="https://console.amap.com/dev/key/app" target="_blank" rel="noreferrer" class="settings-map-link">申请高德 Key ↗</a>
              <span class="settings-feedback" id="settings-map-feedback"></span>
            </div>
          </div>
          <div class="settings-section">
            <div class="settings-section-label">共用范围</div>
            <p class="settings-hint">配置一次后，台风监测、天气灾害、位置卡片和后续地图页面都会通过统一 MapService 使用同一地图服务。</p>
          </div>
        </div>

        <!-- ── 更新 tab ── -->
        <div class="settings-tab" data-tab="update">
          <div class="settings-section">
            <div class="settings-section-label">版本信息</div>
            <div class="settings-config-row">
              <span class="settings-config-type">当前版本</span>
              <span class="settings-config-info" id="settings-current-version">—</span>
            </div>
            <div class="settings-config-row">
              <span class="settings-config-type">状态</span>
              <span class="settings-config-info" id="settings-update-status">未检查</span>
            </div>
            <div class="settings-row-action" style="margin-top:12px;gap:8px;flex-wrap:wrap;">
              <button class="settings-save-btn" id="settings-check-update-btn" type="button" style="width:auto;padding:0 14px;">检查更新</button>
              <button class="settings-save-btn hidden" id="settings-download-update-btn" type="button" style="width:auto;padding:0 14px;">立即下载</button>
              <button class="settings-save-btn hidden" id="settings-install-update-btn" type="button" style="width:auto;padding:0 14px;">立即重启安装</button>
              <button class="settings-save-btn hidden" id="settings-ignore-update-btn" type="button" style="width:auto;padding:0 14px;background:transparent;border:1px solid var(--line);color:var(--ink2);">忽略此版本</button>
              <span class="settings-feedback" id="settings-update-feedback"></span>
            </div>
          </div>
          <div class="settings-section">
            <div class="settings-section-label">通知偏好</div>
            <div class="settings-row">
              <label class="settings-label" for="settings-suppress-updates">不再提醒更新</label>
              <label class="settings-toggle">
                <input type="checkbox" id="settings-suppress-updates">
                <span class="settings-toggle-track"></span>
              </label>
            </div>
            <p class="settings-hint">开启后发现新版本时不会弹出提示卡片，仍可在此处手动检查。</p>
          </div>
          <div class="settings-section" id="settings-ignored-section" style="display:none;">
            <div class="settings-section-label">已忽略的版本</div>
            <div class="settings-row">
              <span class="settings-config-info" id="settings-ignored-version-val">—</span>
              <button class="settings-save-btn" id="settings-clear-ignored-btn" type="button" style="width:auto;padding:0 12px;margin-left:auto;">清除忽略</button>
            </div>
          </div>
        </div>

      </div><!-- /settings-content -->
    </div><!-- /settings-body -->
  </div>
</div>
`;

const createVoicePanel = () => `
<div class="voice-panel" id="voice-panel">
  <canvas id="voice-canvas" width="160" height="160" title="太极八卦 · 点击打开易学看板（语音开关在 🎤）"></canvas>
  <canvas id="voice-fallback-canvas" width="160" height="160" hidden title="太极八卦 · 点击打开易学看板（语音开关在 🎤）"></canvas>
  <div class="voice-transcript" id="voice-transcript"></div>
</div>
`;

const createVideoPanel = () => `
<div class="video-panel" id="video-panel">
  <div class="media-stage-head">
    <div class="media-stage-title" id="video-title">视频</div>
    <button class="video-exit-btn" id="video-exit-btn" type="button" title="关闭视频">x</button>
  </div>
  <div class="video-input-bar">
    <input id="video-url-input" type="text" placeholder="粘贴 YouTube / Bilibili / 直链 .mp4 链接…" autocomplete="off" spellcheck="false" />
    <button id="video-url-play" type="button" title="播放">▶</button>
  </div>
  <div class="video-status" id="video-status" hidden></div>
  <div class="video-surface" id="video-surface">
    <div class="video-backdrop" id="video-backdrop"></div>
    <video id="video-feed" playsinline controls></video>
    <iframe id="video-frame" title="视频播放器" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen hidden></iframe>
    <div class="video-empty" id="video-empty">无视频源</div>
  </div>
  <div class="video-recent">
    <div class="video-recent-title">最近播放</div>
    <div class="video-recent-list" id="video-recent-list"></div>
  </div>
</div>
`;

const createAIVideoPanel = () => `
<div class="aivideo-panel" id="aivideo-panel">
  <div class="media-stage-head">
    <div class="media-stage-title">AI 视频生成</div>
    <div class="aivideo-head-spacer"></div>
    <button class="aivideo-new-btn" id="aivideo-new-btn" type="button" title="清空输入">+ 新视频</button>
    <button class="aivideo-exit-btn" id="aivideo-exit-btn" type="button" title="关闭 (Esc)">×</button>
  </div>

  <!-- 区1 生成栏 -->
  <div class="aivideo-queue-wrap">
    <div class="aivideo-queue-cap">生成栏 · QUEUE</div>
    <div class="aivideo-queue" id="aivideo-queue"></div>
  </div>

  <!-- 区2 播放区 -->
  <div class="aivideo-player">
    <div class="aivideo-stage is-empty" id="aivideo-stage">
      <video id="aivideo-feed" class="aivideo-feed" playsinline controls hidden></video>
      <button class="aivideo-dl" id="aivideo-dl" type="button" hidden>↓ 下载</button>
      <div class="aivideo-stage-empty" id="aivideo-stage-empty">
        <svg class="aivideo-empty-icon" viewBox="0 0 48 48" fill="none" aria-hidden="true">
          <rect x="6" y="9" width="36" height="30" rx="4" stroke="currentColor" stroke-width="2"/>
          <circle cx="16.5" cy="19" r="3.5" stroke="currentColor" stroke-width="2"/>
          <path d="M9 33l9-9 7 7 6-5 8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <div class="aivideo-empty-text">暂无资源</div>
        <div class="aivideo-empty-sub">在下方输入提示词或加图，点“生成”</div>
      </div>
    </div>
    <div class="aivideo-player-meta" id="aivideo-player-meta"></div>
  </div>

  <!-- 区3 输入区 -->
  <div class="aivideo-composer">
    <div class="aivideo-dropzone" id="aivideo-dropzone"></div>
    <div class="aivideo-modebar">
      <span class="aivideo-modetag" id="aivideo-modetag">文生视频</span>
      <span class="aivideo-modehint" id="aivideo-modehint">不加图 = 文生视频 · 1 张 = 图生视频 · 2 张 = 首尾帧</span>
    </div>
    <textarea id="aivideo-prompt-input" class="aivideo-prompt-input" rows="1"
      placeholder="描述你想要的画面、动作、镜头运动、光线、风格…（Ctrl+Enter 生成）"></textarea>
    <div class="aivideo-controls">
      <select id="aivideo-ratio" title="画面比例">
        <option value="adaptive">适配图片</option>
        <option value="16:9" selected>16:9</option><option value="9:16">9:16</option><option value="1:1">1:1</option>
        <option value="4:3">4:3</option><option value="3:4">3:4</option><option value="21:9">21:9</option>
      </select>
      <select id="aivideo-resolution" title="分辨率">
        <option value="480p">480p</option><option value="720p" selected>720p</option><option value="1080p">1080p</option>
      </select>
      <select id="aivideo-duration" title="时长（秒）">
        <option value="5" selected>5s</option><option value="10">10s</option><option value="15">15s</option>
      </select>
      <button type="button" class="aivideo-submit" id="aivideo-submit">生成</button>
    </div>
    <div class="aivideo-compose-err" id="aivideo-compose-err" hidden></div>
  </div>

  <input type="file" id="aivideo-file-input" accept="image/*" hidden>
</div>
`;

const createMusicPanel = () => `
<div class="music-panel" id="music-panel">
  <div class="media-stage-head">
    <div class="media-stage-title" id="music-panel-title">音乐 · 本地曲库</div>
    <button class="music-exit-btn" id="music-exit-btn" type="button" title="退出音乐模式">×</button>
  </div>

  <div class="music-body">
    <div class="music-main">
      <div class="music-turntable">
        <div class="music-vinyl" id="music-vinyl">
          <div class="music-groove music-groove-1"></div>
          <div class="music-groove music-groove-2"></div>
          <div class="music-groove music-groove-3"></div>
          <div class="music-groove music-groove-4"></div>
          <div class="music-cover" id="music-cover">
            <div class="music-cover-title" id="music-cover-title">♪</div>
            <div class="music-cover-artist" id="music-cover-artist"></div>
          </div>
          <div class="music-spindle"></div>
        </div>
        <div class="music-tonearm-group" id="music-tonearm-group">
          <div class="music-tonearm-pivot"></div>
          <div class="music-arm-shaft"></div>
          <div class="music-headshell">
            <div class="music-stylus"></div>
          </div>
        </div>
      </div>
      <div class="music-lyrics-pane" id="music-lyrics-pane">
        <div class="music-lyrics-scroll" id="music-lyrics-scroll"></div>
        <div class="music-no-lyrics" id="music-no-lyrics" hidden>— 无歌词 —</div>
      </div>
    </div>

    <div class="music-library">
      <div class="music-library-head">
        <input class="music-search" id="music-search" type="text" placeholder="搜索曲库（歌名 / 歌手）" autocomplete="off" spellcheck="false" />
        <button class="music-scan" id="music-scan" type="button" title="扫描 music 目录入库">⟳</button>
      </div>
      <div class="music-library-list" id="music-library-list">
        <div class="music-library-empty">曲库为空 · 点击「⟳ 扫描」从 music/ 目录收录，或直接让 AI 帮你下载</div>
      </div>
      <div class="music-add-row">
        <input class="music-add-path" id="music-add-path" type="text" placeholder="本地音频路径（可选）" autocomplete="off" spellcheck="false" />
        <button class="music-add-btn" id="music-add-btn" type="button" title="添加本地文件到曲库">＋</button>
      </div>
    </div>
  </div>

  <div class="music-footer">
    <div class="music-meta">
      <div class="music-meta-title" id="music-meta-title">—</div>
      <div class="music-meta-artist" id="music-meta-artist">—</div>
    </div>
    <div class="music-progress-row">
      <span class="music-time" id="music-time-cur">0:00</span>
      <input class="music-seek" id="music-seek" type="range" min="0" max="100" step="0.1" value="0">
      <span class="music-time" id="music-time-total">0:00</span>
    </div>
    <div class="music-controls-row">
      <button class="music-ctrl music-ctrl-mode" id="music-mode" type="button" title="播放模式：列表循环 / 单曲循环 / 随机播放">🔁</button>
      <button class="music-ctrl" id="music-prev" type="button" title="上一首">⏮</button>
      <button class="music-ctrl music-ctrl-play" id="music-play" type="button" title="播放/暂停">▶</button>
      <button class="music-ctrl" id="music-next" type="button" title="下一首">⏭</button>
      <input class="music-vol" id="music-vol" type="range" min="0" max="1" step="0.01" value="0.8" title="音量">
    </div>
  </div>
  <audio id="music-audio" preload="auto"></audio>
</div>
`;

const createImagePanel = () => `
<div class="image-panel" id="image-panel">
  <div class="media-stage-head">
    <div class="media-stage-title" id="image-title">图片</div>
    <button class="image-exit-btn" id="image-exit-btn" type="button" title="关闭图片">x</button>
  </div>
  <div class="image-surface" id="image-surface">
    <img id="image-display" alt="" />
    <div class="image-empty" id="image-empty">无图片源</div>
  </div>
</div>
`;

const createApprovalsModal = () => `
<div class="approvals-overlay" id="approvals-overlay" hidden>
  <div class="approvals-modal" role="dialog" aria-modal="true" aria-label="审批中心">
    <div class="approvals-head">
      <span class="approvals-title">☑ 审批中心</span>
      <button class="approvals-close" id="approvals-close" type="button" aria-label="关闭">×</button>
    </div>
    <div class="approvals-sub" id="approvals-sub">加载中…</div>
    <div class="approvals-list" id="approvals-list"></div>
    <div class="approvals-empty" id="approvals-empty" hidden>暂无待审批事项</div>
  </div>
</div>
`;

const createMapPanel = () => `
<div class="map-panel" id="map-panel" hidden>
  <div class="map-panel-head">
    <span class="map-panel-title" id="map-panel-title">地图</span>
    <span class="map-panel-status" id="map-status"></span>
    <button class="map-panel-exit" id="map-panel-exit" type="button" title="关闭地图">×</button>
  </div>
  <div class="map-panel-body">
    <div class="map-canvas" id="map-canvas"></div>
  </div>
</div>
`;/* ═══════════════ 侧边导航（参照 workspace.html） ═══════════════ */
const createSidebar = () => `
<aside class="sidebar" id="sidebar">
  <div class="nav-section-title">导航</div>
  <div class="nav-item active" data-page="dashboard" title="作战指挥中心">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
    <span>作战指挥</span>
    <span class="nav-badge cyan" id="sidebar-badge-todo" style="display:none">0</span>
  </div>
  <div class="nav-item" data-page="chat" title="与爻台对话">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
    <span>AI 对话</span>
  </div>
  <div class="nav-item" data-page="multiagent" title="多Agent办公室（原多智能体会议室 / 军机处）">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
    <span>多Agent办公室</span>
  </div>
  <div class="nav-item" data-page="workbench" title="待办工作台">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
    <span>待办工作</span>
  </div>
  <div class="nav-item" data-page="backup" title="数据备份">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
    <span>数据备份</span>
  </div>
  <div class="nav-section-title">能力</div>
  <div class="nav-item" data-page="knowledge" title="知识库（RAG）：导入文档 / 检索 / 管理">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
    <span>知识库</span>
  </div>
  <div class="nav-item" data-page="workflow" title="工作流：模板 / 已保存流程 / 一键运行">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
    <span>工作流</span>
  </div>
  <div class="nav-item" data-page="observability" title="用量监控：成本 / token / 工具使用">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
    <span>用量监控</span>
  </div>
</aside>
`;

/* ═══════════════ 主区页面（作战指挥 / 待办工作 / 数据备份） ═══════════════ */
const createMainPages = () => `
<main class="main" id="main">
  <!-- 作战指挥中心 -->
  <div class="page" id="page-dashboard">
    <div class="page-header">
      <div>
        <div class="page-title">作战指挥中心</div>
        <div class="page-subtitle">今日待办 · 记忆图谱 · 项目进度 · 一切尽在掌握</div>
      </div>
    </div>
    <div class="briefing">
      <div class="card metric-card card-glow">
        <div class="card-title">今日待办</div>
        <div class="metric-value" id="dash-todo">0</div>
        <div class="metric-label">条待办事项</div>
      </div>
      <div class="card metric-card purple card-glow">
        <div class="card-title">已完成</div>
        <div class="metric-value" id="dash-done">0</div>
        <div class="metric-label">条已完成</div>
      </div>
      <div class="card metric-card orange card-glow">
        <div class="card-title">记忆节点</div>
        <div class="metric-value" id="dash-nodes">0</div>
        <div class="metric-label">条记忆图谱</div>
      </div>
      <div class="card metric-card card-glow">
        <div class="card-title">连接状态</div>
        <div class="metric-value" id="dash-conn">●</div>
        <div class="metric-label" id="dash-conn-label">Token流</div>
      </div>
    </div>
    <div class="dash-grid">
      <div class="card card-glow">
        <div class="section-header"><div class="section-title">今日待办</div><div style="font-size:11px;color:var(--dim)">点击快速处理</div></div>
        <div class="today-list" id="dash-todo-list"></div>
      </div>
      <div class="card card-glow">
        <div class="section-header"><div class="section-title">记忆图谱</div><button class="dash-graph-btn" id="dash-graph-btn" type="button" title="全屏查看记忆图谱">⛶ 全屏图谱</button></div>
        <div class="dash-graph-wrap" id="dash-graph-wrap">
          <canvas id="dash-graph" class="dash-graph-canvas" aria-label="记忆图谱"></canvas>
          <div class="dash-graph-empty" id="dash-graph-empty">记忆图谱未开启 · 在设置 → 外观中开启</div>
        </div>
        <div class="legend" id="dash-legend"></div>
      </div>
    </div>
  </div>

  <!-- 多Agent办公室（v4 办公桌版：CEO 决策者坐镇会议桌，各员工在工位） -->
  <div class="page" id="page-multiagent">
    <div class="office-panel" id="multiagent-panel">
      <header class="office-head">
        <div class="office-logo">🐾 多Agent办公室 <small>v4</small></div>
        <div class="office-stats">
          <span class="office-stat"><i class="office-dot" style="background:#22b07d"></i>工作 <b id="c-w">0</b></span>
          <span class="office-stat"><i class="office-dot" style="background:#e8a13a"></i>思考 <b id="c-t">0</b></span>
          <span class="office-stat"><i class="office-dot" style="background:#9aa1b1"></i>空闲 <b id="c-i">0</b></span>
          <span class="office-stat">✅ 完成 <b id="c-d">0</b></span>
          <span class="office-clock" id="office-clock">--:--:--</span>
        </div>
        <button class="office-exit" id="multiagent-exit" type="button" title="退出多Agent办公室">×</button>
      </header>

      <main class="office-main">
        <div class="office-stage" id="office-stage">
          <div class="office-floor" id="office-floor">
            <div class="office-table"><span>信息交互区 · 会议桌</span></div>
            <div class="office-tip">输入指令 → CEO 拆解分派 → 员工执行并到会议桌汇报</div>
          </div>
        </div>

        <div class="office-side">
          <div class="office-sec-title">AGENT 档案</div>
          <div class="office-card" id="office-agent-card"></div>
          <div class="office-sec-title">💬 对话 &amp; 日志</div>
          <div class="office-messages" id="office-messages"></div>
        </div>
      </main>

      <footer class="office-foot">
        <input id="ma-input" placeholder="输入指令或任务，例如：整理本周会议纪要…（@点名某员工则直接交给他）" autocomplete="off" spellcheck="false" />
        <button id="ma-send" type="button">📣 发送</button>
      </footer>
    </div>
  </div>

  <!-- 待办工作台 -->
  <div class="page" id="page-workbench">
    <div class="page-header">
      <div>
        <div class="page-title">待办工作台</div>
        <div class="page-subtitle">管理任务 · 完成进度 · 每周复盘</div>
      </div>
    </div>
    <div class="card card-glow">
      <div class="task-tabs">
        <div class="task-tab active" data-wt="pending">待办</div>
        <div class="task-tab" data-wt="done">已完成</div>
      </div>
      <div class="task-list" id="wb-page-list"></div>
      <div class="add-task-bar">
        <input id="wb-page-input" placeholder="+ 添加待办（回车确认）" autocomplete="off">
        <button class="btn btn-primary" id="wb-page-add">添加</button>
      </div>
    </div>
  </div>

  <!-- 数据备份 -->
  <div class="page" id="page-backup">
    <div class="page-header">
      <div>
        <div class="page-title">数据备份</div>
        <div class="page-subtitle">导出 JSON · 导入恢复</div>
      </div>
    </div>
    <div class="card card-glow">
      <div class="settings-row">
        <div><div class="settings-label">📥 导出 JSON 备份</div><div class="settings-desc">下载当前记忆与待办数据</div></div>
        <button class="btn" id="backup-export">导出</button>
      </div>
      <div class="settings-row">
        <div><div class="settings-label">📤 导入恢复</div><div class="settings-desc">从 JSON 备份恢复（覆盖当前待办）</div></div>
        <label class="btn">选择文件<input type="file" id="backup-file" accept=".json" hidden></label>
      </div>
    </div>
  </div>

  <!-- 知识库（RAG） -->
  <div class="page" id="page-knowledge">
    <div class="page-header">
      <div>
        <div class="page-title">知识库</div>
        <div class="page-subtitle">导入文档 → 自动分块建索引 → 对话中直接检索引用</div>
      </div>
      <button class="btn btn-primary" id="kb-refresh" type="button">⟳ 刷新</button>
    </div>
    <div class="kb-grid">
      <div class="card metric-card card-glow"><div class="card-title">文档</div><div class="metric-value" id="kb-docs">0</div></div>
      <div class="card metric-card purple card-glow"><div class="card-title">分块</div><div class="metric-value" id="kb-chunks">0</div></div>
      <div class="card metric-card orange card-glow"><div class="card-title">向量覆盖率</div><div class="metric-value" id="kb-coverage">—</div></div>
      <div class="card metric-card card-glow"><div class="card-title">总字符</div><div class="metric-value" id="kb-chars">0</div></div>
    </div>
    <div class="card card-glow kb-search-card">
      <div class="section-header"><div class="section-title">检索</div><div style="font-size:11px;color:var(--dim)">在已导入文档中检索相关内容</div></div>
      <div class="kb-search-row">
        <input id="kb-search-input" class="settings-input" type="text" placeholder="输入检索词，如：应急预案、API 文档、成本核算…" autocomplete="off" spellcheck="false">
        <button class="btn btn-primary" id="kb-search-btn" type="button">检索</button>
      </div>
      <div class="kb-results" id="kb-results"></div>
    </div>
    <div class="card card-glow">
      <div class="section-header"><div class="section-title">已导入文档</div><div style="font-size:11px;color:var(--dim)">删除不可恢复</div></div>
      <div class="kb-doc-list" id="kb-doc-list"></div>
    </div>
  </div>

  <!-- 工作流（Coze 风格可视化编辑器） -->
  <div class="page" id="page-workflow">
    <div class="page-header">
      <div>
        <div class="page-title">工作流编辑器</div>
        <div class="page-subtitle">可视化编排 · 节点串联 · 一键运行（参考 Coze/扣子）</div>
      </div>
      <div class="wf-header-actions">
        <select class="settings-select" id="wf-load-select" title="从模板或已保存工作流加载"><option value="">从模板 / 已保存加载…</option></select>
        <button class="btn" id="wf-new" type="button" title="新建空白工作流">＋ 新建</button>
        <button class="btn" id="wf-save" type="button" title="保存当前工作流">💾 保存</button>
        <button class="btn btn-primary" id="wf-run" type="button">▶ 运行</button>
      </div>
    </div>

    <div class="wf-editor">
      <!-- 左：节点面板 -->
      <div class="wf-palette" id="wf-palette">
        <div class="wf-palette-title">节点</div>
        <button type="button" data-type="start" title="起始节点（唯一）">▶ 开始</button>
        <button type="button" data-type="end" title="结束节点（可多个）">■ 结束</button>
        <button type="button" data-type="llm" title="调用 LLM">🧠 LLM</button>
        <button type="button" data-type="tool" title="调用内置工具">🔧 工具</button>
        <button type="button" data-type="condition" title="条件分支（真/假）">❓ 条件</button>
        <button type="button" data-type="loop" title="对数组逐项执行">🔁 循环</button>
        <button type="button" data-type="parallel" title="并行分支">⫸ 并行</button>
        <button type="button" data-type="approval" title="人工审批（HITL）">☑ 审批</button>
        <button type="button" data-type="code" title="JS 代码节点">{} 代码</button>
      </div>

      <!-- 中：画布 -->
      <div class="wf-canvas" id="wf-canvas">
        <div class="wf-canvas-toolbar">
          <button id="wf-zoom-out" type="button" title="缩小">−</button>
          <span class="wf-zoom-val" id="wf-zoom-val">100%</span>
          <button id="wf-zoom-in" type="button" title="放大">＋</button>
          <button id="wf-zoom-fit" type="button" title="适配画布">⤢ 适配</button>
          <button id="wf-layout" type="button" title="自动布局">⇅ 自动布局</button>
        </div>
        <div class="wf-canvas-viewport" id="wf-canvas-viewport">
          <svg class="wf-edges" id="wf-edges" aria-hidden="true"></svg>
          <div class="wf-nodes" id="wf-nodes"></div>
        </div>
        <div class="wf-canvas-empty" id="wf-canvas-empty">从左侧添加节点，或用上方「从模板加载」开始<br><span style="font-size:11px;opacity:.7">拖拽节点自由摆放 · 滚轮缩放 · 拖空白平移</span></div>
      </div>

      <!-- 右：节点配置面板 -->
      <div class="wf-inspector" id="wf-inspector">
        <div class="wf-inspector-empty" id="wf-inspector-empty">点击画布中的节点<br>在右侧配置它的参数与连线</div>
        <div class="wf-inspector-body" id="wf-inspector-body" hidden>
          <div class="wf-ins-head">
            <span class="wf-ins-type" id="wf-ins-type"></span>
            <button class="wf-ins-del" id="wf-ins-del" type="button" title="删除节点">🗑 删除</button>
          </div>
          <div class="wf-ins-row"><label class="wf-ins-label">节点名称</label><input class="settings-input" id="wf-ins-name" type="text" autocomplete="off" spellcheck="false"></div>
          <div id="wf-ins-config"><!-- 按节点类型生成的配置表单 --></div>
          <div id="wf-ins-next"><!-- 连线目标选择 --></div>
          <div id="wf-ins-runout" hidden><!-- 运行输出检视 --></div>
        </div>
      </div>
    </div>

    <!-- 运行区 -->
    <div class="card card-glow wf-run-bar">
      <div class="wf-run-input-row">
        <textarea id="wf-run-input" class="settings-input" rows="2" placeholder='输入参数（JSON 或纯文本，纯文本将作为 input 传入），如 {"input":"你好"} / {"code":"print(1)"}'></textarea>
        <button class="btn btn-primary" id="wf-run-exec" type="button" style="flex:none;">▶ 执行</button>
      </div>
      <div class="wf-run-status" id="wf-run-status"></div>
      <div class="wf-exec-log" id="wf-exec-log"></div>
    </div>
  </div>

  <!-- 用量监控 -->
  <div class="page" id="page-observability">
    <div class="page-header">
      <div>
        <div class="page-title">用量监控</div>
        <div class="page-subtitle">LLM 调用成本 · token 消耗 · 工具使用 · 延迟</div>
      </div>
      <button class="btn btn-primary" id="obs-refresh" type="button">⟳ 刷新</button>
    </div>
    <div class="kb-grid">
      <div class="card metric-card card-glow"><div class="card-title">总成本</div><div class="metric-value" id="obs-cost">—</div></div>
      <div class="card metric-card purple card-glow"><div class="card-title">调用次数</div><div class="metric-value" id="obs-calls">0</div></div>
      <div class="card metric-card orange card-glow"><div class="card-title">Token 总量</div><div class="metric-value" id="obs-tokens">0</div></div>
      <div class="card metric-card card-glow"><div class="card-title">平均延迟</div><div class="metric-value" id="obs-latency">—</div></div>
    </div>
    <div class="dash-grid">
      <div class="card card-glow">
        <div class="section-header"><div class="section-title">按模型成本 Top</div></div>
        <div class="obs-model-list" id="obs-model-list"></div>
      </div>
      <div class="card card-glow">
        <div class="section-header"><div class="section-title">常用工具</div></div>
        <div class="obs-tool-list" id="obs-tool-list"></div>
      </div>
    </div>
    <div class="card card-glow">
      <div class="section-header"><div class="section-title">每日趋势</div></div>
      <div class="obs-daily" id="obs-daily"></div>
    </div>
    <div class="card card-glow">
      <div class="section-header"><div class="section-title">最昂贵调用 Top 5</div></div>
      <div class="obs-expensive" id="obs-expensive"></div>
    </div>
  </div>
</main>
`;

export function createBrainUiMarkup() {
  return [
    createNavbar(),
    createSidebar(),
    createMainPages(),
    createGraphStage(),
    createSecondaryPanel(),
    createConsole(),
    createTooltip(),
    createSettingsModal(),
    createMultiAgentConfigOverlay(),
    createApprovalsModal(),
    createVideoPanel(),
    createAIVideoPanel(),
    createMusicPanel(),
    createImagePanel(),
    createMapPanel(),
    createHotspotPanel(),
    createWorldcupPanel(),
    createTyphoonPanel(),
    createPersonCardPanel(),
    createDocPanel(),
    createBaguaPanel(),
  ].join("\n\n");
}

export function renderBrainUiApp(root = document.body) {
  root.dataset.theme = "neon";
  root.innerHTML = createBrainUiMarkup();
}
