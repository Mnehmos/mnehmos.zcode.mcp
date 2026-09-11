# ZCODE_RE_FINDINGS.md

Raw reverse-engineering findings with evidence. Every claim carries a label:
**CONFIRMED** (directly demonstrated) / **STRONGLY INFERRED** / **HYPOTHESIS**.

---

## 0. Method

| Technique | What it produced |
|---|---|
| Filesystem reconnaissance | install root `E:\zcode`, agent home `~/.zcode/cli`, desktop home `~/.zcode/v2`, Electron profile `%APPDATA%\ZCode` |
| ASAR parsing (custom Python reader, `.re/asar.py`) | 27 293 entries; `out/{main,preload,renderer,host,scheduler}` bundles isolated |
| Static bundle analysis | minified-but-not-mangled JS; `s(fn,"name")` preserves function names; zod schemas and string literals intact |
| String-literal clustering | IPC channel table (129), protocol method enums (4), tool registries (2), HTTP endpoints (31), limits object, enums |
| Live process inspection | `Win32_Process` command lines; `Get-NetTCPConnection`; 35 ZCode PIDs |
| Runtime log analysis | `~/.zcode/cli/log/zcode-*.jsonl` — event/module taxonomy, turn trace |
| **Live protocol probing** | spawned `zcode.cjs app-server --stdio`, sent NDJSON requests, captured responses |
| Config/state inspection | `~/.zcode/v2/{setting,config,credentials}.json`, `~/.zcode/cli/config.json` |

Artifacts produced in `.re/`: `asar.py` (ASAR reader), `channels.py` (channel extractor),
`probe.js` (protocol prober), `x/` (extracted bundles), `ch-preload.json` / `ch-main.json` /
`ch-host.json` (channel maps), `probe/` (probe scratch).

---

## 1. CONFIRMED — system identity

| # | Finding | Evidence |
|---|---|---|
| 1.1 | ZCode Desktop **3.11.2**, product `@zcode/desktop`, author `dev@zcode.z.ai`, homepage `https://zcode.z.ai` | `app.asar/package.json` |
| 1.2 | Electron **41.0.3**; Electron Builder **26.8.1**; build commit `89817f5b`; built `2026-09-04T08:04:18.527Z` | crashpad `--annotation=ver=41.0.3`; `out/metadata/build-meta.json` |
| 1.3 | Agent runtime version **0.16.5**; bundle source `apps/zcode-cli/packages/cli/dist/zcode.cjs`; runtime `electron-node`; platform `win32-x64` | `zcode --help`; `resources/glm/.node-bundle-meta.json`; log `version:"0.16.5"` |
| 1.4 | Internal monorepo packages: `@zcode/{desktop,client,rpc,server,services,shared,ui,zcode-cua,e2e-report}` | `package.json` dependencies |
| 1.5 | Install root `E:\zcode`; `app.asar` **307 139 416 bytes**; `zcode.cjs` **12 615 227 bytes**, 3 264 lines | `ls`, `wc -l` |
| 1.6 | No ZCode process listens on any TCP port | `Get-NetTCPConnection -State Listen` filtered by owning process → empty |
| 1.7 | Provider is Z.ai / BigModel (Zhipu); model catalog file `models_catalog_china_llm_zcode_2026-06-03.json` | resources; `config.json` base URLs |

## 2. CONFIRMED — the agent runtime is a scriptable stdio server ★

