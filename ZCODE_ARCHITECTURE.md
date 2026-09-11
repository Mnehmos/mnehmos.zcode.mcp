# ZCODE_ARCHITECTURE.md

Complete architecture reconstruction of ZCode Desktop **3.11.2** (agent runtime **0.16.5**),
derived by reverse engineering the shipped Electron bundle and its live runtime state.

**Evidence legend**
- **CONFIRMED** — directly demonstrated (executed, observed on the wire, or read verbatim from shipped code).
- **STRONGLY INFERRED** — multiple independent pieces of evidence agree.
- **HYPOTHESIS** — plausible, not yet verified. Every hypothesis is listed in `ZCODE_UNKNOWNS.md`.

Line/column anchors of the form `zcode.cjs:3123:78786` were leaked verbatim by the runtime's own
ZodError stack traces during live probing, so they are exact.

---

## 1. Executive summary

ZCode is **not a monolith and not a VS Code fork**. It is a *three-tier* system:

```
┌──────────────────────────────────────────────────────────────────────────┐
│ TIER 1 — ELECTRON SHELL            E:\zcode\ZCode.exe  (Electron 41.0.3) │
│  main process        out/main/index.js        (+ 9 chunks)               │
│  preload bridges     out/preload/*.cjs        (6 bridges)                │
│  renderer (React 19) out/renderer/            (44 MB SPA, Vite build)    │
│  webview bridges     codingPlanWebview, cuaPermissionPanel, ...          │
└──────────────────────────────────────────────────────────────────────────┘
                    │  Electron MessagePort  ("attach-service-port")
                    │  + 129 `zcode:*` IPC channels for shell duties
┌──────────────────────────────────────────────────────────────────────────┐
│ TIER 2 — HOST / SERVER             out/host/index.js (2.3 MB)            │
│  @zcode/server + @zcode/rpc + @zcode/services + @zcode/shared            │
│  • session/task/workspace registry   • permission & elicitation broker   │
│  • v4 subscription gateway (topics)  • plugin + marketplace manager      │
│  • automation scheduler              • provider registry authority       │
│  Spawns and supervises TIER 3.                                           │
└──────────────────────────────────────────────────────────────────────────┘
                    │  ZCode Protocol  (JSON-RPC-ish, NDJSON framed)
                    │  spawnArgs = ["app-server", "--stdio"]  |  websocket
┌──────────────────────────────────────────────────────────────────────────┐
│ TIER 3 — AGENT RUNTIME             resources/glm/zcode.cjs (12.6 MB SEA) │
│  a.k.a. `zcode-agent` native binary, or the Node bundle above            │
│  • model adapters (Anthropic-shaped)  • tool executor (30+ tools)        │
│  • MCP client pool                    • session/turn/queue engine        │
│  • own SQLite persistence             • permission broker client         │
└──────────────────────────────────────────────────────────────────────────┘
```

**The single most important finding for this project:**
Tier 3 is a *headless, scriptable, self-describing server*. It can be launched by an unrelated
process and driven entirely over stdin/stdout with newline-delimited JSON. This is the
semantic control plane. Everything in `ZCODE_MCP_SPEC.md` is built on it.

```
$ node E:\zcode\resources\glm\zcode.cjs app-server --stdio --cwd <dir>
>>> {"id":1,"method":"bogus/method","params":{}}
<<< {"error":{"code":-32601,"message":"Method not found: bogus/method"},"id":1}
```
CONFIRMED — executed, response received 1.1 s after launch.

---

## 2. Processes and runtime topology

| PID role | Executable | Evidence |
|---|---|---|
| Electron main | `E:\zcode\ZCode.exe` | CONFIRMED `Win32_Process.CommandLine` |
| Renderer / GPU / utility | `ZCode.exe --type=renderer\|gpu-process\|utility` | CONFIRMED |
| Crashpad handler | `ZCode.exe --type=crashpad-handler` | CONFIRMED; `--database=C:\Users\mnehm\.zcode\v2\crash\live` |
| Agent runtime | `node zcode.cjs app-server --stdio` **or** `zcode-agent.exe app-server --stdio` | CONFIRMED (descriptor + live spawn) |
| MCP servers (per session) | arbitrary `command`+`args` from config | CONFIRMED via `process/mcpTelemetry` notifications |
| Terminal host | `node-pty` inside main/host | CONFIRMED (`app.asar.unpacked/node_modules/node-pty`) |
| Remote sessions | `ssh2` → remote `zcode-agent` | STRONGLY INFERRED (`remote:ssh:`, `remote:wsl:`, `ssh2` dep) |

