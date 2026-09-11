# ZCODE_COMPONENT_MAP.md

Processes, services, modules, dependencies and responsibilities.
Evidence labels: **CONFIRMED** / **STRONGLY INFERRED** / **HYPOTHESIS**.

---

## 1. Process diagram

```
                            ┌─────────────────────────────────────────┐
                            │  ZCode.exe  (Electron main, 1 process)   │
                            │  app.asar/out/main/index.js              │
                            │  • windows, tabs, native chrome          │
                            │  • 129 zcode:* IPC handlers              │
                            │  • updater (electron-updater)            │
                            │  • embedded browser WebContentsView      │
                            │  • CUA helper permission broker host     │
                            │  • node-pty terminal host                │
                            │  • electron-updater + ARMS telemetry     │
                            └───────────┬─────────────────────────────┘
                                        │ Electron IPC (structured clone)
        ┌───────────────────────────────┼──────────────────────────────────┐
        │                               │                                  │
┌───────▼────────┐   ┌──────────────────▼───────────┐   ┌──────────────────▼─────────┐
│ renderer       │   │ preload bridges (6)          │   │ webview / monitor windows   │
│ React 19 SPA   │   │ window.zcode / __ZCODE_DEVICE_ID__ │ codingPlanWebview,      │
│ out/renderer   │   │                              │   │ cuaPermissionPanel,        │
│ 44 MB          │   │                              │   │ processMonitor, browser    │
└───────┬────────┘   └──────────────────────────────┘   └────────────────────────────┘
        │  MessagePort (zcode:service-port → attach-service-port)
┌───────▼────────────────────────────────────────────────────────────────────────────┐
│  HOST  (Electron utility process or main-side module)                              │
│  app.asar/out/host/index.js 2.31 MB  — @zcode/server, @zcode/rpc, @zcode/services  │
│  • workspace/task/session registry        • v4 subscription gateway (topics)        │
│  • permission + elicitation broker        • plugin & marketplace manager            │
│  • automation scheduler (cron, ≤20)       • provider-registry authority             │
│  • runtime supervision & lifecycle        • conversation/attachment gateway         │
└───────┬────────────────────────────────────────────────────────────────────────────┘
        │  ZCode Protocol v1 — NDJSON over stdio  (or WebSocket for remote)
┌───────▼────────────────────────────────────────────────────────────────────────────┐
│  AGENT RUNTIME  (child process, one per workspace)                                 │
│  node E:\zcode\resources\glm\zcode.cjs app-server --stdio   (v0.16.5)              │
│  intended native form: zcode-agent.exe  (spawnArgs resolved from descriptor A4)    │
│  • core.runtime (turns, queue, sessions)  • core.tool.executor (30+ tools)          │
│  • adapters.model (Anthropic-shaped)      • core.subagent                           │
│  • adapters.mcp + adapters.mcp.pool       • bootstrap.zcode_protocol[_v4.commands]  │
│  • own SQLite DB (~/.zcode/cli/db/db.sqlite) + SQLite migrations                   │
└──┬────────────┬───────────────┬──────────────────┬──────────────────┬──────────────┘
   │            │               │                  │                  │
   │ stdio      │ stdio/SSE/HTTP│ NDJSON pipe      │ HTTPS            │ HTTPS
   ▼            ▼               ▼                  ▼                  ▼
┌────────┐ ┌──────────┐ ┌──────────────────┐ ┌──────────────┐ ┌────────────────────┐
│ MCP    │ │ terminal │ │ permission       │ │ model        │ │ Z.ai control plane │
│ servers│ │ (node-pty│ │ broker            │ │ providers    │ │ api.z.ai /         │
│ user + │ │  in shell│ │ unix socket /     │ │ (Anthropic-  │ │ open.bigmodel.cn   │
│ builtin│ │  tier)   │ │ zcode-cua-helper  │ │  shaped)     │ │ OAuth, plans,      │
│        │ │          │ │ named pipe        │ │              │ │ releases, billing  │
└────────┘ └──────────┘ └──────────────────┘ └──────────────┘ └────────────────────┘
```

Also present: **`out/scheduler/index.js`** (1.34 MB) — a distinct bundle, almost certainly the
automation/cron scheduler + `tasks-index.sqlite` writer. Evidence: it independently contains the
`attach-service-port` zod union and `service-port` handling. **CONFIRMED it exists; HYPOTHESIS on
its exact deployment split (own utility process vs. module of host).**

---

## 2. Component table

### 2.1 ELECTRON SHELL

