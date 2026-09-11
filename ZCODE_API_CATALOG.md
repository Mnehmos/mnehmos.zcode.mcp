# ZCODE_API_CATALOG.md

Every API, IPC interface, RPC interface, protocol and communication surface discovered in
ZCode Desktop 3.11.2.

Obtained by: static extraction from `app.asar` bundles, live NDJSON probing of the agent runtime,
and inspection of live JSONL logs. All channel names and method names are **verbatim string
literals** unless marked otherwise.

---

## INDEX

| § | Surface | Transport | Reachability | Rating |
|---|---|---|---|---|
| 1 | ZCode Protocol (agent) | NDJSON over stdio / WebSocket | external process | **A** |
| 2 | Shell IPC (`zcode:*`) | Electron IPC | in-process only | E |
| 3 | Host RPC (dotted) | MessagePort | in-process only | D |
| 4 | v4 subscription gateway | MessagePort / agent protocol | via §1 | **B** |
| 5 | Permission broker RPC | unix socket / named pipe | local | C |
| 6 | MCP (as consumer) | stdio / SSE / HTTP | n/a | A |
| 7 | Model provider HTTP | HTTPS | outbound | B |
| 8 | Z.ai control plane HTTP | HTTPS | outbound | B |
| 9 | Web Remote Control | network | remote | **B** |
| 10 | CLI / headless interface | exec + stdio | external process | **A** |
| 11 | Filesystem control channels | files | local | **B** |
| 12 | Log/telemetry files | files | local | B |

---

## 1. ZCode Protocol — the agent control plane ★ PRIMARY

**Name/version:** `"ZCode Protocol"`, version `1`. Literals: `Rje = "ZCode Protocol"`, `Pje = 1`.
**Transport:** newline-delimited JSON over a child process's stdin/stdout, or WebSocket (remote).
**Endpoint construction:** `spawn(<node|zcode-agent.exe>, [".../zcode.cjs", "app-server", "--stdio"])`.
**Location:** `E:\zcode\resources\glm\zcode.cjs` (server); client in `app.asar/out/host/index.js`.
**Caller:** host (tier 2). **Receiver:** agent runtime (tier 3).
**Auth:** none on stdio — trust derives from process parentage. Remote/websocket mode advertises
`authRequired: boolean` in the server descriptor.

### 1.1 Envelope (CONFIRMED on the wire and in source)

```jsonc
// client → agent request   (id is a string on the client side; integer accepted)
{"id": 1, "method": "session/list", "params": {}}

// agent → client success
{"id": 1, "result": { … }}

// agent → client error
{"id": 1, "error": {"code": -32601, "message": "Method not found: bogus/method", "data": {…}}}

// agent → client notification (no id)
{"method": "process/mcpTelemetry", "params": { … }}

// agent → client REQUEST (server needs something from the client)
{"id": "server-1", "method": "interaction/requestOfficialMcpAuthHeaders", "params": { … }}
```

Transport-layer decode (class `X3e`):
- `JSON.parse` failure → `sendError("parse-error", -32700, "Parse error")`
- envelope validation failure → `sendError("invalid-message", -32600, "Invalid ZCode Protocol message", {issues})`
- Processing is **strictly serialised** (`this.processing = this.processing.then(...)`),
  **except `session/stop`, which bypasses the queue** (`shouldBypassProcessingQueue`).
- Responses are emitted, then any post-response frames (subscription initial frames), then `commit()`.

**Error codes**

| Code | Meaning | Where raised |
|---|---|---|
| `-32700` | Parse error | transport decode |
| `-32600` | Invalid message | envelope validation |
| `-32601` | Method not found | `dispatchRequest` default |
| `-32602` | Invalid params | zod `.safeParse` failure; `message: "Invalid params — <path>: <issue>"` |
| `-32603` | Handler/internal error | thrown exception in handler |
| `-32004` | `sessionUnavailable` | `XB = {sessionUnavailable: -32004}` |

**Validation error payload shape (useful for schema discovery at runtime):**
```json
{"code":-32602,
 "message":"Invalid params — workspace: Invalid input: expected object, received undefined",
 "data":{"name":"ZodError","message":"[…issues json…]"}}
```
Note: handler-internal zod failures (code `-32603`) include a **`stack`** field exposing
`<minifiedFnName> (E:\zcode\resources\glm\zcode.cjs:<line>:<col>)` — this is how the dispatch
table's handler names were recovered.

### 1.2 Complete method catalogue (66 methods, from the dispatch switch)

Source anchor: `zcode.cjs:3123` `async dispatchRequest(t){ switch(t.method){ … } }`.
Enums: `qe` (host→agent + notifications), `ev` (agent→host notifications), `bn`/`dc` (v4 requests),
`bv`/`UL` (v4 notifications).

#### 1.2.1 `session/*` — 22 methods