Electron **41.0.3**; bundler-derived Electron Builder **26.8.1**; build commit `89817f5b`,
built `2026-09-04T08:04:18.527Z`.

### 2.1 Agent runtime descriptor
Verbatim from `out/host/chunk-RWMCBKS2.js` (≈ offset 541121):

```js
var A4 = {
  binaryKind: "native-binary",
  binaryEnvVar: "GLM_BINARY_PATH",
  bundledResourceDir: "glm",
  version: "0.13.3",
  spawnArgs: ["app-server", "--stdio"],
  nativeConfigDir: ".zcode/cli",
  nativeConfigFileName: "config.json",
  missingBinaryMessage: "[ZCode Agent] glm binary 未找到，请设置 ZCODE_AGENT_WORKDIR、GLM_BINARY_PATH 或先准备 GLM 运行时资源",
  resolveEntrySegments: (platform) => [ "zcode-agent" + (platform === "win32" ? ".exe" : "") ],
  nodeBundleEntryFile: "zcode.cjs",
  resolveNodeBundleSegments() { return [this.nodeBundleEntryFile]; }
};
```

CONFIRMED. Note the descriptor's `version: "0.13.3"` is a *floor/label*; the shipped bundle
self-reports `0.16.5` (`zcode --help`), and the live log records `version:"0.16.5"`.

Resolution order for the runtime (functions `findZCodeAgentRuntimeBinary` /
`findZCodeAgentRuntimeNodeBundle`): env override (`GLM_BINARY_PATH`) → `<bundledResourceDir>/<segments>`
→ `~/.zcode/server/agents/<bundledResourceDir>/<segments>` → `desktop/bundled-resources` search paths
→ `process.cwd()/packages/desktop/bundled-resources`, `../desktop/bundled-resources`.
`doctor` reports `default artifact: node-bundle` and `sea: no`, i.e. **on this machine the Node bundle
(`zcode.cjs`) is authoritative, not a native binary.**

---

## 3. Tier 1 — Electron shell

### 3.1 Main process
`E:\zcode\resources\app.asar` → `out/main/index.js` (1.49 MB) + `chunk-WR3FEWGO.js` (535 KB, the
largest and the home of the IPC channel table) + 8 smaller chunks.

Responsibilities (CONFIRMED from chunk contents):
- Window / tab / task lifecycle; `WindowControlsOverlay`, native titlebar metrics, zoom.
- 129 `zcode:*` IPC channels (`out/preload/index.cjs`, see `ZCODE_API_CATALOG.md` §2).
- **Embedded browser** (`BrowserView*` channels: attach/detach guest, screenshots, viewport,
  residency, suspend/restore) — a `WebContentsView`-based browser, plus Playwright-backed
  Browser Use via the agent's `interaction/browserExecute`.
- **CUA helper permission broker**: `PrepareCuaHelperPermissionDrag`,
  `NotifyCuaHelperPermissionDragEnded`, `OpenCuaPermissionOnboarding`. Tools live in
  `resources/tools/cua-helper/`.
- Updater (`electron-updater`), OAuth callback capture, telemetry (ARMS/RUM), payment callback.
- Desktop command execution: channel `zcode:execute-desktop-command`.

### 3.2 Preload bridges (6)
| File | Size | Role |
|---|---|---|
| `out/preload/index.cjs` | 496 KB | main renderer bridge; exposes `window.zcode` |
| `out/preload/codingPlanWebview.cjs` | 478 KB | coding-plan webview |
| `out/preload/cuaPermissionPanel.cjs` | 476 KB | CUA permission UI |
| `out/preload/embeddedBrowserJavaScriptDialog.cjs` | 478 KB | browser dialog shim |
| `out/preload/processMonitor.cjs` | 476 KB | process monitor window |
| `out/preload/browserVideoRecorder.cjs` | 140 B | video recording |