| # | Finding | Evidence |
|---|---|---|
| 2.1 | `zcode app-server` = "Run the ZCode Protocol stdio app server" | `zcode --help` |
| 2.2 | Spawn contract: `spawnArgs: ["app-server","--stdio"]`; `binaryEnvVar: "GLM_BINARY_PATH"`; `bundledResourceDir: "glm"`; `nodeBundleEntryFile: "zcode.cjs"`; `nativeConfigDir: ".zcode/cli"`; `nativeConfigFileName: "config.json"` | verbatim descriptor `A4` in `out/host/chunk-RWMCBKS2.js` ≈ offset 541121 |
| 2.3 | **Live probe succeeds**: sending `{"id":1,"method":"bogus/method","params":{}}` on stdin yields `{"error":{"code":-32601,"message":"Method not found: bogus/method"},"id":1}` on stdout after ~1.1 s | executed via `.re/probe.js` |
| 2.4 | `session/list` **works with empty params** and returns real session data | live response captured |
| 2.5 | `workspace/readState`, `mcp/list`, `plugins/list`, `skills/referenceCatalog` **require** a `workspace` object | `-32602 "Invalid params — workspace: Invalid input: expected object, received undefined"` |
| 2.6 | `usage/stats` **requires** `range ∈ {"all","7d","30d"}` | `-32602 "Invalid params — range: Invalid option: expected one of \"all\"|\"7d\"|\"30d\""` |
| 2.7 | `v4/commands/query` requires `{commands:[≥1]}` where each entry has a **string `commandId`** | `-32603 ZodError path ["commands",0,"commandId"]`; `too_small minimum 1` for the array |
| 2.8 | `mcp/list` **starts MCP servers as a side effect** | `process/mcpTelemetry {kind:"process_start", …}` notifications emitted after the call |
| 2.9 | The agent issues **client requests** to its client, e.g. `{"id":"server-1","method":"interaction/requestOfficialMcpAuthHeaders", …}` | live capture |
| 2.10 | `zcode --prompt …` without a provider config fails with `Error: Model config is missing. Create C:\Users\<u>\.zcode\cli\config.json with an explicit model provider before running ZCode.` | live execution |
| 2.11 | The runtime must be launched as `node <zcode.cjs>`; direct spawn fails `EFTYPE` | live `spawn` error |
| 2.12 | `--settings` and `--max-turns` appear in `--help` but are **rejected** by the option parser (`Unknown option '--settings'`); `--prompt`, `-p`, `--json`, `--cwd`, `--help` are accepted | live executions |
| 2.13 | Auto-startup events: `bootstrap.app.startup.started → .config → .runtime_config → .storage → .mcp → .runtime → .plugins → .completed`, plus `zcode_protocol.startup.{started,sqlite_migration,completed}` | `~/.zcode/cli/log/zcode-2026-09-07.jsonl` (event `zcode_protocol.startup.started`, `module:"bootstrap.zcode_protocol"`, `context.startupKind:"zcode_protocol_agent"`, `version:"0.16.5"`) |
| 2.14 | `session/stop` **bypasses the serial processing queue** | `shouldBypassProcessingQueue(t){ return "id" in t && "method" in t && t.method === rr.sessionStop }` |

## 3. CONFIRMED — protocol definition

| # | Finding | Evidence |
|---|---|---|
| 3.1 | Protocol name `"ZCode Protocol"`, version `1` | `Rje="ZCode Protocol",Pje=1` (zcode.cjs) |
| 3.2 | Envelope is JSON-RPC 2.0-shaped **without** a `jsonrpc` field: `{id,method,params}` / `{id,result}` / `{id,error:{code,message,data}}` / `{method,params}` | `ZCodeProtocolClient.handleMessage`; live traffic |
| 3.3 | Transport decode errors: `-32700 "Parse error"`, `-32600 "Invalid ZCode Protocol message"` | class `X3e.decodeLine` |
| 3.4 | Additional code `-32004` = `sessionUnavailable` | `XB={sessionUnavailable:-32004}` |
| 3.5 | Params validation failures return `message:"Invalid params — <path>: <issue>"` with `data.name === "ZodError"` | live responses |
| 3.6 | Handler-internal validation failures are `-32603` and leak **a stack with minified handler names and exact `zcode.cjs:line:col`** | `j3e.queryCommands (…:3121:123197)`, `Q3e.dispatchRequest (…:3123:78786)`, `Q3e.handleRequest (…:3123:76543)`, `Q3e.handleMessage (…:3123:76192)`, `X3e.handleMessage (…:3126:1822)` |
| 3.7 | Request handling is strictly serialised via a promise chain | `this.processing=this.processing.then(async()=>{…})` |
| 3.8 | Result payloads are zod-parsed when a schema is supplied; failure message `"ZCode Protocol response parse failed: <method>"` | `ZCodeProtocolClient.resolveResponse` |
| 3.9 | Default request timeout **180 000 ms**; timeout error text `"ZCode Protocol request timed out: <method>"` | `Fbe=3*6e4`; `Dm` class |
| 3.10 | Send on a closed stdio transport throws exactly `"ZCode agent stdio transport is closed"` | `ZCodeStdioTransport.send`; `isClosedStdioTransportError` |
| 3.11 | Two transports exist: `"stdio"` and `"websocket"` | `initialize()` returns `transportKind==="websocket"?"websocket":"stdio"` |
| 3.12 | Remote server descriptor declares `protocolVersion: 1`, `authRequired`, `workspaces[{path,label?,workspaceIdentity?}]`, `capabilities:{desktopContinuous:true, websocketRpc:true}` | verbatim `F4` zod object |