| Method | Handler | Notes |
|---|---|---|
| `session/create` | `l3e(context, params, trace)` | params via `buildSessionCreateParams` (below) |
| `session/resume` | `$pn` | `buildSessionResumeParams` |
| `session/list` | `qpn` | **works with `{}`** — see response schema §1.3 |
| `session/read` | `Vpn` | |
| `session/messages` | `Wpn` | |
| `session/events` | `Hpn` | |
| `session/subscribe` | `Zpn` | |
| `session/send` | `Kpn` | `buildSessionSendParams` |
| `session/stop` | `Xpn` | **bypasses the processing queue** |
| `session/cancelBackgroundTask` | `emn` | |
| `session/fork` | `Qpn` | |
| `session/compact` | `Jpn` | |
| `session/goal` | `Ypn` | |
| `session/close` | `amn` | |
| `session/setModel` | `tmn` | |
| `session/setThoughtLevel` | `rmn` | |
| `session/updateRuntimeModelConfig` | `omn` | |
| `session/setMode` | `imn` | |
| `session/subagents` | `c3e` | |
| `session/usage` | `Bwt` | same impl as `v4/usage/stats`+session |
| `session/requestRuntimePreferences` | (onRequest branch) | agent→host **request** |
| `session/requestRuntimePreferences` reply | `respond(id, {askUserQuestionAutoResolutionEnabled, nativeSearchEnhancementsEnabled, memoryEnabled})` | default when authority is `local` |

**`session/create` params** — `buildSessionCreateParams` (CONFIRMED):
```ts
{
  sessionId, workspace: {workspacePath, workspaceIdentity?, remoteSessionId?, workspaceKey},
  parentSessionId, mode, model,
  runtimeModel?, persistence?, thoughtLevel?, titleGenerationEnabled?,
  mcpServers?, toolAllowlist?, toolDenylist?, importedHistory?
}
```
**`session/send` params** adds (`getSessionSendCompatFields`):
`browserAmbientContext, automationId, offPeakTaskId, offPeakRunType, botDeliveryTarget, toolDenylist`.
**`session/resume`** accepts `runtimeModel, thoughtLevel, mcpServers, toolAllowlist, toolDenylist`.
**`session/compact`** accepts `runtimeModel`.
Compatibility sets exist so unknown *compat* fields are tolerated only if **all** unrecognised keys
belong to the accepted set (`getUnrecognizedTopLevelKeys` → `unrecognized_keys` issues).

#### 1.2.2 `workspace/*` — 12 methods

| Method | Handler | Notes |
|---|---|---|
| `workspace/readState` | `Fdn` | **requires `workspace` object**; returns full UI state — see §1.3 |
| `workspace/hooks/trustGrant` | inline | `{accepted}`; needs `appVersion` + `policyProvider` |
| `workspace/updateProviderRegistry` | `zdn` | `{workspace, registry, includeWorkspaceState}` → `{appliedProviderRevision, providerCount, status}` |
| `workspace/updateInteractionPreferences` | `Gmn` | `{workspace, preferences:{askUserQuestionAutoResolutionEnabled}}` |
| `workspace/updateModelIoPreferences` | `Hmn` | `{workspace, preferences:{fullRetentionEnabled}}` |
| `workspace/upsertModelProvider` | `Udn` | |
| `workspace/removeModelProvider` | `$dn` | |
| `workspace/setDefaultModel` | `qdn` | |
| `workspace/setDefaultThoughtLevel` | `Vdn` | |
| `workspace/setDefaultMode` | `Gdn` | |
| `workspace/generateText` | `smn(context, params, signal)` | cancellable |
| `workspace/cancelGenerateText` | `cancelWorkspaceGenerateText` | |

#### 1.2.3 v4 conversation & subscription — 21 methods

| Method | Handler / behaviour |
|---|---|
| `v4/connection/flow` | `setConnectionFlowState(params)` → `{}`. `state: "saturated"\|"drained"\|"closed"` |
| `v4/controller/subscribe` | `{connectionId, clientMode, workspace?, legacyTaskIds?[≤200], resumeThoughtLevel?}` |
| `v4/controller/resync` / `unsubscribe` | |
| `v4/conversation/subscribe` | topic-routed: `sessions-index/…` → `subscribeSessionsIndexReserved`; `workspace-config/…` → `subscribeWorkspaceConfigReserved`; else `subscribeReserved`. Returns `{ack}`; **initial frames are delivered after the response** as `{method:"v4/conversation/frame"}` batch + `commit()` |
| `v4/conversation/resync` | `forceSnapshot?` supported |
| `v4/conversation/unsubscribe` | |
| `v4/conversation/rowsRange` | `{sessionId, beforeRowId?, limit≤200, baseLogEpoch, baseRevision, clientMode}` |
| `v4/conversation/plans` | `{sessionId, target?, baseLogEpoch, baseRevision}` |
| `v4/conversation/fileChanges` | → `host.getConversationFileChanges(sessionId,rowId,messageIds,turnId)` |
| `v4/conversation/fileRewindPreview` | → `host.previewConversationFileRewind(...)` |
| `v4/conversation/usage` | |
| `v4/attachment/begin\|chunk\|commit\|abort\|read\|previewSource` | staged upload/read (see limits §1.5) |
| `v4/commands/query` | `YLr.parse({commands:[≥1]})` → `{results: inbox.query(commands)}`. Each entry `{sessionId: string\|null, …}` |
| `v4/command` | **generic command execution** — see §1.4 |
| `v4/usage/stats` | `Dwt(context, params)` — requires `range ∈ {"all","7d","30d"}` |
| `v4/telemetry/event` | notification: `conversationTelemetryFact` |