Each bridge is ~476 KB because the shared runtime (Zod, zod schemas, IPC constants) is inlined;
only `require("electron")` is external (CONFIRMED: single `require` in the bundle).

Exposed globals (CONFIRMED):
`window.zcode` (main API), `__ZCODE_DEVICE_ID__`, `__zcodeFinalArmsCustomEventsE2E`.

### 3.3 Renderer
`out/renderer/` — 44 MB Vite SPA. Stack evidence from `node_modules` inside the asar:
React 19.2, `@reduxjs` (store), Radix UI, `framer-motion`, Lexical (rich text composer),
xterm.js (terminal), Monaco-adjacent? *no* — code rendering via `@shikijs` + `highlight.js` +
`@pierre` (diff), `mermaid`, `echarts`/`recharts`/`chart.js` (usage dashboards), `pdfjs-dist`,
`@rive-app`, `rrweb`/`rrweb-snapshot`/`rrdom` (session replay), `msw` (mock service worker),
`@modelcontextprotocol` (SDK), `ai` + `@ai-sdk/*` (Vercel AI SDK), `graphql`, `hono` (server in
host), `ws`, `ssh2`, `node-pty`, `playwright-core`, `sharp`, `undici`, `yaml`, `semver`,
`yazl` (zip export), `node-forge`.

UI surfaces named in asset filenames: `AppUsageDailyModelTrendChart`, `CodingPlanUsageBarChart`,
`WikiReferenceSidePane`, `IntlProvider`. `index.html` is 24 KB.

---

## 4. Tier 2 — Host / server

`out/host/index.js` (2.31 MB) + `chunk-RWMCBKS2.js` (578 KB) + 9 chunks. Internal package names
in `package.json`: `@zcode/server`, `@zcode/rpc`, `@zcode/services`, `@zcode/shared`, `@zcode/ui`,
`@zcode/client`, `@zcode/zcode-cua`, `@zcode/e2e-report`, `@zcode/desktop`.
A `sourceRelativePath` literal `server/zcode-server.cjs` shows the host is also shipped as a bundle.

The host is the **broker** between the UI and N agent runtimes.

### 4.1 Attachment protocol (host ↔ client)
The host does not hand the renderer a TCP port. It accepts an **Electron `MessagePort`**:

```
attach-service-port   { requestId, attachmentId,
                        clientMode: "desktop-continuous" | "web-remote-replayable",
                        scope }
detach-service-port   { attachmentId }
dispose               {}
broadcast             { message }
```
Also: `init-local`, `connect-remote-workspace`, `cancel-remote-workspace-connect`,
`bind-remote-workspace-context`, `dispose-remote-workspace-session`,
`bot-remote-workspace-reconnect-result`, `bot-remote-workspace-connection-status-result`,
`bot-remote-workspace-runtime-port`.

The renderer asks for the port over the shell IPC channel `zcode:service-port` /
`zcode:scoped-service-port` (+ `…-ready`), CONFIRMED in the preload's IPC table.

> **Consequence for MCP:** the desktop's own control channel is *not* network-reachable. We must
> either (a) drive the agent runtime directly over stdio, or (b) use the Web Remote Control
> surface, which exists precisely to expose this port over the network
> (`web-remote-replayable`).

### 4.2 Host-level RPC namespace (dotted, not the agent protocol)
CONFIRMED by string extraction from `out/host/index.js`:

```
workspace.list  workspace.set
task.list       task.set
session.event
model.list      model.set   model.provider.set   model.streaming
mode.list       mode.set
thoughtLevel.list  thoughtLevel.set
reply.list      reply.set
permission.request   permission.respond
elicitation.submit   elicitation.respond
selection.cancel
userInput.request    userInput.response
mcp.servers
usage.*  state.updated  tool.updated
```
Events pushed host→client: `workspace.upserted|removed`, `task.upserted|removed`,
`session.updated|upserted`, `state.updated`, `tool.updated`, `turn.started|completed|failed`,
`turn.steerQueued|steerDrained`, `permission.requested|resolved`, `elicitation.*`,
`userInput.request`, `phase.completed|error`, `streamRecovery.updated`, `meta.*`
(`meta.mode`, `meta.model`, `meta.provider`, `meta.titleUpdated`).

