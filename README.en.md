![Yaotai](https://github.com/xiaoyuanda666-ship-it/Yaotai/blob/main/images/AGI128k.jpg)

# Yaotai Agent Studio (爻台)

> **Yaotai (爻台) is a local, continuously-running desktop AI Agent, deeply re-engineered on top of Bailongma (白龙马).**

Built on the open-source Bailongma foundation, Yaotai adds significant second-generation capabilities while keeping Bailongma's local autonomy, dynamic memory, tool execution and multi-protocol support:

- **Multi-Agent Collaboration**: a "War Council" / three-province-six-ministry pipeline (sort → plan → review-and-veto → dispatch → execute → report back), with domains auto-routed to the right agents;
- **Agent Skill Learning Loop**: `learn_skill` turns workflows into reusable `SKILL.md` packages, `improve_skill` self-improves them through use;
- **Behavioral Evaluation & Adversarial Testing**: 31 end-to-end eval tasks plus prompt-injection / dangerous-instruction / sandbox-escape adversarial suites;
- **DeepSeek Optimization**: prompt-cache prefix ordering, flash/pro tiered models, context token budgeting and automatic degradation;
- **Standard Protocols**: MCP (Agent↔Tool) + A2A (Agent↔Agent) + OTel trace fields, built for the agent ecosystem.

This is not a chat-and-forget program. A main loop drives it: user messages are handled with priority; during idle it keeps organizing memories, checking tasks, and refreshing context — all pushed live to Brain UI.

The project consists of an Electron desktop shell, a local HTTP service, an LLM calling layer, a memory system, a tool executor, voice, social connectors and Brain UI. Its goal is a local agent that can chat, remember, act, observe its own runtime state, and perform file/web/media/reminder/task/system operations through tools.

## Core Capabilities

- Continuously running main loop: user messages, background messages, reminders, task resumption and idle heartbeats.
- Memory system: local SQLite persistence of conversations, memories, action logs, reminders, prefetch cache, media history and thread state, with full-text search, semantic supplement, dedup and merge.
- Dynamic context injection: automatically selects relevant memories, recent conversations, user profile, tool results, UI signals, prefetch content and runtime state before each turn.
- Multi-model support: OpenAI-compatible endpoints for DeepSeek, MiniMax, OpenAI, Qwen, Moonshot, Zhipu, MiMo and custom services.
- Tool system: on-demand tool injection — messaging, filesystem, shell, web read, search, media generation, memory management, UI cards, tasks, reminders, local agent delegation and system operations.
- Agent Skills loop: `learn_skill` / `view_skill` / `list_skills` / `improve_skill` / `delete_skill` with usage telemetry and active/stale/archived lifecycle.
- MCP access: call configured MCP (Model Context Protocol) servers (Notion/Gmail/GitHub/databases/filesystem etc.) via `mcp_call`; servers are explicitly allow-listed in `data/mcp-servers.json`.
- Tool result compression (TokenJuice): read-only/informational tool outputs above a threshold are compressed to a one-line summary before entering the model; full text is written to `data/tool-outputs/<id>.txt` for on-demand retrieval.
- Brain UI: chat, thinking stream, memory graph, focus thread, hotspot panel, document panel, character card, voice control, settings and ACUI card rendering.
- Voice: cloud ASR and multiple TTS services, configurable in the UI.
- Social connectors: Discord and WeChat bridges route external messages into the same main loop, replies routed per channel.
- Local resource awareness: collects system info, desktop info, installed software, local agents, SSH/Git resources, geo-weather and hotspot content at startup.
- Desktop integration: Electron window, tray, update status, log persistence, single instance and focus banner.
- **Multi-Agent Office**: a visual collaboration workspace — a CEO at the head of a meeting table, independent external A2A agents (Hermes / Claude Code) as table members, and functional employees (File Manager / Report & Stats / Computer Operator / App Orchestrator / Search Specialist / System Inspector) working at real desks with real tools. Capabilities include:
  - **Real tool execution**: internal employees run a `callLLM` tool loop (read/write/execute/search); external agents via A2A `message/send` — no more "talking without doing";
  - **CEO structured decomposition**: outputs JSON `workers` for precise dispatch, with keyword inference as fallback;
  - **Evidence-based delivery verification**: an inspector verifies deliverables with real tools, eliminating "claimed but not delivered";
  - **Vector memory + semantic recall**: office decisions/meetings/facts are persisted into the knowledge base and memory graph; relevant history is injected into context by semantics;
  - **Programmable orchestration**: JSON-defined multi-step flows (sequential / parallel / summarize / review-fix loops), with presets `consult` / `implement` / `reviewfix`;
  - **Per-agent work ledger**: who did what, how long, with what result; live SSE progress + external-agent status lights;
  - **System Inspector**: Marvis-style — one sentence performs a full computer health check (disk / performance / battery / large files) and outputs a structured report;
  - **Side-aware reporting seats**: left-desk agents report to the left of the CEO, right-desk agents to the right.

## Project Structure

```text
electron/              Electron main process, preload scripts and desktop window control
src/index.js           Agent main loop, scheduling, task state and startup flow
src/api.js             Local HTTP service, SSE, WebSocket, settings and admin routes
src/llm.js             LLM streaming calls, tool-call execution and retry protection
src/config.js          Provider, model, voice, social, search and security configuration
src/db.js              SQLite tables, indexes and persistence
src/memory/            Memory recognition, injection, threads, focus, recall and grooming
src/context/           Runtime context, rules, keywords and snippet selection
src/capabilities/      Tool schemas, executor, sandbox and tool marketplace
src/multi-agent/       Multi-Agent Office: agent definitions / engines (A2A·CLI·tool-loop) / room / task pipeline / memory / ledger / orchestration
src/knowledge/         Knowledge base: hybrid vector + full-text retrieval (backs office vector memory)
src/social/            Social platform connectors and message routing
src/voice/             Cloud ASR, TTS services and voice logic
src/ui/brain-ui/       Brain UI frontend, ACUI components and visualization panels
scripts/               Build, probe, repair, smoke-test and helper scripts
sandbox/               Agent workspace and generated content
data/                  Local runtime data (excluded from installers)
```

## Environment Requirements

Yaotai requires **Node.js 22.x** as the build/script environment (npm, electron-rebuild, lint, etc.); at runtime it always uses Electron 33's built-in Node (see below). The startup guard will fail with an error if the version doesn't match.

Version enforcement:

- `engines` field in `package.json` declares `>=22.0.0 <23.0.0`.
- `.nvmrc` pins `22.20.0`.
- `.npmrc` enables `engine-strict=true`.
- `scripts/check-node.mjs` guards `predev` / `prestart` / `prestart:backend` / `prestart:backend:lan`.

### Unified Runtime (Electron)

`better-sqlite3` is a native module; this project always runs under the **Electron runtime** (desktop via `npm start`, backend via `npm run dev` / `npm run start:backend`), so native modules are compiled once against Electron's ABI (130) — no ABI switching. System Node 22 has a different ABI and is only the host for electron-rebuild / lint / npm scripts, never loads `better-sqlite3` directly.

Backend scripts run via `ELECTRON_RUN_AS_NODE=1 electron ...`:

```bash
npm run dev            # backend dev (watch mode, Electron-as-node)
npm start              # desktop app (Electron runtime)
```

Rebuild native modules when needed:

```bash
npm run electron:rebuild   # rebuild better-sqlite3 for the Electron ABI (default/recommended)
```

> ⛔ **Never run `npm rebuild better-sqlite3` or `npm run backend:rebuild`** — they rebuild for the plain-Node ABI and break both desktop and backend (`NODE_MODULE_VERSION` mismatch). Always use `npm run electron:rebuild`.
>
> Note: don't run better-sqlite3-dependent scripts with plain `node xxx.js` — the ABI differs from Electron and will error. Use the repo's `blm-run xxx.js` (Git Bash) or `ELECTRON_RUN_AS_NODE=1 electron xxx.js`.

## Running

Install dependencies:

```bash
npm install
```

Start the desktop app:

```bash
npm start
```

Backend only:

```bash
npm run start:backend
```

Dev mode with backend auto-restart:

```bash
npm run dev
```

LAN access:

```bash
npm run start:lan
npm run start:backend:lan
```

## Configuration

On first launch an activation page asks for an API key of any supported provider. You can also provide environment variables via `.env`:

```env
LLM_PROVIDER=minimax
MINIMAX_API_KEY=your_key
```

Common settings live in Brain UI's settings page:

- Model provider, model, temperature and API key.
- Speech recognition, TTS provider, voice and credentials.
- Social platform connection parameters.
- Embedding, web search and security toggles.
- Agent name, UI behavior and media preferences.

Configuration persists to the local data directory. Sensitive settings endpoints are local-only by default; enable LAN access or an API token via environment variables when remote access is needed.

## Web Entry Points

The local service listens on:

```text
http://127.0.0.1:3721
```

Common pages:

| Page | URL | Purpose |
| --- | --- | --- |
| Brain UI | `/brain-ui` | Main UI: chat, status, settings, visualizations |
| Activation | `/activation` | First-run API key setup |
| Runtime status | `/status` | Loop, tasks and memory overview |
| Quota | `/quota` | Request & rate-limit status |
| Turn Trace | `/turn-trace` | Turn-level runtime traces |

If the default port is taken, the Electron main process auto-selects an available port.

## Common API

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/message` | Send a user message into the main loop |
| `GET` | `/events` | Subscribe to the SSE event stream |
| `GET` | `/status` | Runtime status |
| `GET` | `/quota` | Quota & rate-limit info |
| `GET` | `/memories` | Query memories |
| `PATCH` | `/memories/:id` | Update a memory |
| `DELETE` | `/memories/:id` | Delete a memory |
| `GET` | `/conversations` | Recent conversations |
| `GET` | `/settings` | Settings summary |
| `POST` | `/activate` | Write provider config and activate |
| `POST` | `/settings/model` | Switch model |
| `POST` | `/settings/temperature` | Adjust temperature |
| `GET` | `/settings/voice` | ASR settings |
| `POST` | `/settings/voice` | Save ASR settings |
| `GET` | `/settings/tts` | TTS settings |
| `POST` | `/settings/tts` | Save TTS settings |
| `POST` | `/tts/stream` | Stream TTS |
| `GET` | `/social/wechat-clawbot/qr` | WeChat bridge QR status |
| `POST` | `/social/wechat-clawbot/logout` | Log out WeChat bridge |
| `POST` | `/admin/stop` | Pause the main loop |
| `POST` | `/admin/start` | Resume the main loop |
| `POST` | `/admin/restart` | Restart the app |
| `POST` | `/admin/reset-memories` | Clear memories & conversations |
| `POST` | `/admin/reset-files` | Clear sandbox files |
| `GET` | `/agents` | List Multi-Agent Office members |
| `GET` | `/agents/health` | Probe external A2A agent liveness |
| `GET` | `/agents/ledger` | Per-agent work ledger |
| `POST` | `/agents/:id/config` | Update agent config (avatar/engine/tools) |
| `GET` | `/room` | Meeting room history & round |
| `POST` | `/room/office` | Office workflow (CEO decompose → dispatch → execute → summarize → inspect) |
| `POST` | `/room/message` | Speak in the room (@mention routing) |
| `POST` | `/room/reset` | Reset the meeting room |
| `POST` | `/room/edict` | Three-province-six-ministry task pipeline |

Some endpoints also back Brain UI internal panels: hotspots, documents, character cards, media history, AI video, ACUI and cloud ASR.

## Data & Persistence

Yaotai's long-term state is stored in a local SQLite database, including:

- Conversations, participant identities and user profile.
- Memory nodes, relations, full-text index and visibility state.
- Action logs, tool-result summaries and turn traces.
- Reminders, prefetch tasks, prefetch cache and UI signals.
- Media history, music library and AI video records.
- Focus threads, commitment state and legacy focus-stack migrations.
- WeChat bridge credentials and assorted local config.
- **Multi-Agent Office**: meeting room conversation (`data/room-conversation.json`), decision/meeting/fact memories (`data/office-memory.json` + knowledge-base vector index), per-agent ledger (`data/agent-ledger.json`), task pipeline (`data/edict-tasks.json`); office conclusions are also written into the `memories` table and appear in the 3D spherical memory graph.

`sandbox/` is the agent's workspace for generated files, temp projects, downloads and media artifacts. `data/` is the runtime data directory, excluded from installers.

## Tool System

Tool schemas live under `src/capabilities/schemas/`, aggregated at runtime by `src/capabilities/schemas.js`. The main loop selects which tools to expose per turn based on the current message, task state, recent action logs, UI signals and available provider capabilities — avoiding a full tool dump every turn.

Built-in tools cover:

- Sending messages to the user or external channels.
- Reading, listing, writing and deleting files.
- Running shell commands and managing long-running processes.
- Searching the web, fetching pages, reading browser content.
- Searching, recalling, writing, merging and demoting memories.
- Managing reminders and prefetch tasks.
- Showing, updating and closing ACUI cards.
- Generating voice, controlling the media panel, managing music and generating video.
- Delegating sub-tasks to local agents.
- Reviewing completed work.
- Browsing/viewing/learning/improving/deleting Agent Skill packages.
- Listing and calling external tools on MCP servers.

The tool marketplace supports installing custom tools; installed tools persist under the sandbox directory and join the available list on later turns.

## Brain UI

Brain UI is the primary interface, frontend in `src/ui/brain-ui/`. It renders:

- Multi-channel chat and a live thinking stream.
- Memory graph, focus threads and current task state.
- **Multi-Agent Office** (visual workspace): CEO and external A2A agents at the meeting table, employees animating at their desks, live SSE progress, status lights, work ledger & recent completions, @mention direct dispatch.
- Hotspot info, document knowledge, character cards and system-prompt preview.
- Voice panel, TTS effects, WeChat QR popup and settings page.
- ACUI cards: weather, self-check, wake, image, video and security confirmation.

The frontend talks to the backend over HTTP, SSE and WebSocket. The Electron preload script adds desktop capabilities such as window resize, update status and external-link opening.

## Multi-Agent Office

The Multi-Agent Office is Yaotai's built-in visual multi-agent collaboration workspace, opened from Brain UI.

### Layout & Roles

```
            Meeting Table
  👔 CEO / 🧭 HermesAgent / 💻 ClaudeCode (independent external A2A)
  ┌───────────────┬───────────────┐
  │ Left desks     │ Right desks    │
  │ File Mgr / Report & Stats / Computer Op │ App Orchestrator / Search / System Inspector │
  └───────────────┴───────────────┘
  Reporting: left-desk roles report left of CEO, right-desk roles right of CEO
```

- **Meeting table**: the CEO (internal) + independent external A2A agents (Hermes `127.0.0.1:9900`, Claude Code `127.0.0.1:9920`) participating as independent reviewers/contributors.
- **Desk employees**: internal agents running real tool loops — File Manager (read/write/archive), Report & Stats (python stats), Computer Operator (shell), App Orchestrator (integration), Search Specialist (knowledge/web search), System Inspector (system diagnostics).

### Usage

- **Direct dispatch**: enter an instruction → CEO structured decomposition (JSON workers) → employees really execute → inspector evidence-verifies → CEO summarizes.
- **@mention**: `@电脑操作 open notepad` → only the mentioned agent responds.
- **System health check**: `give the computer a full health check` → routed to the System Inspector, which scans disk / performance / battery / large files with real commands.
- **Orchestration**: run preset flows via the `junjichu` tool's `workflow` action (`consult` meeting-table review / `implement` project kickoff / `reviewfix` review-fix loop), or pass a custom JSON flow.
- **Dynamic external agent onboarding**: the `junjichu` tool's `discover` action takes an A2A URL and auto-discovers the Agent Card to seat a new external agent at the table.

### External A2A Agent Integration

External agents connect via A2A v1.0 (JSON-RPC `message/send` / `tasks/get` / `tasks/cancel`), with the Agent Card at `/.well-known/agent-card.json`. The office calls them with `engine: 'a2a'`, supports multi-turn `contextId` memory and optional Bearer-token auth; failures fall back to the internal engine. Example: the Claude Code A2A adapter lives at `D:\ClaudeCode\a2a-test\claude_code_a2a_server.py`.

## Testing & Maintenance Scripts

Common scripts:

```bash
npm run smoke:tools
npm run smoke:brain-ui
npm run smoke:social
npm run test:rule-context
npm run test:complex-task
npm run test:relevance
npm run test:section-gate
npm run test:agent-skills
npm run test:config-upgrade
npm run test:learned-improvements
```

Memory repair and config probe:

```bash
npm run repair:memories:dry
npm run repair:memories
npm run probe:config-upgrade
```

Build the Windows installer:

```bash
npm run build
```

Publish to GitHub Releases:

```bash
npm run publish
```

## Security & Access Control

- Local service is local-only by default.
- Sensitive paths include activation, settings, admin and memory-mutation endpoints.
- LAN access can be explicitly allowed via environment variables.
- An API token lets remote requests carry credentials.
- File and tool capabilities route through a unified executor; risky operations enter confirmation or policy flows.
- The Electron desktop enables context isolation; the frontend reaches necessary capabilities through a preload bridge.

## Local-First (The Moat)

Bailongma's positioning is a **local, continuously-running autonomous agent** — data and capabilities stay on your machine:

- **Data local**: all memories/conversations/config in local SQLite (`data/`), no cloud dependency.
- **Offline-capable**: local embedding model (bge-large-zh) for vector recall; network tools go out only when needed.
- **Portable**: the `backup_data` tool snapshots SQLite (incl. WAL) + config + sandbox files to `sandbox/backups/` — copy and migrate.
- **Auditable**: every tool call is recorded in `action_logs` + turn traces (`turn-traces.jsonl`); `backup_data` and the adversarial test suite guard the data boundary.

## Known Dependency Risks (Decision Log)

- **sharp (transitive via `@huggingface/transformers`)**: `npm audit` reports libvips CVEs (GHSA-f88m-g3jw-g9cj etc.) affecting sharp `<0.35.0`, and 0.34.x has no fix. This project only uses transformers for **pure-text embedding** (bge-large-zh, `pipeline('feature-extraction')`), never loads sharp at runtime (image pipeline not triggered), so the real attack surface ≈ 0; the dependency chain pins `sharp ^0.34` (latest 4.2.0 still doesn't support 0.35), upgrading requires npm overrides + native rebuild + API-compat risk. **Decision: accept this risk.** If multimodal/image embedding is enabled later, upgrade the transformers→sharp 0.35 chain.
- **undici / ws**: already fixed via version upgrades (`undici ^6.28.0`, `ws ^8.21.3`).

## License

[MIT License](./LICENSE)