Subscription params (CONFIRMED):
```ts
{ topic: string(≤2048), subscriptionId: string(≤1024), connectionId: string(≤1024),
  base: {logEpoch: string(≤1024), seq: int≥0} | null,
  forceSnapshot?: boolean }
```
Staleness guards: `proto.staleLogEpoch`, `proto.staleRevision`.
Ownership guard: `fault.subscription.notOwned`.
Capability guards: `fault.fileChanges.unsupported`, `fault.fileRewindPreview.unsupported`,
`fault.attachment.putUnsupported`.

#### 1.2.4 `interaction/*` — 6 methods (agent → client REQUESTS)

These are the agent asking the UI for something. The **client must respond** with
`{"id": <same id>, "result": …}` or `{"id": <same id>, "error": {…}}`.

| Method | Client response |
|---|---|
| `interaction/requestPermission` | `{decision: allow\|deny\|escalate\|modify, reason?, modifiedInput?, permissionUpdates?: [{type:"addRules",behavior:allow\|deny\|ask,rules:[{toolName,ruleContent?}]}]}` |
| `interaction/requestUserInput` | user answer |
| `interaction/requestProviderRuntimeHeaders` | `{modelRef:{providerId,modelId,variant?}, providerId, requestId, sessionId, turnId?}` request → headers |
| `interaction/requestOfficialMcpAuthHeaders` | request `{mcpKey, pluginId, targetOrigin, requestId, workspace}` → `{ok:true, headers}` \| `{ok:false, reason:"official_mcp_origin_untrusted"\|"official_auth_unavailable"}` |
| `interaction/browserList` | `{browsers:[…]}` |
| `interaction/browserExecute` | `{ok, error?:{code,message}, elapsedMs}`; error codes `backend_unavailable`, `execution_error` |

#### 1.2.5 `plugins/*` — 18 methods

`plugins/list`, `plugins/overview`, `plugins/describe`, `plugins/install`, `plugins/uninstall`,
`plugins/update`, `plugins/setEnabled`, `plugins/configure`, `plugins/resetConfig`,
`plugins/restoreBuiltin`, `plugins/validate`, `plugins/cancelOperation`,
`plugins/referenceCatalog`, `plugins/resolveSuggestedReference`,
`plugins/marketplace/add`, `plugins/marketplace/remove`, `plugins/marketplace/update`,
plus notification `plugins/operationProgress`.
Long-running ops take an abort signal (`withPluginOperationSignal`) and are cancellable via
`plugins/cancelOperation`.

#### 1.2.6 `automation/*` — 5 methods

| Method | Params → Result |
|---|---|
| `automation/create` | `{title?, cronExpr?, relativeDelayMinutes?, intervalUnit?, interval?, prompt, model?, provider?, mode?, thoughtLevel?, targetTaskId?, botDeliveryTarget?, recurring?=true, maxRuns?}` → `{automation}` |
| `automation/list` | `{}` → `{automations:[…]}` |
| `automation/update` | `{automationId, title?, cronExpr?, prompt?, recurring?, maxRuns?, intervalUnit?, interval?}` → `{automation}` |
| `automation/delete` | `{automationId}` → `{deleted}` |
| `automation/checkTaskBinding` | `{targetTaskId}` → `{bound}` |

Automation record (SQLite columns): `automation_id, title, cron_expr, prompt, model, provider,
mode, thought_level, workspace_key, workspace_path, workspace_identity, target_task_id,
location_kind ("remote"|"local")`. **Max 20 retained** (`AutomationCreateLimitError`).

#### 1.2.7 Other methods

| Method | Notes |
|---|---|
| `mcp/list` | requires `workspace` |
| `skills/referenceCatalog` | requires `workspace` |
| `usage/stats` | requires `range ∈ {all,7d,30d}` → full usage analytics (see §1.3) |
| `process/resourceSample` | notification → host emitter |
| `process/mcpTelemetry` | notification. Observed params: `{arch, kind:"process_start", mcpId, mcpInstanceId, mcpIsolation:"session"\|"workspace", mcpSource:"custom"\|"builtin", occurredAt, platform}` |
| `computer-use/operation-event` | notification → CUA operation tracker |

### 1.3 Representative live responses (CONFIRMED — real data captured)

**`session/list` with `{}` →** (titles and paths genericised; key set and types are verbatim)
```json
{"sessions":[{"createdAt":1789136036765,"mode":"build","traceId":"9e0239dc-…",
 "sessionId":"sess_73e6429a-…","sessionKind":"interactive","status":"idle",
 "title":"<session title>","titleSource":"generated",
 "updatedAt":1789139016043,
 "workspace":{"workspaceKey":"F:\\projects\\example",
              "workspacePath":"F:\\projects\\example"}}]}
```
`titleSource ∈ {generated, custom, first_input}`.

**`workspace/readState` with `{workspace}` →**
```json
{"modelCatalog":{"available":[],"providers":[],"revision":0},
 "settings":{"mode":{"current":"yolo"},
             "model":{"available":[],
                      "current":{"modelId":"missing-model","providerId":"zcode-unconfigured"},
                      "lastUsed":{"modelId":"missing-model","providerId":"zcode-unconfigured"}},
             "permission":{"mode":"yolo"},
             "thoughtLevel":{"available":[],"enabled":false}},
 "slashCommands":[{"description":"Show or set the current session goal.",
                   "inputHint":"/goal [pause|resume|clear|replace <objective>|<objective>]",
                   "name":"goal","source":"builtin"}, … ],
 "workspace":{"workspacePath":"…","workspaceKey":"…"}}
```
`available: []` / `missing-model` / `zcode-unconfigured` is the **expected** result for a bare
`app-server` with no host: provider config is pushed in by the desktop. A host-attached agent
returns the real catalogue.