### 4.3 v4 subscription gateway
Topic-based pub/sub with ownership self-check. Error `fault.subscription.notOwned` is thrown when a
connection acts on a subscription it does not own.

```
v4/controller/subscribe    { connectionId, clientMode, workspace?, legacyTaskIds?[≤200], resumeThoughtLevel? }
v4/controller/resync
v4/controller/unsubscribe
v4/conversation/subscribe  { topic, subscriptionId, connectionId, base:{logEpoch,seq}|null, forceSnapshot? }
v4/conversation/resync     { …, base }
v4/conversation/unsubscribe
v4/conversation/rowsRange  { sessionId, beforeRowId?, limit≤200, baseLogEpoch, baseRevision, clientMode }
v4/conversation/plans
v4/conversation/fileChanges        { sessionId, target:{rowId}, baseLogEpoch, baseRevision }
v4/conversation/fileRewindPreview  { … }
v4/conversation/usage
v4/connection/flow         { connectionId, state: "saturated"|"drained"|"closed" }
```
Reserved topic prefixes: **`sessions-index/…`** and **`workspace-config/…`** (a `workspace-config/`
topic must be longer than 17 chars). Staleness guards: `proto.staleLogEpoch`, `proto.staleRevision`.
Subscribers have bounded buffers (`subscriberBufferMaxOps: 500`).

### 4.4 Sequencing and event normalization
`normalizeSessionEventSeq` assigns monotonic `seq` per session; duplicate `eventId`s are
de-duplicated and replayed with their original seq. Live delivery is gate-kept by
`shouldDeliverLiveSessionEvent`. A **background coalescer** merges `model.streaming` deltas
(flush 1500 ms, max 96 items) and `tool.updated` progress, so high-frequency streaming does not
flood the wire.

---

## 5. Tier 3 — Agent runtime (`zcode.cjs`)

12.6 MB single-file bundle, 3 264 lines, minified but **not mangled** — `s(fn,"name")` calls
preserve every function name and all string literals survive.

### 5.1 Self-description
```
$ node zcode.cjs --help
zcode 0.16.5
Commands: app-server | commands | doctor | login | logout | plugins | skills | tui | version
$ node zcode.cjs doctor
version: 0.16.5   process: zcode-cli   node: v22.22.1   platform: win32/x64
sea: no (optional)   default artifact: node-bundle
```
CONFIRMED.

Internal modules (from `module` fields in `~/.zcode/cli/log/*.jsonl`):
`core.runtime`, `core.tool.executor`, `core.subagent`, `adapters.model`,
`adapters.model.provider_endpoint_routing`, `adapters.mcp`, `adapters.mcp.pool`,
`adapters.logging`, `bootstrap`, `bootstrap.zcode_protocol`, `bootstrap.zcode_protocol.mcp`,
`bootstrap.zcode_protocol_v4.commands`.

### 5.2 Protocol server internals (all CONFIRMED from source)
Class `Q3e` (server), method chain `handleMessage → handleRequest → dispatchRequest → ok/fail`.

```js
// envelope discrimination
if (isClientResponse(t))      this.resolveClientRequest(t.id, t.result);
else if (isClientError(t))    this.rejectClientRequest(t.id, new qa(code,message,data));
else if (isRequest(t))        await this.handleRequest(t);
else /* notification */       logger.debug("ZCode Protocol notification ignored");

// transport layer (class X3e)
decodeLine(line):
  JSON.parse        → fail: sendError("parse-error", -32700, "Parse error")
  envelope.safeParse→ fail: sendError("invalid-message", -32600, "Invalid ZCode Protocol message", {issues})
processQueue: this.processing = this.processing.then(...)   // strict serial ordering
shouldBypassProcessingQueue(t): t.method === "session/stop"  // stop is never queued behind work
```