#### `ZCode.exe` (Electron main)
| | |
|---|---|
| Purpose | OS integration, window/tab lifecycle, native chrome, updater, embedded browser, terminal host, CUA permission broker |
| Technology | Electron 41.0.3 (Chromium), Node 22 |
| Entry | `app.asar/package.json` → `main: "out/main/index.js"` |
| Deps | `electron-updater`, `@arms/rum-electron`, `node-pty`, `sharp`, `playwright-core`, `ssh2`, `undici`, `ws`, `yaml`, `node-forge`, `yazl`, `semver`, `@larksuiteoapi/node-sdk`, `@opentelemetry/*` |
| Comm | 129 `zcode:*` IPC channels; MessagePort to host; spawns host/agent |
| State | window/tab layout, zoom, overlay metrics, update state, locale, device id, browser view residency |
| Exposes | `window.zcode` via preload |
| Consumes | host RPC over MessagePort |

Key IPC channels (see `ZCODE_API_CATALOG.md` §2 for all 129): `ServicePort`, `ScopedServicePort`,
`ExecuteDesktopCommand`, `CaptureWindowScreenshot`, `GetProcessMetrics`, `OpenProcessMonitor`,
`StartWebRemoteControl`, `ResetWebRemoteControlPairing`, `ListWSLDistros`, `IsDockerAvailable`,
`ListDockerContainers`, `ListSSHConfigAliases`, `LoadMcpFromUserDirectory`,
`SaveMcpToUserDirectory`, `GetDeviceId`, `ExportLogs`, `SelectFile(s)`, `SaveFile`, `OpenInEditor`,
`OpenInFileManager`, `BrowserView*`.

#### Renderer (`out/renderer`, 44 MB)
| | |
|---|---|
| Purpose | All user-visible UI |
| Technology | React 19.2 + Redux (`@reduxjs`), Vite build, Radix UI, framer-motion, Lexical composer, xterm.js, `@pierre` diffs, shiki/highlight.js, mermaid, echarts+recharts+chart.js, pdfjs-dist, `@rive-app`, rrweb (replay), msw, `@modelcontextprotocol/sdk`, Vercel `ai` + `@ai-sdk/*` |
| Entry | `out/renderer/index.html` |
| Comm | `window.zcode` (IPC), MessagePort (host RPC) |
| State | **Replica store only.** Host/agent are authoritative. |
| Notable panes | usage dashboards (`AppUsageDailyModelTrendChart`, `CodingPlanUsageBarChart`, `CodingPlanUsageLineChart`), `WikiReferenceSidePane`, process monitor, diff viewer, terminal, embedded browser |

#### Preload bridges
`index.cjs` (496 KB), `codingPlanWebview.cjs`, `cuaPermissionPanel.cjs`,
`embeddedBrowserJavaScriptDialog.cjs`, `processMonitor.cjs` (all ~476 KB, shared runtime inlined),
`browserVideoRecorder.cjs` (140 B). Only external require: `electron`. **CONFIRMED.**

#### `out/scheduler/index.js`
1.34 MB. Purpose: cron automation execution + `~/.zcode/v2/tasks-index.sqlite`. Contains its own
`attach-service-port` union and `service-port` references → it speaks the same host RPC.
**CONFIRMED existence; STRONGLY INFERRED role.**

### 2.2 HOST

#### `@zcode/server` (`out/host/index.js`)
| | |
|---|---|
| Purpose | The broker: workspace registry, session/task registry, RPC fan-out, permission/elicitation brokering, plugin management, provider-registry authority, runtime supervision |
| Technology | Node (bundled ESM), Zod validation, `tt` event emitters, `node:sqlite` |
| Entry | `out/host/index.js` |
| Deps | agent runtime (child process), filesystem, plugin tree, desktop settings files |
| Comm | MessagePort from renderer; ZCode Protocol to agents; FS for plugins/config |
| State owned | attachment registry (`attachmentId → MessagePort`), per-workspace client map, session event emitters keyed `workspaceKey\0sessionId`, plugin operation registry, provider-registry sync queues, subscription routes (4-key composite), pending permission/userInput/elicitation requests, automations |
| Exposes | host RPC (`workspace.*`, `task.*`, `session.event`, `model.*`, `mode.*`, `thoughtLevel.*`, `reply.*`, `permission.*`, `elicitation.*`, `userInput.*`, `mcp.servers`), v4 gateway |
| Consumes | ZCode Protocol from agents; desktop settings files |