**`usage/stats` with `{"range":"7d"}` →** full analytics object:
```json
{"range":"7d","generatedAt":…,"timeZone":"UTC","source":"agent-db",
 "summary":{"totalTokens":2247207820,"inputTokens":…,"outputTokens":…,"reasoningTokens":…,
            "cacheCreationTokens":…,"cacheReadTokens":…,"cacheHitRate":0.9775,
            "totalSessions":31,"totalTurns":373,"toolCallCount":7956,
            "toolErrorRate":0.0282,"modelErrorRate":0.0071,
            "avgTimeToFirstTokenMs":6673.1,"avgTurnDurationMs":699077.5,
            "activeDays":6,"currentStreakDays":4,"longestSessionMs":31932413,
            "longestStreakDays":4,"peakDayTokens":1001946680,
            "favoriteModel":{"modelId":"…","totalTokens":…,"share":0.5348}},
 "heatmap":{"startDate":"2026-09-04","endDate":"2026-09-11","maxTokens":…,
            "weeks":[{"weekIndex":0,"days":[{"date":"…","level":0-2,
                      "totalTokens":…,"turnCount":…,"toolCallCount":…}]}]}}
```

**`plugins/list` with `{workspace}` →** array of plugin descriptors:
```json
{"plugins":[{"id":"android-emulator@zcode-plugins-official","name":"android-emulator",
 "description":"…","version":"0.1.0","enabled":false,"source":"official",
 "marketplace":"zcode-plugins-official","author":"Z.ai",
 "skillCount":0,"skillRootCount":0,"commandRootCount":0,
 "components":[{"kind":"command","items":[{"name":"android-dev","description":"…"}]},
               {"kind":"skill","items":[{"name":"android-dev","description":"…"}]},
               {"kind":"mcp","items":[{"name":"android-emulator"}]}],
 "declaredMcpServerNames":["android-emulator"],"mcpServerNames":[],
 "hookDetails":[],
 "rootPath":"C:\\Users\\mnehm\\.zcode\\cli\\plugins\\cache\\zcode-plugins-official\\android-emulator\\0.1.0",
 "userConfig":{"sdk_path":{"type":"string","default":"","description":"…"}, …}}]}
```

### 1.4 `v4/command` — the generic command surface ★

**This is the single most valuable method for an MCP.** One method creates sessions, sends
prompts, steers, and compacts.

**Params** = an *envelope*:
```ts
{ commandId: string, sessionId: string | null, type: "createSession" | "sendText" | "sendGoalCommand" | "compact",
  payload: { … }, trace?: … }
```
Observed envelope construction (`buildConversationCommandEnvelope`):
```js
{ type: "sendText", payload: { ...sendText, toolDisallowlist: normalize(...) } }
```
**Result:**
```json
{"status":"accepted","result":{…}}                       // executed
{"status":"noop","reasonCode":"fault.command.noop"}      // nothing to do (error class g1)
{"status":"failed","reasonCode":"fault.command.notImplemented" | "fault.command.executionFailed"
                    | "proto.payloadTooLarge","message":"…"}
```

**Queue item model (`gP`)** — the admission contract:
```ts
{
  sourceCommandId: string, queueItemId: string, clientId: string,
  kind: "sendText" | "sendGoalCommand" | "compact",
  text: string,
  attachments: [{ref, fileName, mime, bytes, previewRef?}],   // default []
  delivery:    {requested: "auto"|"startNow"|"queue"|"guide",
                admitted: "startNow"|"queue"|"guide", fallbackReasonCode?},
  order:       {admissionSeq: int≥0, queuePosition?: int≥0},
  steer:       {state:"notRequested"|"submitting"|"steering"|"guided"|"fellBack", reasonCode?},
  dispatch:    {state:"admitted"|"queued"|"reserved"|"promoting"|"drained", reservationId?}
}
```
Admission is size-checked against `logicalFrameAssemblyMaxBytes` before acceptance
(`measureInputAdmissionProjectionBytes`) and can return `proto.payloadTooLarge`.
Host hooks called: `host.admitCommandInput(envelope, ctx)`, `host.executeCommand(envelope, ctx)`,
`host.cancelCommandInput(envelope, queueItemId, reasonCode)`,
`inbox.pinLiveInput` / `inbox.releaseLiveInput`.
`v4/commands/query` takes `{commands:[{sessionId, …}]}` (min 1 item) → `{results:[…]}`.

### 1.5 Protocol limits
See `ZCODE_ARCHITECTURE.md` §5.3. Most important: **`maxFrameBytes` = 1 MiB** — payloads larger
than this must go through `v4/attachment/*` (20 MiB cap, 512 KiB chunks).

### 1.6 Transport implementations

**`ZCodeStdioTransport`** (CONFIRMED verbatim): `kind="stdio"`; `spawn` child; writes
`` `${JSON.stringify(t)}\n` ``; reads stdout lines via `readline` + `StringDecoder`; optional
`onStderrLine`; `fireClose({code,signal})` on exit; `dispose()` kills the owned process group and
verifies the tree exited. Send when closed throws exactly
`"ZCode agent stdio transport is closed"` (`isClosedStdioTransportError`).