## 4. CONFIRMED — command/event registries

| # | Finding | Evidence |
|---|---|---|
| 4.1 | 4 protocol enums extracted: `qe` (61 request/notification methods), `ev` (3 agent→host notifications), `dc`/`bn` (21 v4 requests), `bv`/`UL` (3 v4 notifications) | verbatim enum objects dumped |
| 4.2 | Full dispatch switch recovered: **66 `case` arms** mapping method → handler function | `zcode.cjs:3123` |
| 4.3 | `session/event` has **25 types** | enum `aKi` |
| 4.4 | Session event envelope `{eventId, sessionId, turnId?, seq, traceId?, timestamp, deliveryKind?, type, payload}` | `W1n` zod schema |
| 4.5 | A second, durable `kind`-tagged stream exists: `turn-started, turn-completed, turn-failed, tool-scheduled, tool-started, session-closed` | `iKi` discriminated union |
| 4.6 | Host has a dotted RPC namespace (~24 requests, ~22 events) | string clustering in `out/host/index.js` |
| 4.7 | Bot command language with 20+ bilingual commands | `parseBotCommand`, `splitCommand`, `TS=["help",…,"bind"]` |
| 4.8 | 129 shell IPC channels | channel map in `out/preload/index.cjs` |
| 4.9 | Agent tool registry: internal `mCn` (30 names) and provider-visible `eli` (32 names) | verbatim arrays in `zcode.cjs` |
| 4.10 | Automations: `automation/{create,list,update,delete,checkTaskBinding}`, max **20** retained | dispatch table; `AutomationCreateLimitError` |

## 5. CONFIRMED — limits, modes and enums

| # | Finding | Evidence |
|---|---|---|
| 5.1 | `maxFrameBytes = 1 MiB`; `logicalFrameAssemblyMaxBytes = 16 MiB`; ≤1024 fragments; ≤32 concurrent; ≤32 MiB staged; 30 s timeout | limits object `nn` |
| 5.2 | `subscriberBufferMaxOps 500`; `eventRetentionPerSession 2000`; `snapshotTailWindowRows 60`; `rowsRangeMaxLimit 200` | limits object |
| 5.3 | `attachmentMaxBytes 20 MiB`; `attachmentChunkMaxBytes 512 KiB`; `attachmentPreviewMaxBytes 30 MiB`; uploads ≤64 chunks, ≤16 concurrent, ≤64 MiB staged, 5 min TTL; read cache 30 MiB / 30 s; unreferenced TTL 24 h | limits object |
| 5.4 | `toolOutputFinalHeadBytes/TailBytes = 32 KiB`; `commandPendingTtlMs = 24 h`; `idempotencyTablePerSession = 512`; `conversationQueryTimeoutMs = 10 s` | limits object |
| 5.5 | Modes `plan\|build\|edit\|yolo\|auto`; statuses `idle\|running\|waiting\|paused\|completed\|error`; session kinds 7 values | enums `k1`, `UBe`, `bbn` |
| 5.6 | Permission decisions `allow\|deny\|escalate\|modify`; rule behaviors `allow\|deny\|ask` | enums `FBe`, `vbn` |
| 5.7 | Model streaming part kinds: 13 values (`start`,`finish`,`error`,`text_*`,`reasoning_*`,`tool_input_*`,`tool_call`) | enum `V1n` |
| 5.8 | Queue/steer/dispatch state machines | `gP`, `gbn`, `_bn`, `ybn`, `NBe` zod schemas |
| 5.9 | Failure reason codes: `fault.command.notImplemented`, `fault.command.executionFailed`, `proto.payloadTooLarge`, `fault.subscription.notOwned`, `fault.fileChanges.unsupported`, `fault.fileRewindPreview.unsupported`, `fault.attachment.putUnsupported`, `fault.attachment.previewNotMedia`, `fault.attachment.previewTooLarge`, `proto.staleLogEpoch`, `proto.staleRevision`, `fault.attachment.connectionUntrusted` | source strings |