**Wire envelope** (JSON-RPC 2.0 shape, *no* `jsonrpc` field, string ids on the client side):
```
request       {"id":1,          "method":"session/create", "params":{…}}
response ok   {"id":1,          "result":{…}}
response err  {"id":1,          "error":{"code":-32603,"message":"…","data":{…}}}
notification  {"method":"process/mcpTelemetry","params":{…}}          // no id
server→client {"id":"server-1", "method":"interaction/requestPermission","params":{…}}
```
Error codes observed: `-32700` parse, `-32600` invalid message, `-32601` method not found,
`-32602` invalid params, `-32603` internal/handler error, `-32004` `sessionUnavailable`.
`params` failures return `message:"Invalid params — <path>: <zod message>"` with
`data:{name:"ZodError", message|stack:…}` — **the ZodError stack leaks handler function names and
exact `zcode.cjs:line:col` anchors**, which is how the dispatch table below was recovered.

Protocol identity: `protocol.name = "ZCode Protocol"`, `protocol.version = 1` (literals `Rje`, `Pje`).

### 5.3 Frame limits (object `nn`, CONFIRMED)
| Limit | Value |
|---|---|
| `maxFrameBytes` | 1 MiB |
| `logicalFrameAssemblyMaxBytes` / `MaxFragments` / `MaxConcurrent` / `MaxStagedBytes` | 16 MiB / 1024 / 32 / 32 MiB |
| `logicalFrameAssemblyTimeoutMs` | 30 s |
| `transportEnvelopeIdMaxChars` | 256 |
| `subscriberBufferMaxOps` / `MaxBytes` | 500 / 1 MiB |
| `eventRetentionPerSession` | 2000 |
| `snapshotTailWindowRows` / `rowsRangeMaxLimit` | 60 / 200 |
| `toolOutputFinalHeadBytes` / `TailBytes` | 32 KiB / 32 KiB |
| `commandPendingTtlMs` / `idempotencyTablePerSession` | 24 h / 512 |
| `conversationQueryTimeoutMs` | 10 s |
| `attachmentMaxBytes` / `ChunkMaxBytes` / `PreviewMaxBytes` | 20 MiB / 512 KiB / 30 MiB |
| `attachmentUploadMaxChunks` / `MaxConcurrent` / `MaxStagedBytes` / `TtlMs` | 64 / 16 / 64 MiB / 5 min |
| `attachmentReadCacheMaxBytes` / `TtlMs` | 30 MiB / 30 s |

Because `maxFrameBytes` is 1 MiB, **large payloads must use the attachment channel**
(`v4/attachment/begin|chunk|commit`), not inline params. `assertV4AttachmentNdjsonEnvelope`
enforces this at the desktop side.

### 5.4 Modes, statuses, kinds (CONFIRMED enums)
- Mode `k1`: `plan | build | edit | yolo | auto`
- Session status `UBe`: `idle | running | waiting | paused | completed | error`
- Session kind `bbn`: `interactive | fork | selection_side_chat | workflow_parent | workflow_child | subagent_child | nested_workflow_child`
- Permission decision: `allow | deny | escalate | modify`; rule behavior: `allow | deny | ask`
- Queue/steer: delivery `requested: auto|startNow|queue|guide`, `admitted: startNow|queue|guide`;
  steer `state: notRequested|submitting|steering|guided|fellBack`;
  dispatch `state: admitted|queued|reserved|promoting|drained`
- Model streaming part kinds: `start | finish | error | text_start | text_delta | text_end | reasoning_start | reasoning_delta | reasoning_end | tool_input_start | tool_input_delta | tool_input_end | tool_call`

---

## 6. Communication matrix

| # | Path | Transport | Framing | Auth | Rating |
|---|---|---|---|---|---|
| 1 | renderer ↔ main | Electron IPC | structured clone | process boundary | E |
| 2 | renderer ↔ host | Electron **MessagePort** | postMessage | MessagePort capability | D |
| 3 | host ↔ agent | **stdio pipes** | NDJSON (JSON-RPC-ish) | none (parent owns child) | **A** |
| 4 | host ↔ agent (remote) | **WebSocket** | same protocol | `authRequired` + token | **B** |
| 5 | agent ↔ MCP servers | stdio / SSE / HTTP | MCP | per-server config | A |
| 6 | agent ↔ permission broker | Unix socket / Windows named pipe | NDJSON `{id,method,params}\n` | `authenticate` message with token + peer-credential check | C |
| 7 | agent ↔ model providers | HTTPS | provider SDK | OAuth / API key | A |
| 8 | agent ↔ Z.ai control plane | HTTPS | REST | OAuth (`zcodejwttoken`) | A |
| 9 | terminal | `node-pty` | byte stream | none | A |
| 10 | Web Remote Control | network → host | host RPC, `web-remote-replayable` | pairing | B |