**`ZCodeProtocolClient`** (CONFIRMED): `request(method, params, resultSchema, {timeoutMs, signal})`,
`notify(method, params)`, `respond(id, result)`, `respondError(id, error)`.
Events: `onNotification`, `onRequest`, `onRequestTimeout`, `onPendingRequestsDrained`, `onClose`.
Default `requestTimeoutMs` = **180 000 ms**. Ids are `String(nextRequestId++)`.
Result payloads are zod-parsed when a schema is supplied
(`"ZCode Protocol response parse failed: <method>"` on failure).
Timeout error: `ZCodeProtocolRequestTimeoutError("ZCode Protocol request timed out: <method>")`.
Server error wrapper: `ZCodeProtocolClientError{code,data}`.

**WebSocket transport**: CONFIRMED to exist — `initialize()` returns
`transportKind === "websocket" ? "websocket" : "stdio"`. Remote server descriptor:
```ts
{ serverId, name?, version, protocolVersion: 1, authRequired: boolean,
  workspaces: [{path, label?, workspaceIdentity?}],
  capabilities: { desktopContinuous: true, websocketRpc: true } }
```
Binding address, path and handshake are **not yet confirmed** — see `ZCODE_UNKNOWNS.md` U-1.

---

## 2. Shell IPC — `zcode:*` channels (129 total)

Transport: Electron IPC (`ipcRenderer.invoke` / `.send` / `.on`). **Not reachable from outside the
process.** Listed for completeness and for UI→action mapping.

Full list is in the extracted JSON map `ch-preload.json`; grouped:

**Bootstrap & routing**
`zcode:renderer-ready`, `zcode:service-port`, `zcode:scoped-service-port`,
`zcode:scoped-service-port-ready`, `zcode:open-workspace`, `zcode:open-workspace-path`,
`zcode:activate-or-set-workspace`, `zcode:new-tab`, `zcode:new-task`, `zcode:focus-tab`,
`zcode:close-active-context-request`, `zcode:sync-window-tabs`,
`zcode:sync-active-task-session`, `zcode:sync-window-unread-count`, `zcode:sync-app-settings`,
`zcode:settings-changed`, `zcode:application-locale-changed`, `zcode:set-application-locale`,
`zcode:get-system-locale`

**Remote & containers**
`zcode:connect-remote`, `zcode:cancel-pending-remote-connection`, `zcode:dispose-remote-session`,
`zcode:bind-remote-workspace-session-context`, `zcode:remote-connection-log`,
`zcode:remote-session-closed`, `zcode:bot-remote-workspace-reconnected`,
`zcode:is-docker-available`, `zcode:list-wsl-distros`, `zcode:list-docker-containers`,
`zcode:list-ssh-config-aliases`

**Web Remote Control**
`zcode:start-web-remote-control`, `zcode:stop-web-remote-control`,
`zcode:get-web-remote-control-status`, `zcode:reset-web-remote-control-pairing`,
`zcode:web-remote-control-status-changed`, `zcode:sync-web-remote-control-workspaces`,
`zcode:sync-web-remote-control-tasks`, `zcode:web-remote-control-reconnect-workspace`

**Embedded browser**
`zcode:open-browser-url`, `zcode:browser-view-ready`, `zcode:browser-view-operation`,
`zcode:browser-view-attach-guest`, `zcode:browser-view-detach-guest`,
`zcode:browser-view-ensure-resident`, `zcode:browser-view-report-residency`,
`zcode:browser-view-close-tab`, `zcode:browser-view-close-tab-from-renderer`,
`zcode:browser-view-restore-tabs`, `zcode:browser-view-suspend`, `zcode:browser-view-suspend-ready`,
`zcode:browser-view-restore`, `zcode:browser-view-visibility`,
`zcode:browser-view-update-viewport`, `zcode:browser-view-viewport-changed`,
`zcode:browser-view-screenshot-surface-prepare|ready|release`,
`zcode:embedded-browser-javascript-dialog`, `zcode:clear-embedded-browser-data`,
`zcode:import-chrome-browser-data`

**Dialogs & files**
`zcode:select-directory`, `zcode:select-file`, `zcode:select-files`, `zcode:save-file`,
`zcode:print-to-pdf`, `zcode:create-temp-text-attachment`, `zcode:open-in-editor`,
`zcode:open-in-file-manager`, `zcode:get-installed-editors`, `zcode:open-external`,
`zcode:can-open-community`, `zcode:open-feedback-dialog`, `zcode:open-tickets-panel`

**Window chrome & diagnostics**
`zcode:window-controls-overlay-ready|changed`, `zcode:desktop-window-chrome-state-changed`,
`zcode:get-desktop-window-chrome-state`, `zcode:set-title-bar-theme`,
`zcode:desktop-zoom-level-changed`, `zcode:get-desktop-zoom-level`,
`zcode:window-fullscreen-changed`, `zcode:get-process-metrics`, `zcode:open-process-monitor`,
`zcode:capture-window-screenshot`, `zcode:execute-desktop-command`,
`zcode:get-desktop-session-activity`, `zcode:get-application-icon`, `zcode:get-device-id`,
`zcode:log`, `zcode:export-logs`, `zcode:get-zcode-stdio-tap-dev-state`

