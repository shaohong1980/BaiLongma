# 多 Agent 框架设计思想对照 —— 学习并内化到白龙马/爻台

> 目的：不引入外部框架，而是把 CrewAI / LangGraph / MetaGPT / Dify / LobeChat / Semantic Kernel
> 的**设计思路**提炼成原则，原生改造 `src/multi-agent/`，让白龙马自己的多 Agent 系统更完善。
> 关联代码：`src/multi-agent/`（room/workflow/task-flow/engines/agents）。

---

## 一、框架速览与一句话结论

| 框架 | 核心思想 | 一句话结论（对白龙马） |
|---|---|---|
| **CrewAI** | 角色团队：Agent=角色，Task=任务，Process=编排（sequential/hierarchical） | 把"角色+任务+流程"做成**可声明配置**，支持层级委托，而非写死在 CEO 逻辑里 |
| **LangGraph** | 显式**状态图**：节点/边/条件边/并行+reducer/checkpoint/interrupt/回放 | 把 `workflow.js` 从"线性数组 for 循环"升级为**状态图引擎**：断点续跑、人工审批、审计回放 |
| **MetaGPT** | SOP 流水线：PRD→架构→代码→QA，每个角色产出**结构化标准产物** | 强化"三省六部"为**结构化产物流水线**：每阶段产物按模板写盘、可复核 |
| **Dify** | 可视化工作流 + RAG + 低代码，业务人员可搭 | 给流程提供**可视化/JSON 编辑器**与知识库挂钩（后续 UI 方向） |
| **LobeChat** | 零代码搭 Agent + 插件市场 + 会话组织 | Agent 配置**表单化**、能力可插拔、多会话分组（后续 UI 方向） |
| **Semantic Kernel** | Planner + 插件（Skill）+ 记忆连接器，函数式编排 | 把"工具执行"抽象为**可组合函数/技能**，已有 Skills 系统，可强化 planner 规划 |

---

## 二、逐框架拆解：它解决了什么 → 白龙马现状 → 怎么内化

### 1. CrewAI —— 角色团队建模

**它解决**：
- 用声明式 `Agent(role/goal/backstory)` + `Task(description/expected_output)` + `Crew(process)`
  快速搭任意角色团队；`Process.hierarchical` 时自动生成 manager 分派。
- 任务模板 `{input}` 动态填充；每个 Agent 可带工具、记忆、委托能力。

**白龙马现状**：
- `agents.js` 已定义 10 个角色（CEO/外部/职能员工），`officeCommand` 走 CEO 拆解→分派→执行→汇总，
  等价于**顺序 process**；但没有"层级 process"（CEO 委派主管、主管再委派）的通用能力。
- 任务提示词是写死的字符串拼接，没有 `{inputs}` 模板机制。

**内化改造（C1）**：
- `agents.js` 增加可选 `process`/`manager`/`delegates` 字段，让一个角色团队可配置为
  hierarchical：manager 拆解 → 成员执行 → manager 汇总（复用现有 Agent，不新增外部框架）。
- `room.js` 增加 `runCrew(spec)`：`{ roles:[{agentId, task}], process, inputs }` → 顺序或层级跑一个临时团队。
- 提示词统一走 `fillTemplate(tpl, {content, prev, ...inputs})`。

### 2. LangGraph —— 状态图编排（最值得学）

**它解决**：
- 把流程建模为**状态机**：`StateGraph` 声明节点（执行单元）与边（转移），支持
  条件边（分支）、并行（fan-out + reducer 合并）、循环（回到某节点）、
  `checkpointer`（任意节点状态持久化，断点续跑）、`interrupt`（人工审批暂停）、时间旅行回放。
- 关键点：**状态集中管理**、**合并策略（reducer）** 处理并行写冲突。

**白龙马现状**：
- `workflow.js` 用**线性数组** `steps: [{agent}|{parallel}|{summary}|{loop}]` 顺序 for 循环；
  分支/循环/重试/降级都有，但是"隐式 if"，不是显式图：
  - 无法在任意节点暂停/恢复；
  - 并行是 `Promise.allSettled` 硬编码，合并策略写死；
  - 无执行轨迹回放（只有 result 数组）。

**内化改造（L1，旗舰）**：
- 新增 `src/multi-agent/state-graph.js`：极简状态图引擎（纯 Node 零依赖）：
  - `addNode(name, fn)` / `addEdge(from,to)` / `addConditionalEdge(from, routeFn, map)`；
  - 并行 fan-out（同一起点多条边）+ fan-in + 每 key 可选 **reducer**（add/merge）；
  - **checkpoint**：每节点结束后把状态写入 `data/graph-checkpoints/<threadId>.json`，支持断点续跑；
  - **interrupt**：节点标记 `{approval:true}` 时执行前暂停，等待 `resume(threadId,{approved})`；
  - **回放**：记录 `{node, ts, ms, keysChanged}` 审计轨迹。
- `workflow.js` 增加 `compileFlowToGraph(steps)`：把现有线性 steps（含 parallel/loop/summary）
  **自动编译成状态图**，旧配置零改动即可获得断点/审批/回放。

### 3. MetaGPT —— SOP 结构化产物流水线

