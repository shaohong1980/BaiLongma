// bagua-panel.js —— 「易经 · 易学看板」面板骨架（纯静态 markup，交互由 bagua.js 驱动）
export const createBaguaPanel = () => `
<div class="bagua-panel" id="bagua-panel">

  <!-- ── 顶部标题栏 ── -->
  <div class="bg-header">
    <div class="bg-brand">
      <span class="bg-brand-sym">☰☷</span>
      <div class="bg-brand-text">
        <div class="bg-brand-title">易经 · 易学看板</div>
        <div class="bg-brand-sub">I CHING · 太极 · 八卦 · 六十四卦</div>
      </div>
    </div>
    <div class="bg-header-right">
      <div class="bg-clock-block">
        <div class="bg-clock" id="bg-clock">--:--:--</div>
        <div class="bg-live-dot">● 阴阳五行 · 易理实时</div>
      </div>
      <button class="bg-exit-btn" id="bg-exit-btn" type="button" title="关闭易学看板 (Esc)">×</button>
    </div>
  </div>

  <!-- ── 主体三栏 ── -->
  <div class="bg-body">

    <!-- 左栏：太极八卦 + 起卦 -->
    <div class="bg-col bg-col-left">
      <div class="bg-taiji-card">
        <div class="bg-card-title">太极 · 八卦 <span class="bg-card-sub">先天图</span></div>
        <div class="bg-taiji-canvas-wrap">
          <canvas id="bg-canvas" class="bg-canvas" aria-label="太极八卦图"></canvas>
          <div class="bg-taiji-hint">拖拽旋转 · 滚轮缩放</div>
        </div>
        <div class="bg-trigram-legend" id="bg-trigram-legend"></div>
      </div>

      <div class="bg-cast-card">
        <div class="bg-card-title">六爻起卦 <span class="bg-card-sub">三枚铜钱 · 自下而上</span></div>
        <button class="bg-cast-btn" id="bg-cast-btn" type="button">⚭ 摇一卦</button>
        <div class="bg-cast-result" id="bg-cast-result">
          <div class="bg-cast-hint">点击「摇一卦」，用三枚铜钱掷六次成卦，查看本卦与变卦。</div>
        </div>
      </div>
    </div>

    <!-- 中栏：六十四卦网格 -->
    <div class="bg-col bg-col-center">
      <div class="bg-card-title bg-grid-title">六十四卦 <span class="bg-card-sub">文王序 · 点击查看卦辞</span></div>
      <div class="bg-hexagram-grid" id="bg-hexagram-grid">
        <!-- JS 动态填充 8×8 -->
      </div>
    </div>

    <!-- 右栏：卦象详情 -->
    <div class="bg-col bg-col-right">
      <div class="bg-detail-card" id="bg-detail-card">
        <div class="bg-card-title">卦象详解</div>
        <div class="bg-detail-empty" id="bg-detail-empty">← 点击左侧 / 中部任一卦，或点「摇一卦」查看详情</div>
        <div class="bg-detail" id="bg-detail" hidden>
          <div class="bg-detail-head">
            <div class="bg-detail-sym" id="bg-detail-sym">䷀</div>
            <div class="bg-detail-head-main">
              <div class="bg-detail-name" id="bg-detail-name">乾</div>
              <div class="bg-detail-meta" id="bg-detail-meta">第 1 卦 · 乾为天</div>
            </div>
          </div>
          <div class="bg-detail-lines" id="bg-detail-lines"><!-- 六爻象 --></div>
          <div class="bg-detail-tags" id="bg-detail-tags"><!-- 上卦/下卦/五行/方位 --></div>
          <div class="bg-detail-judgment">
            <div class="bg-detail-judgment-label">卦辞 · 彖曰</div>
            <div class="bg-detail-judgment-text" id="bg-detail-judgment"></div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- ── 底部跑马灯 ── -->
  <div class="bg-ticker-bar">
    <div class="bg-ticker-inner" id="bg-ticker-inner">
      <span>☯ 一阴一阳之谓道</span><span>·</span><span>天行健，君子以自强不息</span><span>·</span><span>地势坤，君子以厚德载物</span><span>·</span><span>履霜坚冰至，积善之家必有余庆</span><span>·</span><span>潜龙勿用，见龙在田，飞龙在天</span><span>·</span><span>谦谦君子，卑以自牧</span><span>·</span><span>穷则变，变则通，通则久</span>
    </div>
  </div>

</div>
`;