**MCP config files**
`zcode:load-mcp-from-user-directory`, `zcode:save-mcp-to-user-directory`,
`zcode:migrate-legacy-common-mcp`

**OAuth / payment**
`zcode:oauth-callback`, `zcode:oauth-register-state`, `zcode:oauth-callback-handled`,
`zcode:payment-callback`

**Updater**
`zcode:get-update-state`, `zcode:update-state-changed`, `zcode:update-ready`,
`zcode:update-check-result`, `zcode:download-update`, `zcode:cancel-update-download`,
`zcode:quit-and-install-update`, `zcode:open-update-status-window`,
`zcode:skip-update-version`, `zcode:get-auto-update-preferences`,
`zcode:set-auto-download-and-install-updates`, `zcode:post-update-release-notes`,
`zcode:ack-post-update-release-notes`

**CUA permissions**
`zcode:open-cua-permission-onboarding`, `zcode:cancel-cua-permission-onboarding`,
`zcode:prepare-cua-helper-permission-drag`, `zcode:start-cua-helper-permission-drag`,
`zcode:notify-cua-helper-permission-drag-ended`, `zcode:get-cua-gray-enabled`

**Notifications & telemetry**
`zcode:show-task-notification`, `zcode:task-notification-click`,
`zcode:task-notification-sound`, `zcode:report-telemetry-event`,
`zcode:report-arms-custom-event`, `zcode:sync-telemetry-context`,
`zcode:get-renderer-action-trace-config`, `zcode:renderer-action-trace-config-changed`,
`zcode:report-renderer-action-trace-batch`, `zcode:perf:start`, `zcode:perf:stop`

**E2E harness (shipped!)**
`zcode:e2e:configure-final-arms-custom-events`, `zcode:e2e:read-final-arms-custom-events`,
`zcode:e2e:clear-final-arms-custom-events` — an E2E event bus compiled into production.

---

## 3. Host RPC (dotted namespace)

Transport: Electron **MessagePort**, after `attach-service-port`.
Attach modes: `clientMode: "desktop-continuous" | "web-remote-replayable"`, plus a `scope`.

**Requests (client → host):** `workspace.list`, `workspace.set`, `task.list`, `task.set`,
`session.event`, `model.list`, `model.set`, `model.provider.set`, `model.streaming`,
`mode.list`, `mode.set`, `thoughtLevel.list`, `thoughtLevel.set`, `reply.list`, `reply.set`,
`permission.request`, `permission.respond`, `elicitation.submit`, `elicitation.respond`,
`selection.cancel`, `userInput.request`, `userInput.response`, `mcp.servers`.

**Events (host → client):** `workspace.upserted`, `workspace.removed`, `task.upserted`,
`task.removed`, `session.updated`, `session.upserted`, `state.updated`, `tool.updated`,
`turn.started`, `turn.completed`, `turn.failed`, `turn.steerQueued`, `turn.steerDrained`,
`permission.requested`, `permission.resolved`, `elicitation.*`, `userInput.request`,
`phase.completed`, `phase.error`, `streamRecovery.updated`, `meta.mode`, `meta.model`,
`meta.provider`, `meta.titleUpdated`.

Deeper details (auth, envelopes, MCP tools) are in `ZCODE_CONTROL_SURFACES.md` §3.

---

## 4. Permission broker RPC

Transport: `net.createConnection(socketPath)` — Unix domain socket, or Windows **named pipe**.
Framing: one JSON object per line: `` `${JSON.stringify({id,method,params})}\n` ``.

| | |
|---|---|
| Caller | agent runtime |
| Receiver | `cua-helper` (permission broker server) |
| Optional preamble | `{"id":0,"method":"authenticate","params":{"token":"…"}}` |
| Max frame | 67 108 864 B (64 MiB) default |
| Timeout | finite, positive ms — enforced via socket `setTimeout` |
| Windows guard | refuses any pipe not matching the `zcode-cua-helper` namespace (`refusing broker pipe outside zcode-cua-helper namespace`) |
| POSIX guard | refuses sockets not owned by current euid (or root); refuses world-writable sockets (`untrusted_socket`) |
| Cancel semantics | `rpc_deadline_state` + `request_delivery_state` tracked so a cancelled call is never half-delivered |
| Env escape | `allowAnyPeer` when both a flag and a JSON config are set (dev/test only) |
| Error | `ZCode permission broker RPC was cancelled before the next socket transition` |

---

## 5. MCP (ZCode as MCP *client*)

- Pooled: log events `mcp.pool.connection.created`, `mcp.pool.lease.acquired`,
  `mcp.pool.lease.released`, `mcp.pool.connection.closed`, `mcp.pool.connection.stale`,
  `mcp.server.connect.started`, `mcp.server.connected`, `mcp.server.closed`, `mcp.server.failed`,
  `mcp.server.ping.failed`, `mcp.tools.registered`, `mcp.adapter.closed`.
- Isolation modes observed: `mcpIsolation: "session" | "workspace"`, `mcpSource: "custom" | "builtin"`.
- Tool naming: `mcp__<server>__<tool>` (e.g. `mcp__node_repl__js`).
- Config: `~/.zcode/cli/config.json` → `mcp.servers.<name> = {command, args[], env{}}`.
- MCP is also *managed over the protocol*: `mcp/list`, `zcode:load-mcp-from-user-directory`,
  `zcode:save-mcp-to-user-directory`, `zcode:migrate-legacy-common-mcp`.