Notable internals (CONFIRMED function names): `wireClient`, `invalidateWorkspaceClient`,
`emitSessionEvent`, `emitWorkspaceEvent`, `normalizeSessionEventSeq`,
`shouldDeliverLiveSessionEvent`, `handleSessionEvent`, `handleStateUpdated`,
`createBackgroundSessionEventCoalescer`, `syncProviderRegistrySnapshotToClient`,
`drainProviderRegistrySyncQueue`, `ensureLocalProviderRegistrySynced`,
`handleProviderRegistryChanged`, `enqueueInteractionPreferenceSync`,
`resolveV4SubscriptionRoute`, `rememberV4SubscriptionRoute`, `forgetV4SubscriptionRoute`,
`isCurrentV4SubscriptionRoute`, `getSessionEventSequenceState`, `buildWorkspaceRef`,
`ensurePluginManagementWorkspacePath`, `findZCodeAgentRuntimeBinary`, `findZCodeAgentRuntimeNodeBundle`,
`getMcpServerCount`, `getMcpServerNames`, `parseInvalidParamsIssues`, `getSessionCreateCompatFields`.

#### `@zcode/rpc`
| | |
|---|---|
| Purpose | Typed RPC layer used by both host and agent |
| Evidence | Command schema `pJ({id,method,params})` + `assertV4AttachmentNdjsonEnvelope`; `ZCodeProtocolClient`; `ZCodeStdioTransport`; `PermissionBrokerClient`; zod schemas for every method; `ZCodeProtocolClientError`, `ZCodeProtocolRequestTimeoutError` |
| Notable | request timeout default 180 000 ms; abort-signal support; per-request result schema parsing; `onPendingRequestsDrained` lifecycle signal |

#### `@zcode/services`
Evidence: log module namespaces `services.zcode_agent` (e.g.
`zcode_agent.runtime_preferences.host_request_dispatched`), `adapters.*`, `core.*`.
Responsibility: host-side service implementations aligned to agent modules.

### 2.3 AGENT RUNTIME

#### `zcode.cjs` / `zcode-agent` (v0.16.5)
| | |
|---|---|
| Purpose | Headless agent: sessions, turns, model calls, tool execution, MCP clients, persistence |
| Technology | Node 22 CommonJS bundle (SEA-capable); QuickJS WASM embedded for the `js` tool |
| Entry | `node zcode.cjs app-server --stdio` (or `zcode --prompt … --json` for one-shot) |
| Deps | own SQLite, `~/.zcode/cli/config.json`, plugin tree, MCP servers, provider HTTPS, bundled `ripgrep`/`ugrep`/`bfs` |
| Comm | ZCode Protocol on stdio; MCP to servers; permission broker NDJSON; provider HTTPS |
| State owned | sessions, turns, messages, parts, todos, goals, queue items, attachments, automations, usage stats, checkpoints |
| Exposes | **66 protocol methods** (dispatch table reproduced in `ZCODE_COMMAND_CATALOG.md`) |
| Consumes | provider registry + interaction preferences pushed from host |

Internal modules (CONFIRMED from logs):

| Module | Responsibility |
|---|---|
| `core.runtime` | turn engine, phases, context init, session lifecycle, event persistence |
| `core.tool.executor` | tool dispatch, per-iteration accounting |
| `core.subagent` | child-session spawning |
| `adapters.model` | provider SDK calls, streaming, retries, diagnostics |
| `adapters.model.provider_endpoint_routing` | endpoint selection per provider family |
| `adapters.mcp` | MCP server lifecycle, tool registration |
| `adapters.mcp.pool` | connection pooling (session/workspace isolation, leases) |
| `adapters.logging` | JSONL log sink + retention |
| `bootstrap` | startup sequence, session model/thoughtLevel updates |
| `bootstrap.zcode_protocol` | protocol server, SQLite migration, MCP bootstrap, workspace readState |
| `bootstrap.zcode_protocol_v4.commands` | v4 command admission/execution gateway |

Startup sequence observed in logs: `bootstrap.app.startup.started` →
`.config.completed` → `.runtime_config.completed` → `.storage.completed` → `.mcp.completed` →
`.runtime.completed` → `.plugins.completed` → `.completed`; in parallel
`zcode_protocol.startup.started` → `.sqlite_migration.started/completed` → `.completed`.

### 2.4 SIDE COMPONENTS

| Component | Path | Notes |
|---|---|---|
| `cua-helper` | `resources/tools/cua-helper/` | Permission broker server; Windows named-pipe namespace `zcode-cua-helper`; separate executable |
| `ripgrep` / `ugrep` | `resources/tools/{ripgrep,ugrep}` | Bundled search; env overrides `ZCODE_RIPGREP_BINARY`, `ZCODE_UGREP_BINARY`, `ZCODE_BFS_BINARY`; version table `LXi` pins `bfs` v4.1.1-2 (linux), `ripgrep` v13.0.0-10 (darwin)/v14.1.1-1 (linux), `ugrep` v7.8.4-1 (linux) |
| `elevate.exe` | `resources/elevate.exe` | Privilege elevation helper |
| `glm/packages/*-plugin` | 8 bundled plugins | See `ZCODE_ARCHITECTURE.md` §10 |
| `model-providers/models_catalog_*.json` | provider catalog | "china_llm_zcode_2026-06-03" |
| `resources/config/default.json` | `feedback_url`, `feedback_use_external_form`, `community_urls.{zh-CN,en-US}` | Remote-configurable defaults |
| `chrome_*.pak`, `ffmpeg.dll`, `dxcompiler.dll`, `libGLESv2.dll`, `vk_swiftshader.dll` | Chromium/ANGLE/SwiftShader | standard Electron runtime |