**它解决**：
- 把一个"写完整软件"的大目标拆成固定 SOP 角色流水线，每个角色**只产出标准格式文档**
  （PRD/设计文档/代码/测试报告），后一个角色消费前一个的结构化产物 → 可追溯、可复用。

**白龙马现状**：
- `task-flow.js` 三省六部已是 SOP 流水线（分拣→规划→审议→派发→执行→回奏），
  有"奏折"审计日志；但没有**标准化产物文件**——各阶段交付只是对话文本，不落盘成可复核的结构化文档。

**内化改造（M1）**：
- 给流水线加"产物卡"：每阶段在 `data/` 下写 `<taskId>/<stage>.md`（需求/方案/审议/交付/汇报），
  并允许下一个角色以文件为输入（对齐已有"证据化交付验证"）。
- 沉淀可复用 SOP：把常用流水线模板（软件/活动/报告）做成 `data/sops/*.json` 一键派活。

### 4. Dify —— 可视化工作流 + RAG（UI 方向，后续）

**它解决**：业务人员拖拽搭 LLM 应用/工作流，内置 RAG 知识库。

**内化方向**：给 `state-graph.js` 的流程提供 JSON 查看/可视化入口（Brain UI 面板），
让"流程=数据"可见可调；知识库已存在（`src/knowledge/`），可把流程产物自动入库。

### 5. LobeChat —— 零代码 Agent 配置 + 插件生态（UI 方向，后续）

**内化方向**：`agents.js` 已支持运行时改配置（`/agents/:id/config`）；可增强为
"角色模板市场"（预置多套角色团队配置，一键加载），对齐 CrewAI 的 crew 文件思想 + LobeChat 的 Agent 广场。

### 6. Semantic Kernel —— Planner + 技能函数化

**它解决**：把能力封装成 Skill（函数），由 Planner 自动规划调用序列。

**白龙马现状**：已有完整 Skills 系统 + 工具执行器 + `learn_skill` 闭环。

**内化方向**：可在 `state-graph` 里让一个节点直接调用 Skill/工具（对齐函数式编排），
现有 `runAgentEngine` 已支持工具循环，无需额外框架。

---

## 三、落地优先级

| 优先级 | 改造 | 学的框架 | 文件 | 说明 |
|---|---|---|---|---|
| P0 | 状态图引擎（节点/边/并行/reducer/checkpoint/interrupt/回放） | LangGraph | 新增 `src/multi-agent/state-graph.js` | 旗舰改造 |
| P0 | 线性 steps → 图自动编译（旧配置零改动） | LangGraph | `workflow.js` | 让现有流程获得断点/审批/回放 |
| P1 | 角色团队 `runCrew(spec)`（顺序/层级 + 模板填充） | CrewAI | `room.js` | 临时团队快速原型 |
| P1 | 流水线结构化产物卡（每阶段落盘 md） | MetaGPT | `task-flow.js` | 可复核 SOP |
| P2 | 流程可视化 / 角色模板市场 | Dify / LobeChat | UI | 后续 |
| P2 | Planner 函数式节点 | Semantic Kernel | `state-graph.js` | 可选 |

---

## 三·5、F1 工作流收敛落地

**结论：不是"重复"，是"分层"。** 两套 workflow 各司其职，已通过新增 `room` 节点打通：

| 系统 | 定位 | 引擎 | 节点词表 |
|---|---|---|---|
| `src/workflow/` | 主 Agent 通用工作流引擎（工具/LLM/分支/循环/审批/代码） | `engine.js`（完整图引擎） | start/end/llm/tool/condition/switch/loop/parallel/merge/transform/sub_workflow/human_input/approval/code/**room** |
| `src/multi-agent/workflow.js` | 多Agent办公室编排层（会议桌/CEO/职能员工） | `state-graph.js`（轻量，会议室内部） | steps[] 线性（agent/parallel/summary/loop） |

**收敛动作**：给主引擎 `src/workflow/engine.js` 新增 **`room` 节点**（`mode: office|crew|speak`），由
`capabilities/tools/workflow.js` 注入 `executeRoom` → 调用多Agent办公室的 `officeCommand` / `runCrew` / `bossSpeak`。
效果：**一个引擎既能驱动通用工具/LLM，也能驱动会议桌/角色团队**，新增模板 `room_office` / `room_crew`。
会议室内部的 `state-graph.js` 保留为轻量编排器，不再与主引擎做第二次合并（避免过度工程）。

## 四、设计原则沉淀

1. **流程 = 数据**：流程应可声明、可持久化、可回放，而不是写死在循环里（LangGraph/MetaGPT）。
2. **状态集中、冲突靠 reducer**：并行写同一 key 必须显式声明合并策略（LangGraph）。
3. **人类在环**：关键节点支持暂停等审批，而不是一条道跑到黑（LangGraph）。
4. **角色 = 声明配置**：团队组成、角色职责、任务模板应可配置/可换（CrewAI/LobeChat）。
5. **结构化产物**：每阶段交付落盘成标准文档，下一阶段以此为输入，可追溯（MetaGPT）。
6. **证据化**：交付是否真实存在要用工具核实（白龙马已有的 verifyDelivery 正是此原则）。
