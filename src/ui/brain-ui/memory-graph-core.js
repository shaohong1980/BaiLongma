// memory-graph-core.js —— 图谱数据处理（自 app.js 拆出）
// 节点统计/着色/视觉布局计算。nodeData/linkData 由 app.js 通过 setGraphData 同步（模块级引用），
// 函数签名不变；themeColors/physicsSettings 从 ui-preferences 读取（ESM live binding）。
import { themeColors, physicsSettings } from "./ui-preferences.js";
import { createVisualOrder, shuffleArray, parseLinks, parseEntities } from "./memory-graph.js";

let _nodeData = [];
let _linkData = [];
export function setGraphData(nodeData, linkData) { _nodeData = nodeData || []; _linkData = linkData || []; }

const NODE_TYPE_COLORS = {
  knowledge:            "#4f8cff", // 知识
  fact:                 "#4ad1c0", // 事实
  self_constraint:      "#ff9f1c", // 自我约束
  focus_conclusion:     "#b898f8", // 焦点结论
  hotspot_event:        "#ff5c8a", // 热点事件
  system:               "#778397", // 系统
  task_complete:        "#6fcf97", // 任务完成
  person:               "#f2c94c", // 人物
  opinion_expressed:    "#e879f9", // 观点
  impressive_statement: "#56ccf2", // 亮点话语
  behavioral_constraint: "#eb5757", // 行为约束
  task_knowledge:       "#9b51e0", // 任务知识
  conversation:         "#ffffff", // 对话（通常走 source_ref=session_* 判定，这里兜底）
};
const NODE_TYPE_LABELS = {
  knowledge: "知识", fact: "事实", self_constraint: "自我约束",
  focus_conclusion: "焦点结论", hotspot_event: "热点事件", system: "系统",
  task_complete: "任务完成", person: "人物", opinion_expressed: "观点",
  impressive_statement: "亮点话语", behavioral_constraint: "行为约束",
  task_knowledge: "任务知识",
  conversation: "对话",
};
const NODE_TYPE_DEFAULT = "#8b95a5";

function isConversationMemory(n) {
  return typeof (n && n.source_ref) === "string" && n.source_ref.startsWith("session_");
}

// 节点/图例共用：event_type → 颜色。
// 语义主色（self/conversation/knowledge/system/task_complete/behavioral_constraint）
// 跟随主题 token（themeColors，读自 design-tokens.css），画布与 DOM 配色统一；
// 其余类型走固定分类调色板，保持图谱多色区分度。
function resolveNodeColor(type) {
  const t = themeColors;
  switch (type) {
    case "self":                 return t.warm || "#ff9f1c";
    case "conversation":         return t.ink || "#ffffff";
    case "knowledge":            return t.cool || "#4f8cff";
    case "system":               return t.dim || "#778397";
    case "task_complete":        return t.ok || "#6fcf97";
    case "behavioral_constraint": return t.danger || "#eb5757";
    default:                     return NODE_TYPE_COLORS[type] || t.dim || NODE_TYPE_DEFAULT;
  }
}

function nodeColor(d) {
  // 核心节点（自身）用暖色高亮
  if (d._core) return resolveNodeColor("self");
  // 对话记忆（与爻台的会话产生）单独一类，随主题 ink
  if (isConversationMemory(d)) return resolveNodeColor("conversation");
  // 其余按 event_type 分类着色
  return resolveNodeColor(d.event_type || "default");
}

function nodeRadius(d) {
  const base = d._core ? 9 : 3.4 + Math.min((d._deg || 0) * 0.9, 5.4);
  const childScale = 1 + Math.min(1.5, (d._childCount || 0) * 0.18);
  return base * childScale * physicsSettings.nodeSize;
}

function semanticChildTargets(node) {
  const targets = new Set();
  parseLinks(node.links).forEach(link => {
    if (!link || typeof link !== "object") return;
    const relation = String(link.relation || "").toLowerCase();
    const targetId = String(link.target_id || link.targetId || "").trim();
    if (relation === "parent_of" && targetId) targets.add(targetId);
  });
  return targets;
}

function computeDegrees() {
  const nodeById = new Map(_nodeData.map(n => [n._nid, n]));
  _nodeData.forEach(n => {
    n._deg = 0;
    n._childCount = 0;
  });
  _linkData.forEach(l => {
    const s = typeof l.source === "object" ? l.source : nodeById.get(String(l.source));
    const t = typeof l.target === "object" ? l.target : nodeById.get(String(l.target));
    if (s) s._deg = (s._deg || 0) + 1;
    if (t) t._deg = (t._deg || 0) + 1;
  });

  _nodeData.forEach(node => {
    const childTargets = semanticChildTargets(node);
    if (childTargets.size) {
      node._childCount = childTargets.size;
      return;
    }
    const selfId = String(node._nid || "");
    node._childCount = _nodeData.reduce((count, candidate) => (
      candidate.parent_id != null && String(candidate.parent_id) === selfId ? count + 1 : count
    ), 0);
  });
}

function markCore() {
  _nodeData.forEach(n => { n._core = false; });
  const core = _nodeData.find(n => parseEntities(n.entities).includes("agent:jarvis"))
    || _nodeData[0];
  if (core) core._core = true;
}