## 6. CONFIRMED — provider, credentials and auth

| # | Finding | Evidence |
|---|---|---|
| 6.1 | Provider `kind` values include `anthropic` and `openai-compatible` | `~/.zcode/v2/config.json` |
| 6.2 | Base URLs: `https://api.z.ai/api/anthropic`, `https://open.bigmodel.cn/api/anthropic`, `https://zcode.z.ai/api/v1/zcode-plan/anthropic` (ZCode's own documented defaults); the observed instance also had two user-added `openai-compatible` providers | same |
| 6.3 | `systemDisabledReason` values: `oauth_provider_inactive`, `coding_plan_not_connected`, `coding_plan_not_authenticated`, `coding_plan_not_entitled` | same |
| 6.4 | ⚠ **`~/.zcode/v2/config.json` stores provider API keys in PLAINTEXT** under `provider.<id>.options.apiKey`. Real key material was observed and is **redacted from every artifact in this repo**. | direct read |
| 6.5 | Desktop credential keys: `oauth:zai:access_token`, `oauth:zai:user_info`, `oauth:active_provider`, `zcodejwttoken` | `~/.zcode/v2/credentials.json` (key names only; values not printed) |
| 6.6 | `node-forge` is a dependency → signing/PKCE/encryption work exists, but **no evidence that config.json values are encrypted** (they are not) | `package.json` + direct read |
| 6.7 | Request headers: `User-Agent: ZCode/<ver>`, `X-ZCode-App-Version`, `X-Title: Z Code@<source>`, `X-Platform`, `X-Release-Channel`, `X-Client-Language`, `X-Client-Timezone`, `X-Os-Category`, `X-Os-Version`, `X-Device-Mid`, `HTTP-Referer` | `buildZCodeSourceHeadersFromContext` |
| 6.8 | 31 Z.ai control-plane endpoints incl. `/api/v1/zcode-plan/chat/completions`, `/api/v1/off-peak/anthropic/v1/messages`, `/api/oauth/*`, `/api/v1/oauth/cli/init`, `/api/v1/oauth/token`, `/api/v1/releases/electron/manifest`, `/api/rpc-host-capability`, `/api/server-info` | path-literal extraction |
| 6.9 | Provider registry is desktop-authoritative and pushed to agents, revision-ordered to reject stale snapshots | `workspace/updateProviderRegistry`, `drainProviderRegistrySyncQueue`, log strings |

## 7. CONFIRMED — persistence and state

| # | Finding | Evidence |
|---|---|---|
| 7.1 | Agent DB `~/.zcode/cli/db/db.sqlite` via `node:sqlite` `DatabaseSync`; SQLite migrations run at startup | `import{DatabaseSync}from"node:sqlite"`; `zcode_protocol.startup.sqlite_migration.*` |
| 7.2 | Desktop task index `~/.zcode/v2/tasks-index.sqlite` (+ `-wal`, `-shm`) | `ls` |
| 7.3 | Automation columns: `automation_id,title,cron_expr,prompt,model,provider,mode,thought_level,workspace_key,workspace_path,workspace_identity,target_task_id,location_kind` | source |
| 7.4 | Full model I/O per session: `~/.zcode/cli/rollout/model-io-<sessionId>.jsonl` | live file, 424 KB and growing |
| 7.5 | Daily structured logs `~/.zcode/cli/log/zcode-YYYY-MM-DD.jsonl`; ~25 MB/day; `log.retention.cleanup.scheduled` | live files |
| 7.6 | Log record shape includes `traceId, spanId, parentSpanId, sessionId, turnId, toolCallId, durationMs, status, context{}` | log lines |
| 7.7 | Turn phases include `context_initialization`, `session_start_hooks` | log `context.phase` |
| 7.8 | Real turn trace observed: `turnNumber 87`, `iteration 9`, `messageCount 174`, a single `Bash` tool call with `durationMs 85855` | `zcode-2026-09-11.jsonl` |
| 7.9 | Automation-originated turns use `queryId: "automation-<uuid>:<epochMs>"` | log |
| 7.10 | Two optimistic-concurrency tokens guard conversation reads: `logEpoch` and `revision` | `proto.staleLogEpoch`, `proto.staleRevision` |
| 7.11 | Reserved subscription topics `sessions-index/…` and `workspace-config/…`; `workspace-config/` topic must exceed 17 chars | source (`CLr`, `WV`) |
| 7.12 | Desktop settings full key set (see `ZCODE_STATE_MODEL.md` §2.2) | `~/.zcode/v2/setting.json` |
| 7.13 | Plugin state files: `installed_plugins.json`, `known_marketplaces.json`, `icon-sources.json`, `bundled-marketplace.json`, `cdn-marketplace.json` | `ls` |
| 7.14 | Plugin format is **Claude Code-compatible** (`claude-plugins-official` marketplace, `.claude-plugin/`) | `ls` of marketplaces dir |

## 8. CONFIRMED — MCP, plugins, tools

| # | Finding | Evidence |
|---|---|---|
| 8.1 | `mcp/list` returns per-server `{status, transport, toolCount, updatedAt, error?, failureKind?, protocolEra?}` | live response (see §9) |
| 8.2 | `failureKind` values `network_unreachable`, `process_start_failed`; `status` `connected`/`failed`; `transport` `stdio`/`http`/`sse`; `protocolEra: "legacy"` observed | live response |
| 8.3 | Plugin-provided MCP servers key as `plugin:<pluginId>:<serverName>`; user servers by bare name | live response |
| 8.4 | MCP pool uses leases with session/workspace isolation | `mcp.pool.lease.acquired/released`, `mcpIsolation` |
| 8.5 | MCP tools are named `mcp__<server>__<tool>` | tool registry `mcp__node_repl__js` |
| 8.6 | QuickJS WASM sandbox backs the `js` tool (`quickjs.wasm`, `qjs_*` host API) | source + `readFile(new URL("../quickjs.wasm", …))` |
| 8.7 | Bundled search binaries `ripgrep`, `ugrep`, `bfs` with env overrides `ZCODE_{RIPGREP,UGREP,BFS}_BINARY` | resources + `LXi` version table |
| 8.8 | 8 bundled plugins under `resources/glm/packages/` | `ls` |
| 8.9 | Plugin descriptor shape includes `components[{kind:"command"|"skill"|"mcp",items[]}]`, `declaredMcpServerNames`, `mcpServerNames`, `hookDetails[]`, `rootPath`, `userConfig` (typed schema with defaults+descriptions) | live `plugins/list` response |
| 8.10 | ⚠ **Tool-budget ceiling:** GLM rejects >~89–94 registered tools with `[1210] Invalid API parameter`; user's own profile script documents 116 (full) vs 63 (trimmed) | `~/.zcode/cli/mcp-profile.cmd` |
| 8.11 | E2E harness channels are compiled into production: `zcode:e2e:{configure,read,clear}-final-arms-custom-events`, `__zcodeFinalArmsCustomEventsE2E` | preload |

## 9. Captured live responses (verbatim, abridged)

**`mcp/list`** (→ `zcode::mcp/list`):
```json
{"statuses":{
  "plugin:document-skills:image_search":{"status":"failed","transport":"http","toolCount":0,
     "error":"Version negotiation probe timed out after 5000ms","failureKind":"network_unreachable"},
  "plugin:computer-use:computer-use":{"status":"failed","transport":"stdio","toolCount":0,
     "error":"Connection closed","failureKind":"process_start_failed"},
  "comfyui":{"status":"connected","transport":"stdio","toolCount":4,"protocolEra":"legacy"},
  "remcp":{"status":"connected","transport":"stdio","toolCount":28,"protocolEra":"legacy"},
  "aseprite":{"status":"connected","transport":"stdio","toolCount":5,"protocolEra":"legacy"},
  "blender":{"status":"connected","transport":"stdio","toolCount":10,"protocolEra":"legacy"},
  "unreal":{"status":"connected","transport":"stdio","toolCount":12,"protocolEra":"legacy"}}}
```

**`usage/stats {"range":"7d"}`** — `summary` keys:
`totalTokens, inputTokens, outputTokens, reasoningTokens, cacheCreationTokens, cacheReadTokens,
cacheHitRate, totalSessions, totalTurns, toolCallCount, toolErrorRate, modelErrorRate,
avgTimeToFirstTokenMs, avgTurnDurationMs, activeDays, currentStreakDays, longestSessionMs,
longestStreakDays, peakDayTokens, favoriteModel{modelId,totalTokens,share}`;
`heatmap` keys: `startDate, endDate, maxTokens, weeks[{weekIndex, days[{date, level, totalTokens,
turnCount, toolCallCount}]}]`. Also `range`, `generatedAt`, `timeZone:"UTC"`, `source:"agent-db"`.

**`session/list`** item keys:
`createdAt, mode, traceId, sessionId, sessionKind, status, title, titleSource, updatedAt,
workspace{workspaceKey, workspacePath}`.

**`workspace/readState`** top-level keys: `modelCatalog`, `settings`, `slashCommands`, `workspace`.

**`plugins/list`** item keys: `id, name, description, version, enabled, source, marketplace, author,
skillCount, skillRootCount, commandRootCount, components[], declaredMcpServerNames, mcpServerNames,
hookDetails, rootPath, userConfig`.

## 10. STRONGLY INFERRED

| # | Finding | Basis |
|---|---|---|
| 10.1 | The host runs as a separate process from Electron main (utility process or child) | MessagePort handshake over `zcode:service-port`; 2.3 MB host bundle distinct from main |
| 10.2 | `out/scheduler/index.js` is the automation/cron executor plus `tasks-index.sqlite` writer | contains the same `attach-service-port` union; automation table + descriptor live in it |
| 10.3 | Vertex of the migration: ZCode is a from-scratch Electron app, **not** a VS Code fork | package set, IPC design, no `vscode` namespaces anywhere |
| 10.4 | Provider OpenAI-compatibility is implemented via an adapter that mimics the Anthropic Messages API shape | `kind:"anthropic"` on every builtin provider while `options.baseURL` points at Z.ai/BigModel Anthropic-compatible endpoints |
| 10.5 | Subagents are full child sessions, not in-process threads | `sess_subagent_agent_*` directories exist under `agents/`, `artifacts/`, `exec/`, `image-cache/` |
| 10.6 | The `plugins` subsystem is deliberately Claude-Code-plugin compatible to inherit an ecosystem | `claude-plugins-official` marketplace cache and `.claude-plugin/` layout |
| 10.7 | Log files are the agent's primary observability contract (not telemetry) | every subsystem emits structured JSONL with trace ids |

## 11. HYPOTHESIS (unverified — see `ZCODE_UNKNOWNS.md`)

| # | Hypothesis |
|---|---|
| 11.1 | Web Remote Control binds a local HTTP/WS listener and is the network form of the MessagePort attach |
| 11.2 | The remote/WebSocket transport can be started directly from the CLI (`app-server` + port/TLS flags) |
| 11.3 | `~/.zcode/cli/config.json` accepts a `provider` block mirroring `~/.zcode/v2/config.json` (the "Model config is missing" error implies it) |
| 11.4 | The desktop's `credentials.json` values are protected with Electron `safeStorage` (DPAPI) |
| 11.5 | `protocolEra: "legacy"` implies a newer MCP protocol era exists in current builds |
| 11.6 | Keyboard shortcuts exist only as renderer-internal handlers with no machine-readable registry |
| 11.7 | Per-workspace config may live under `<workspace>/.zcode/` (not observed on this machine) |

---

## 12. Environment side-effects of this investigation

| Action | Reversible? |
|---|---|
| Created `F:\Github\mcp\mnehmos.zcode.mcp\.re\` (analysis scripts + extracted bundles) | yes — delete the dir |
| Ran `zcode --help`, `version`, `doctor`, `app-server --help` | no state change |
| Spawned `app-server --stdio` 4 times for probing; each was SIGTERM'd | yes — children reaped by the transport's process-group kill |
| `mcp/list` started MCP servers inside those probe processes | yes — died with the probe process |
| Two harmless `--prompt` attempts; both failed **before** any model call (parser rejection, then `Model config is missing`) | **zero API spend** |
| Staged and immediately deleted a temp copy of the provider config in `$TEMP` for a schema test | deleted; confirmed gone |
| Wrote only inside `F:\Github\mcp\mnehmos.zcode.mcp\` | — |

No file outside this repository was modified. No credential was written, moved or echoed into any
artifact.