Ranking rationale is in `ZCODE_CONTROL_SURFACES.md`.

### 6.1 Permission broker details (CONFIRMED)
`PermissionBrokerClient`:
- `net.createConnection(socketPath)`, NDJSON per line.
- Optional first message: `{"id":0,"method":"authenticate","params":{"token":…}}`.
- `maxFrameBytes` default 67 108 864 (64 MiB).
- Peer verification refuses sockets not owned by the current euid (or root) and refuses
  world-writable sockets. **On Windows it refuses any named pipe whose name does not match the
  `zcode-cua-helper` namespace.**
- Cancellation is modelled explicitly (`rpc_deadline_state`, `request_delivery_state`), so a
  cancelled call can never be half-delivered.

### 6.2 Agent runtime env, spawn and lifecycle
`ZCodeStdioTransport`: `spawn` child → write `${JSON.stringify(msg)}\n` to stdin → read stdout lines
(`readline` + `StringDecoder`) → optional `onStderrLine` for diagnostics. On dispose it kills the
**owned process group** and verifies the tree is gone (`captureCleanupSnapshot`, retry counts).
Send on a dead transport raises exactly `"ZCode agent stdio transport is closed"`.
`initialize()` returns `{available, workspaceKey, protocolName, protocolVersion, transportKind, reason?, reasonCode?}`;
`transportKind` is either `"stdio"` or `"websocket"` — **CONFIRMED two transports**.

---

## 7. Persistence architecture

| Store | Path | Owner | Format | Evidence |
|---|---|---|---|---|
| Agent primary DB | `~/.zcode/cli/db/db.sqlite` (+`-wal`,`-shm`) | agent | SQLite (`node:sqlite` `DatabaseSync`) | CONFIRMED |
| Agent config | `~/.zcode/cli/config.json` | agent | JSON (`{mcp:{servers:{}},plugins:{enabledPlugins:{}}}`) | CONFIRMED |
| Sessions/models I/O | `~/.zcode/cli/rollout/model-io-<sessionId>.jsonl` | agent | JSONL | CONFIRMED |
| Logs | `~/.zcode/cli/log/zcode-YYYY-MM-DD.jsonl` | agent | JSONL, daily, retention-managed | CONFIRMED (25 MB/day) |
| Bash startup / snapshots | `~/.zcode/cli/exec/bash-startup`, `exec/shell-snapshots`, `exec/<sess>` | agent | mixed | CONFIRMED |
| Artifacts / images | `~/.zcode/cli/artifacts/<sess>`, `image-cache/<sess>` | agent | mixed | CONFIRMED |
| Plugins | `~/.zcode/cli/plugins/{cache,data,marketplaces}` | agent | Claude-Code plugin layout | CONFIRMED |
| Task index | `~/.zcode/v2/tasks-index.sqlite` | desktop | SQLite | CONFIRMED |
| Desktop settings | `~/.zcode/v2/setting.json` | desktop | JSON | CONFIRMED |
| Provider registry | `~/.zcode/v2/config.json` | desktop | JSON | CONFIRMED |
| Credentials | `~/.zcode/v2/credentials.json` | desktop | JSON, keys `oauth:zai:*`, `zcodejwttoken`, `oauth:active_provider` | CONFIRMED (values redacted) |
| Bot state | `~/.zcode/v2/bot-state.v2.json` | desktop | JSON | CONFIRMED |
| Chromium profile | `%APPDATA%\ZCode\session\` | Electron | LevelDB/IndexedDB/Preferences | CONFIRMED |
| Plugin workspace | `~/.zcode/plugin-workspace` | host | dir | CONFIRMED |
| Default workspace | `~/.zcode/workspace/default` | desktop | dir | CONFIRMED |
| Certificates | `~/.zcode/v2/certs` | desktop | dir | CONFIRMED |

Automations live in the **agent** SQLite (table seen in source: `automation_id, title, cron_expr,
prompt, model, provider, mode, thought_level, workspace_key, workspace_path, workspace_identity,
target_task_id, location_kind`), max 20 retained.

---

## 8. End-to-end flows

### 8.1 Cold start
```
ZCode.exe
 → Electron main: restore windows/zoom/overlay; register 129 zcode:* handlers
 → load renderer (React SPA); preload exposes window.zcode
 → renderer requests service port            [zcode:service-port]
 → main creates MessagePort to host
 → renderer sends attach-service-port {clientMode:"desktop-continuous", scope}
 → host: init-local → resolve workspace ref → findZCodeAgentRuntime* → spawn
        `node zcode.cjs app-server --stdio`  (or zcode-agent.exe)
 → ZCodeProtocolClient over ZCodeStdioTransport
 → host requests workspace/readState + session/list → pushes state.updated / session.event
 → renderer hydrates store; v4 subscriptions opened for sessions-index/ and workspace-config/