function renderLegend() {
  const el = document.getElementById("legend");
  if (!el) return;
  const counts = new Map();
  _nodeData.forEach(n => {
    let t;
    if (n._core) t = "self";
    else if (isConversationMemory(n)) t = "conversation";
    else t = n.event_type || "default";
    counts.set(t, (counts.get(t) || 0) + 1);
  });
  const items = Array.from(counts.entries())
    .map(([type, count]) => ({
      name: type === "self" ? "自身"
        : type === "conversation" ? "对话"
        : (NODE_TYPE_LABELS[type] || type),
      count,
      color: resolveNodeColor(type),
    }))
    .sort((a, b) => b.count - a.count);

  el.innerHTML = items.map(i =>
    `<div class="legend-item">
      <span class="legend-dot" style="background:${i.color}"></span>
      <span class="legend-name">${i.name}</span>
      <span class="legend-count">${i.count}</span>
    </div>`
  ).join("");
}

function chooseVisualParent(child, candidates, childCounts) {
  if (!candidates.length) return null;
  const weighted = [];
  candidates.forEach(candidate => {
    const currentChildren = childCounts.get(candidate._nid) || 0;
    const maxChildren = maxVisualChildren(candidate);
    const recencyBias = Math.max(0, 400000 - Math.abs((child._ts || 0) - (candidate._ts || 0))) / 100000;
    const coreBias = candidate._core ? 1.4 : 0;
    const strengthBias = (candidate._strength || 0.4) * 0.8;
    const remainingCapacity = Math.max(0, maxChildren - currentChildren);
    const capacityBias = currentChildren === 0 ? 1.2 : 0.35 + remainingCapacity * 0.25;
    const entryCount = 1 + Math.max(0, Math.round((recencyBias + coreBias + strengthBias + capacityBias) * 2));
    for (let w = 0; w < entryCount; w++) {
      weighted.push(candidate);
    }
  });
  if (!weighted.length) return candidates[Math.floor(Math.random() * candidates.length)] || null;
  return weighted[Math.floor(Math.random() * weighted.length)] || null;
}

function getCurrentVisualChildCounts(nodes) {
  const counts = new Map(nodes.map(n => [n._nid, 0]));
  _linkData.forEach(link => {
    if (link._kind !== "visual_parent") return;
    const parentId = typeof link.target === "object" ? String(link.target._nid) : String(link.target);
    counts.set(parentId, (counts.get(parentId) || 0) + 1);
  });
  return counts;
}

function maxVisualChildren(node) {
  if (!node) return 2;
  if (node._core) return 4;
  const degree = node._deg || 0;
  const strength = node._strength || 0;
  return (degree >= 4 || strength >= 0.72) ? 4 : 2;
}

function addSupplementalVisualLinks(linkSet, childCounts) {
  const ordered = createVisualOrder(_nodeData);
  const extraLinks = Math.min(18, Math.max(2, Math.floor(_nodeData.length / 5)));
  let added = 0;

  for (let i = 1; i < ordered.length && added < extraLinks; i++) {
    const source = ordered[i];
    const candidates = shuffleArray(
      ordered.slice(0, i).filter(node => {
        if (node._nid === source._nid) return false;
        return (childCounts.get(node._nid) || 0) < maxVisualChildren(node);
      })
    );

    const target = candidates[0];
    if (!target) continue;

    const lid = `visual-extra:${source._nid}=>${target._nid}`;
    const rev = `visual-extra:${target._nid}=>${source._nid}`;
    const base = `visual:${source._nid}=>${target._nid}`;
    const baseRev = `visual:${target._nid}=>${source._nid}`;
    if (linkSet.has(lid) || linkSet.has(rev) || linkSet.has(base) || linkSet.has(baseRev)) continue;

    linkSet.add(lid);
    _linkData.push({ source: source._nid, target: target._nid, _lid: lid, _kind: "visual_random" });
    childCounts.set(target._nid, (childCounts.get(target._nid) || 0) + 1);
    added += 1;
  }
}

function addRandomVisualLinks(linkSet) {
  if (_nodeData.length < 2) return;

  const ordered = createVisualOrder(_nodeData);
  const childCounts = new Map(ordered.map(n => [n._nid, 0]));

  for (let i = 1; i < ordered.length; i++) {
    const child = ordered[i];
    const candidates = ordered
      .slice(0, i)
      .filter(node => (childCounts.get(node._nid) || 0) < maxVisualChildren(node));

    const parent = chooseVisualParent(child, candidates, childCounts);
    if (!parent || parent._nid === child._nid) continue;

    const lid = `visual:${child._nid}=>${parent._nid}`;
    const rev = `visual:${parent._nid}=>${child._nid}`;
    if (linkSet.has(lid) || linkSet.has(rev)) continue;

    linkSet.add(lid);
    _linkData.push({ source: child._nid, target: parent._nid, _lid: lid, _kind: "visual_parent" });
    childCounts.set(parent._nid, (childCounts.get(parent._nid) || 0) + 1);
  }

  addSupplementalVisualLinks(linkSet, childCounts);
}

function findAnchorNode(memory, nodeMap) {
  const nodes = Array.from(nodeMap.values());
  const childCounts = getCurrentVisualChildCounts(nodes);
  const candidates = createVisualOrder(nodes)
    .filter(node => (childCounts.get(node._nid) || 0) < maxVisualChildren(node));
  return chooseVisualParent(memory, candidates, childCounts)
    || _nodeData.find(n => n._core)
    || _nodeData[0]
    || null;
}

export { isConversationMemory, resolveNodeColor, nodeColor, nodeRadius, semanticChildTargets, computeDegrees, markCore, renderLegend, chooseVisualParent, getCurrentVisualChildCounts, maxVisualChildren, addSupplementalVisualLinks, addRandomVisualLinks, findAnchorNode, NODE_TYPE_COLORS, NODE_TYPE_LABELS, NODE_TYPE_DEFAULT };