- The agent can request **official MCP auth headers** from the desktop via
  `interaction/requestOfficialMcpAuthHeaders` with origin-trust validation
  (`official_mcp_origin_untrusted`, `official_auth_unavailable`).

**Tool-budget constraint (CONFIRMED, from the user's own `~/.zcode/cli/mcp-profile.cmd`):**
GLM backends reject requests above a ceiling between **89 and 94** registered tools with
`[1210] Invalid API parameter`. The full profile registers ~116 tools, the trimmed profile ~63.
**Any MCP server added to ZCode should keep its tool count small, or be toggled per profile.**

---

## 6. Model provider HTTP

Configured per provider in `~/.zcode/v2/config.json` (desktop) and pushed to the agent.

```json
{"provider":{"builtin:zai":{"name":"Z.ai - API Key","kind":"anthropic",
   "options":{"apiKey":"","baseURL":"https://api.z.ai/api/anthropic","apiKeyRequired":true},
   "source":"custom",
   "models":{"GLM-5.3-Flash":{"reasoning":{"enabled":true,"variants":["low","max","high"],
                                        "defaultVariant":"max"},
                              "limit":{"context":1000000,"output":128000},
                              "modalities":{"input":["text","image","video"],"output":["text"]},
                              "zcode":{"modified":false,"priority":100}}},
   "systemDisabledReason":"oauth_provider_inactive"}},
 "builtin:bigmodel":{ … "baseURL":"https://open.bigmodel.cn/api/anthropic" … }}
```
Model reference shape: `{providerId, modelId, variant?}`. Logs show ids like
`builtin:zai-coding-plan/GLM-5.3-Flash`.
Provider family domains: `zai`, `bigmodel`. Endpoint routing module
`adapters.model.provider_endpoint_routing` (event `model.provider_endpoint_routing.snapshot_updated`).

---

## 7. Z.ai control-plane HTTP endpoints

Verbatim path literals extracted from the bundles:

```
/api/anthropic
/api/auth/z/login
/api/biz                                     /api/biz/customer/getCustomerInfo
/api/biz/subscription/list
/api/intranet/probe
/api/monitor/usage/quota/limit
/api/oauth/authorize                         /api/oauth/userinfo
/api/paas/c1f3a7e2/v2/client
/api/pay                                     /api/pay/paypal/
/api/rpc-host-capability
/api/server-info
/api/v1/agent/configs                        /api/v1/client/configs
/api/v1/client/scenes
/api/v1/coding-plan/reset
/api/v1/mcp/usage
/api/v1/oauth/cli/init                       /api/v1/oauth/token
/api/v1/off-peak/anthropic/v1/messages       /api/v1/off-peak/ticket
/api/v1/off-peak/ticket/availability         /api/v1/off-peak/ticket/status
/api/v1/releases/electron/manifest
/api/v1/snapshot/upload-credential
/api/v1/zcode-plan/anthropic/v1/messages
/api/v1/zcode-plan/billing/claim             /api/v1/zcode-plan/billing/preview
/api/v1/zcode-plan/chat/completions
/api/v2/releases/latest
```
Hosts: `api.z.ai`, `dev.zcode.app`, `zcode.z.ai`, `open.bigmodel.cn`, `bigmodel.cn`.

Request headers added by the desktop (`buildZCodeSourceHeadersFromContext`):
```
User-Agent: ZCode/<appVersion>          HTTP-Referer: <endpointOrigin>
X-Title: Z Code@electron                X-ZCode-App-Version
X-Platform: <platform>-<arch>           X-Release-Channel
X-Client-Language                       X-Client-Timezone
X-Os-Category: macos|windows|linux      X-Os-Version
X-Device-Mid
```
Auth: OAuth for Z.ai. Credential keys in `~/.zcode/v2/credentials.json`:
`oauth:zai:access_token`, `oauth:zai:user_info`, `oauth:active_provider`, `zcodejwttoken`.

---

## 8. Web Remote Control

Channels (CONFIRMED): `StartWebRemoteControl`, `StopWebRemoteControl`,
`GetWebRemoteControlStatus`, `ResetWebRemoteControlPairing`,
`WebRemoteControlStatusChanged`, `SyncWebRemoteControlWorkspaces`,
`SyncWebRemoteControlTasks`, `WebRemoteControlReconnectWorkspace`.

Purpose (STRONGLY INFERRED from the `clientMode: "web-remote-replayable"` attach mode and the
status/workspace/task sync channels): expose the host RPC over the network so a browser or another
machine can drive workspaces and tasks, with a **replayable** (resumable-from-seq) subscription mode
rather than the desktop's `desktop-continuous` mode.

Binding address, port, routes and pairing mechanics: **not yet determined** — see
`ZCODE_UNKNOWNS.md` U-1. Do not assume it is enabled; the peer app must opt in.

---

## 9. CLI / headless interface ★

`node E:\zcode\resources\glm\zcode.cjs …`

```
Commands:
  app-server   Run the ZCode Protocol stdio app server      ← the control plane
  commands     List custom slash commands (`commands list`)
  doctor       Inspect runtime and packaging assumptions
  login        Sign in with Z.AI OAuth for model access
  logout       Remove the shared Z.AI login credentials
  plugins      List and enable installed plugins (`plugins list`)
  skills       List local skills (`skills list`)
  tui          Open the terminal UI
  version      Print the CLI version
```
Options (verbatim): `-h/--help`, `-v/--version`, `--prompt <text>`, `--browser-use <headless>`,
`--surface <terminal|desktop>`, `--browser-executable <path>`, `-p/--print`, `--attach <path>`
(repeatable), `--cwd <path>`, `--disallowedTools/--disallowed-tools <tools…>`, `--force-mcs`,
`--locale <en-US|zh-CN|auto>`, `--mode <build|edit|plan|yolo>` (default `yolo` for `--prompt`),
`--settings <path>`, `--permission-mode <default|build|edit|plan|yolo>`, `--max-turns <n>`,
`--allowed-tools <list>`, `--disallowed-tools <list>`, `--allow-main-worktree-yolo`,
`--resume <sessionId>`, `--target <text>`, `--target-replace`, `-c/--continue`, `--json`,
`--no-browser`, `--no-color`, `--verbose`.

Slash commands: `/help`, `/login`, `/logout`, `/compact`, `/expert`, `/fork`, `/mcp`, `/mode`,
`/model`, `/new`, `/resume`, `/rewind`, `/skill`, `/goal`.

**This gives a complete one-shot agent interface** —
`node zcode.cjs --prompt "<task>" --json --cwd <dir> --mode build --max-turns N` — with no
protocol implementation required. `--json` is described as "Print machine-readable JSON where
supported". Exact JSON shape: see `ZCODE_UNKNOWNS.md` U-2.

---

## 10. Filesystem control channels

| Path | Read | Write | Notes |
|---|---|---|---|
| `~/.zcode/cli/config.json` | ✔ | ✔ | `mcp.servers`, `plugins.enabledPlugins`. **Agent reads at startup** — live-writable, restart to apply |
| `~/.zcode/v2/setting.json` | ✔ | ✔ | desktop settings (see `ZCODE_STATE_MODEL.md` §4) |
| `~/.zcode/v2/config.json` | ✔ | ✔ | provider registry |
| `~/.zcode/cli/db/db.sqlite` | ✔ | ⚠ | agent's live DB; WAL mode. Read-only copy preferred |
| `~/.zcode/v2/tasks-index.sqlite` | ✔ | ⚠ | desktop task index |
| `~/.zcode/cli/log/zcode-*.jsonl` | ✔ | – | append-only observability |
| `~/.zcode/cli/rollout/model-io-*.jsonl` | ✔ | – | full model I/O per session |
| `<workspace>/AGENTS.md` | ✔ | ✔ | agent instructions (`/init` writes it) |
| `<workspace>/.zcode/…` | – | – | HYPOTHESIS: per-workspace config; not confirmed on this machine |

---

## 11. Environment-variable interface

| Variable | Effect | Evidence |
|---|---|---|
| `ZCODE_DEBUG` | enables debug in preload | CONFIRMED (preload) |
| `ZCODE_SURFACE` | presentation surface (`terminal`/`desktop`; also CLI `--surface`) | CONFIRMED |
| `ZCODE_APP_VERSION` | product version used for telemetry/headers | CONFIRMED |
| `ZCODE_TELEMETRY_DEVICE_MID` | device mid injection | CONFIRMED |
| `GLM_BINARY_PATH` | override agent runtime binary | CONFIRMED (descriptor `binaryEnvVar`) |
| `ZCODE_AGENT_WORKDIR` | agent runtime work dir | CONFIRMED (error message) |
| `ZCODE_SERVICE_AUTHORITY_MODE` | `desktop-attached-remote` toggles authority mode | CONFIRMED |
| `ZCODE_RIPGREP_BINARY`, `ZCODE_UGREP_BINARY`, `ZCODE_BFS_BINARY` | search tool binary overrides | CONFIRMED |
| `ANDROID_HOME`, `ANDROID_SDK_ROOT` | android-emulator plugin | CONFIRMED (plugin `userConfig` description) |
| `UE_MCP_ENGINE`, `UE_MCP_WORK_DIR`, `COMFYUI_URL`, `ASEPRITE_BIN`, `BLENDER_BIN` | third-party MCP servers in this user's config | CONFIRMED |

---

## 12. Stability assessment

| Surface | Stability | Why |
|---|---|---|
| ZCode Protocol method names | **High** | versioned (`protocolVersion: 1`), zod-validated, published over a stable name |
| ZCode Protocol envelope | **High** | JSON-RPC 2.0 shape; standard error codes |
| Protocol *param* details | Medium | zod schemas are strict; compat-field allowlists show they do evolve |
| `session/list`, `workspace/readState`, `v4/commands/query`, `v4/command` | **High** | core paths, used by the desktop itself |
| CLI flags | **High** | documented in `--help`, explicitly include headless mode |
| Shell IPC channels | Low | no compatibility contract; internal |
| Host RPC dotted names | Low–Medium | internal, no version field |
| SQLite schemas | Low | private; migrations exist |
| Config file shapes | Medium | documented shapes, tolerant readers (`readJsonFile` returns a default on parse failure) |
| Log JSONL | Medium | append-only, but field sets change |