```
CONFIRMED for every step except the exact ordering inside the renderer.

### 8.2 Submit a prompt (the AI request path)
```
composer → renderer builds v4 command envelope
  { type:"sendText", payload:{ text, attachments[], delivery:{requested:auto|startNow|queue|guide},
                               toolDisallowlist?, automationId? } }
 → host RPC → host.admitCommandInput(envelope, {admissionSeq, admittedAt, queueItemId})
 → v4/command  → agent Inbox: query/admit → queue item (kind: sendText|sendGoalCommand|compact)
 → agent turn:  turn.phase.started(context_initialization)
                turn.phase.started(session_start_hooks)
                model.request.started → model.network.completed → model.sdk.stream.completed
                session.event.persistence.started/completed   (per event)
                tool.call.started/completed   (per tool, iteration N)
 → streaming back: notifications {method:"session/event"} + {method:"v4/conversation/frame"}
 → host normalizes seq, coalesces deltas, fans out to subscribers
 → renderer renders
 → terminal: turn.completed  (result: {status:"accepted", result?})
```
CONFIRMED (log events + source). Command admission is bounded by
`logicalFrameAssemblyMaxBytes`; exceeding it returns `status:"failed", reasonCode:"proto.payloadTooLarge"`.

### 8.3 Tool call requiring permission
```
agent tool executor → notification OR server→client request
  {"id":"server-N","method":"interaction/requestPermission","params":{sessionId,requestId,…}}
 → host stores {client, protocolRequestId} keyed by (workspace,session,requestId)
   (deduplicates: only fires permission.request once per key)
 → renderer shows prompt → user decides
 → renderer → host permission.respond {decision: allow|deny|escalate|modify, reason?, modifiedInput?, permissionUpdates?}
 → host → agent  m.respond(protocolRequestId, decision)
```
CONFIRMED. Analogous paths exist for `interaction/requestUserInput` (`userInput.request` →
`userInput.response`), `interaction/requestProviderRuntimeHeaders`,
`interaction/requestOfficialMcpAuthHeaders`, and elicitation
(`elicitation/submit`, `elicitation/respond`).

### 8.4 Apply an AI edit / read a diff
```
agent edits file → session events kind:"checkpoint.created" / tool.updated
 → v4/conversation/fileChanges  {sessionId, target:{rowId}, baseLogEpoch, baseRevision}
    → host.getConversationFileChanges(sessionId,rowId,messageIds,turnId)
 → v4/conversation/fileRewindPreview {…} → host.previewConversationFileRewind(…)
 → session event kind:"rewind.triggered" on accept
```
CONFIRMED from source; `fault.fileChanges.unsupported` / `fault.fileRewindPreview.unsupported`
are raised when the host lacks the capability.

### 8.5 Settings change
```
UI toggle → host RPC (one of model.set / mode.set / thoughtLevel.set / model.provider.set)
          → syncAppRuntimePreferences →
             agent workspace/updateInteractionPreferences {askUserQuestionAutoResolutionEnabled}
           and workspace/updateModelIoPreferences {fullRetentionEnabled}
          → host mirrors to ~/.zcode/v2/setting.json (desktop) and provider registry
          → meta.mode / meta.model / state.updated pushed back