---

## 3. Dependency graph (direction of control)

```
renderer ──IPC──▶ main ──MessagePort──▶ host ──NDJSON/stdio──▶ agent ──MCP──▶ MCP servers
   ▲                │                     │                     │
   │                │                     │                     ├──HTTPS──▶ model providers
   └──state push────┴───IPC events────────┴───notifications─────┘
                                          │
                                          ├──FS──▶ ~/.zcode/cli/plugins
                                          ├──FS──▶ ~/.zcode/v2/{setting,config,credentials}.json
                                          └──spawn──▶ scheduler / agent runtimes
```

Notable coupling facts:
- The **renderer never talks to the agent**. All agent access is host-mediated.
- The **host never edits files**. Edits originate in agent tools or terminals.
- The **desktop owns credentials**; the agent receives provider config via
  `workspace/updateProviderRegistry` and auth headers on demand via
  `interaction/requestProviderRuntimeHeaders` / `interaction/requestOfficialMcpAuthHeaders`.
  (This is why the bare `app-server` we spawned reports a `zcode-unconfigured` provider — it has no
  host to supply credentials.)
- **Provider-registry sync is revision-ordered**: host pushes `{registry, generatedAt, revision}`;
  agent replies `{appliedProviderRevision, providerCount, status}`; stale pushes are dropped
  (`generatedAt` comparison) to survive races.

---

## 4. Filesystem layout (CONFIRMED)

```
E:\zcode\                                  install root
├─ ZCode.exe                               Electron main binary (222 MB)
├─ resources\
│  ├─ app.asar                             307 MB — main/preload/renderer/host/scheduler
│  ├─ app.asar.unpacked\node_modules\{node-pty,ssh2}   native modules kept outside asar
│  ├─ config\default.json
│  ├─ glm\zcode.cjs                        12.6 MB agent runtime bundle
│  ├─ glm\packages\<8 plugins>
│  ├─ glm\.node-bundle-meta.json           {runtime:"electron-node", entry:"zcode.cjs", source:"apps/zcode-cli/packages/cli/dist/zcode.cjs"}
│  ├─ model-providers\models_catalog_china_llm_zcode_2026-06-03.json
│  ├─ tools\{cua-helper,ripgrep,ugrep}
│  └─ elevate.exe

C:\Users\<u>\.zcode\                       ZCode home
├─ cli\                                    AGENT runtime home
│  ├─ config.json                          {mcp:{servers},plugins:{enabledPlugins}}
│  ├─ db\db.sqlite(+wal,shm)
│  ├─ log\zcode-YYYY-MM-DD.jsonl
│  ├─ rollout\model-io-<sessionId>.jsonl
│  ├─ agents\<sessionId>\   artifacts\<sessionId>\   exec\<sessionId>\
│  ├─ exec\{bash-startup,shell-snapshots}\
│  ├─ image-cache\<sessionId>\
│  └─ plugins\{cache,data,marketplaces,installed_plugins.json,known_marketplaces.json}
├─ v2\                                     DESKTOP home
│  ├─ config.json        provider registry
│  ├─ setting.json       UI/behaviour settings
│  ├─ credentials.json   oauth:zai:*, zcodejwttoken, oauth:active_provider   [REDACTED]
│  ├─ tasks-index.sqlite, bot-state.v2.json, coding-plan-cache.json,
│  ├─ telemetry-state.json, certs\, logs\, crash\
├─ plugin-workspace\    workspace\default\    tmp\paste-attachments\
└─ feedback\{attachments,logs}\

C:\Users\<u>\AppData\Roaming\ZCode\         Electron profile
├─ session\{Cache,Code Cache,Local Storage,IndexedDB,Session Storage,Network,Preferences,Partitions}
├─ lockfile, .updaterId, rum-electron-store\, zcode-data-size-telemetry.json
```

`nativeConfigDir: ".zcode/cli"` + `nativeConfigFileName: "config.json"` from the runtime descriptor
confirm `~/.zcode/cli/config.json` is the **agent's** config file (CONFIRMED).