```
CONFIRMED (`enqueueInteractionPreferenceSync`, `syncProviderRegistrySnapshotToClient`,
`drainProviderRegistrySyncQueue`).

### 8.6 Shutdown
Renderer detach → host `detach-service-port` → on last client: dispose transports; stdio transport
kills the owned process group and verifies exit; SQLite WAL checkpoints.

---

## 9. Architectural boundaries actually observed

| Boundary | Reality |
|---|---|
| UI ↔ application | Electron IPC + MessagePort; renderer holds a **replica** store, host is truth |
| application ↔ workspace | host owns a `workspaceKey`-indexed registry of clients and provider-registry sync state |
| editor subsystem | **No autonomous editor engine.** File text lives in the renderer's editor + the agent's tools; the host brokers *file changes* and *rewind previews* per conversation row |
| agent subsystem | fully separate process with its own DB, config, logs, plugin tree |
| terminal | `node-pty` in the shell tier; agent has its own `Bash` tool + background-job tracking |
| filesystem | two independent writers: agent tools (authoritative for edits) and terminals; host does not mediate |
| networking | model + control-plane traffic from the **agent**; shell traffic (update, telemetry, browser) from Electron |
| persistence | split-brain by design: desktop `~/.zcode/v2` vs agent `~/.zcode/cli` |

> **There is no "editor document service" to bind to.** The nearest thing to an editor API is the
> conversation file-change surface. For a filesystem-oriented MCP, the stable interface is the
> **agent's own tools** (`Read`/`Write`/`Edit`/`Glob`/`Grep`) driven through
> `v4/command`, or plain filesystem I/O in the MCP process itself. This is the single most
> important architectural constraint on the design in `ZCODE_MCP_SPEC.md`.

---

## 10. Extension, plugin and skill architecture

- Plugin root: `~/.zcode/cli/plugins/{cache,marketplaces,data}`.
- **Claude Code-compatible format**: marketplaces include `claude-plugins-official` with a
  `.claude-plugin/` directory and `marketplace.json`; state in `installed_plugins.json`,
  `known_marketplaces.json`, `icon-sources.json`.
- Bundled plugins ship in `E:\zcode\resources\glm\packages\`: `android-emulator-plugin`,
  `browser-use-plugin`, `document-skills-plugin`, `ios-simulator-plugin`,
  `restore-legacy-sessions-plugin`, `skill-creator-plugin`, `zcode-cua-plugin`, `zcode-guide-plugin`.
- A plugin contributes `components: [{kind:"command"|"skill"|"mcp"|"hook", items:[…]}]`
  and may declare `declaredMcpServerNames`, `userConfig` (a typed config schema with defaults and
  descriptions, surfaced to the user) and `hookDetails`.
- Full management protocol: `plugins/list|install|uninstall|update|setEnabled|describe|configure|
  resetConfig|restoreBuiltin|validate|overview|referenceCatalog|resolveSuggestedReference|
  marketplace/{add,remove,update}|cancelOperation`, with progress notifications
  `plugins/operationProgress` and cancellable operation handles.
- Skills: `skills/list` CLI, `skills/referenceCatalog` protocol method, `/skill` slash command;
  skill-creator plugin available.
- Custom slash commands: `commands list` CLI; `v4/commands/query` protocol method.

**Conclusion:** an MCP bridge *could* be shipped as a ZCode plugin (it would inherit discovery,
config UI, and lifecycle), but that path only reaches the agent's own tool surface. It cannot
expose host/desktop state. See `ZCODE_MCP_SPEC.md` §7.

---

## 11. AI / agent subsystem summary

See `ZCODE_AGENT_ARCHITECTURE.md`. Headline facts:
- Anthropic-shaped model adapters (`adapters.model`), provider registry synced *from host to agent*
  (`workspace/updateProviderRegistry`, revision + `generatedAt` ordering to reject stale snapshots).
- Tool registry is a fixed list; MCP tools are namespaced `mcp__<server>__<tool>`.
- Subagents spawn child sessions (`sessionKind: subagent_child`) with parent links.
- MCP servers are pooled (`mcp.pool.connection.created/lease.acquired/lease.released/closed/stale`)
  with per-session and per-workspace isolation.
- Everything is logged as structured JSONL with `traceId`/`spanId`/`parentSpanId` — a ready-made
  observability surface for the MCP.
