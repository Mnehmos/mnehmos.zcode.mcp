# ZCODE_COMMAND_CATALOG.md

Commands, events, handlers, arguments and implementations across all ZCode registries.

There are **six independent command/event registries**. They are not unified — that is a real
architectural fact and it constrains the MCP design.

| # | Registry | Namespace form | Count | Where | Remote-callable |
|---|---|---|---|---|---|
| 1 | ZCode Protocol | `namespace/verb` | 66 | agent | ✔ **yes** |
| 2 | Host RPC | `namespace.verb` | ~24 + ~22 events | host | via MessagePort only |
| 3 | Agent tool registry | `PascalCase` | 30+ | agent | indirectly (model-driven) |
| 4 | Bot command language | `/slash …` | 20+ | host (desktop/messaging bots) | ✔ text in, typed command out |
| 5 | CLI slash commands | `/slash` | 14 | agent CLI/TUI | ✔ via `--prompt` |
| 6 | Plugin/MCP commands | `plugin:command` | per-plugin | plugin tree | via `v4/commands/query` |

---

## 1. ZCode Protocol (66 methods)

Source: `zcode.cjs:3123` `dispatchRequest`. Handler function names are the minified identifiers the
runtime itself reports in ZodError stack traces, so they are exact.

### 1.1 Requests — `session/*`

| Method | Handler | Args | Returns | Side effects | Prerequisites |
|---|---|---|---|---|---|
| `session/create` | `l3e(context,params,trace)` | `{sessionId, workspace:{workspacePath,workspaceIdentity?,remoteSessionId?,workspaceKey}, parentSessionId, mode, model, runtimeModel?, persistence?, thoughtLevel?, titleGenerationEnabled?, mcpServers?, toolAllowlist?, toolDenylist?, importedHistory?}` | session object | creates session row, spins session-resident runtime, registers publisher | valid `workspace` |
| `session/resume` | `$pn` | create-params minus `parentSessionId`, plus compat `runtimeModel, thoughtLevel, mcpServers, toolAllowlist, toolDenylist` | session | hydrates from cold storage | session exists |
| `session/list` | `qpn` | `{}` **works** | `{sessions:[…]}` | none (read) | none |
| `session/read` | `Vpn` | `{sessionId, …}` | session snapshot | none | session exists |
| `session/messages` | `Wpn` | `{sessionId, …}` | messages | none | — |
| `session/events` | `Hpn` | `{sessionId, …}` | session events | none | — |
| `session/subscribe` | `Zpn` | `{sessionId, …}` | subscribe ack | registers live delivery | — |
| `session/send` | `Kpn` | `{sessionId, …}` + compat `browserAmbientContext, automationId, offPeakTaskId, offPeakRunType, botDeliveryTarget, toolDenylist` | ack | **starts a turn** | session exists |
| `session/stop` | `Xpn` | `{sessionId, …}` | ack | cancels turn. **Bypasses the serial processing queue** | — |
| `session/cancelBackgroundTask` | `emn` | `{sessionId, taskId}` | ack | cancels a background job | — |
| `session/fork` | `Qpn` | `{sessionId, checkpointId?}` | new session | forks | checkpoint |
| `session/compact` | `Jpn` | `{sessionId, instructions?, runtimeModel?}` | ack | compacts history | — |
| `session/goal` | `Ypn` | `{sessionId, action, objective?}` | goal | mutates goal | — |
| `session/close` | `amn` | `{sessionId}` | ack | closes, releases runtime | — |
| `session/setModel` | `tmn` | `{sessionId, model}` | ack | changes model | — |
| `session/setThoughtLevel` | `rmn` | `{sessionId, thoughtLevel}` | ack | changes reasoning effort | — |
| `session/updateRuntimeModelConfig` | `omn` | `{sessionId, …}` | ack | updates runtime model config | — |
| `session/setMode` | `imn` | `{sessionId, mode}` | ack | changes permission mode | — |
| `session/subagents` | `c3e` | `{sessionId}` | subagent list | none | — |
| `session/usage` | `Bwt(context,params)` | `{sessionId, range?}` | usage | none | — |
| `session/requestRuntimePreferences` | *(agent→client request)* | `{scope, sessionId, …}` | `{askUserQuestionAutoResolutionEnabled, nativeSearchEnhancementsEnabled, memoryEnabled}` | none | host must respond |

### 1.2 Requests — `workspace/*`

| Method | Handler | Args | Returns | Notes |
|---|---|---|---|---|
| `workspace/readState` | `Fdn` | `{workspace}` | full UI state (see API catalog §1.3) | read-only; **best "get status" call** |
| `workspace/hooks/trustGrant` | inline | `{workspace, …}` | `{accepted}` | grants hook trust |
| `workspace/updateProviderRegistry` | `zdn` | `{workspace, registry, includeWorkspaceState}` | `{appliedProviderRevision, providerCount, status}` | revision-ordered |
| `workspace/updateInteractionPreferences` | `Gmn` | `{workspace, preferences:{askUserQuestionAutoResolutionEnabled}}` | ack | |
| `workspace/updateModelIoPreferences` | `Hmn` | `{workspace, preferences:{fullRetentionEnabled}}` | ack | |
| `workspace/upsertModelProvider` | `Udn` | provider object | ack | |
| `workspace/removeModelProvider` | `$dn` | `{providerId}` | ack | |
| `workspace/setDefaultModel` | `qdn` | `{workspace, model}` | ack | |
| `workspace/setDefaultThoughtLevel` | `Vdn` | `{workspace, thoughtLevel}` | ack | |
| `workspace/setDefaultMode` | `Gdn` | `{workspace, mode}` | ack | |
| `workspace/generateText` | `smn(context,params,signal)` | `{…}` | generated text | **cancellable** via signal |
| `workspace/cancelGenerateText` | `cancelWorkspaceGenerateText` | `{…}` | ack | |

### 1.3 Requests — `v4/*`

| Method | Handler | Args | Returns |
|---|---|---|---|
| `v4/connection/flow` | `setConnectionFlowState` | `{connectionId, state:"saturated"\|"drained"\|"closed"}` | `{}` |
| `v4/controller/subscribe` | — | `{connectionId, clientMode, workspace?, legacyTaskIds?[≤200], resumeThoughtLevel?}` | ack |
| `v4/controller/resync` | — | — | ack |
| `v4/controller/unsubscribe` | — | — | ack |
| `v4/conversation/subscribe` | `subscribeReserved` / `subscribeSessionsIndexReserved` / `subscribeWorkspaceConfigReserved` | `{topic, subscriptionId, connectionId, base:{logEpoch,seq}\|null, forceSnapshot?}` | `{ack}` **then** `v4/conversation/frame` batch, then `commit` |
| `v4/conversation/resync` | `resyncReserved` | as subscribe + `base` | same as subscribe |
| `v4/conversation/unsubscribe` | `unsubscribe` | `{topic, subscriptionId, connectionId}` | `{}` |
| `v4/conversation/rowsRange` | `rowsRange` | `{sessionId, beforeRowId?, limit≤200, baseLogEpoch, baseRevision, clientMode}` | rows |
| `v4/conversation/plans` | `plans` | `{sessionId, target?, baseLogEpoch, baseRevision}` | plans |
| `v4/conversation/fileChanges` | `fileChanges` | `{sessionId, target:{rowId}, baseLogEpoch, baseRevision}` | file changes for the turn |
| `v4/conversation/fileRewindPreview` | `fileRewindPreview` | same | rewind preview |
| `v4/conversation/usage` | `Bwt` | `{…}` | usage |
| `v4/attachment/begin` | `attachmentBegin` | `{sessionId, …}` | upload handle |
| `v4/attachment/chunk` | `attachmentChunk` | `{…}` | ack (≤512 KiB/chunk, ≤64 chunks) |
| `v4/attachment/commit` | `attachmentCommit` | `{…}` | committed ref |
| `v4/attachment/abort` | `attachmentAbort` | `{…}` | `{}` |
| `v4/attachment/read` | `attachmentRead` | `{sessionId, ref, mime, maxBytes, messageId?, attachmentIndex?}` | payload |
| `v4/attachment/previewSource` | `attachmentPreviewSource` | `{…}` | preview ref |
| `v4/commands/query` | `queryCommands` | `{commands:[≥1 × {sessionId: string\|null, …}]}` | `{results:[…]}` |
| `v4/command` | `handleCommand` | envelope (see below) | `{status, result?, reasonCode?, message?}` |
| `v4/usage/stats` | `Dwt` | `{range:"all"\|"7d"\|"30d"}` | analytics |

**`v4/command` — the universal command surface.**
```ts
params = { commandId: string, sessionId: string | null,
           type: "createSession" | "sendText" | "sendGoalCommand" | "compact",
           payload: {…}, trace?: … }
result = { status: "accepted", result?: any }
       | { status: "noop",   reasonCode: string }
       | { status: "failed", reasonCode: "fault.command.notImplemented"
                                     | "fault.command.executionFailed"
                                     | "proto.payloadTooLarge", message: string }
```
Admission: synthesise the queue item, measure the projected size against
`logicalFrameAssemblyMaxBytes` (16 MiB) → reject with `proto.payloadTooLarge`; else call
`host.admitCommandInput(envelope, {admissionSeq, admittedAt, queueItemId})`, then
`host.executeCommand(envelope, ctx)`. On `g1` (noop) the durable input is cancelled with the
reason code and `status:"noop"` returned.

### 1.4 Requests — `plugins/*` (18) and `automation/*` (5)
See `ZCODE_API_CATALOG.md` §1.2.5 and §1.2.6.

### 1.5 Notifications (agent → client)
| Method | Params |
|---|---|
| `process/resourceSample` | resource sample |
| `process/mcpTelemetry` | `{arch, kind, mcpId, mcpInstanceId, mcpIsolation, mcpSource, occurredAt, platform}` |
| `plugins/operationProgress` | `{operationId, …}` |
| `computer-use/operation-event` | CUA operation event |
| `session/event` | see §1.6 |
| `state.updated` | session or workspace scoped notification |
| `v4/conversation/frame` | `{topic, …}` — topics `sessions-index/…`, `workspace-config/…`, else conversation |
| `v4/telemetry/event` | conversation telemetry fact |
| `v4/cua/permission-observation` | `{…, workspacePath, workspaceIdentity?}` |

### 1.6 `session/event` type registry (25 types) ★
```js
["session.created","session.resumed","session.updated","session.titleUpdated","session.closed",
 "turn.started","turn.steerQueued","turn.steerDrained","turn.completed","turn.failed",
 "message.upserted","message.removed",
 "part.started","part.delta","part.upserted","part.removed",
 "model.streaming","tool.updated",
 "permission.requested","permission.resolved",
 "userInput.requested","userInput.resolved",
 "checkpoint.created","rewind.triggered","streamRecovery.updated"]
```
Envelope: `{eventId, sessionId, turnId?, seq, traceId?, timestamp, deliveryKind?, type, payload}`.
`seq` is assigned host-side by `normalizeSessionEventSeq` (monotonic, de-duplicated by `eventId`).

**`model.streaming` payload** — `{kind, delta?, inputId?, assistantMessageId?, toolCallId?,
parentToolUseId?, parentToolCallId?, partId?, toolName?, providerExecuted?, done?, input?}` where
`kind ∈ {start, finish, error, text_start, text_delta, text_end, reasoning_start, reasoning_delta,
reasoning_end, tool_input_start, tool_input_delta, tool_input_end, tool_call}`.

**`state.updated` / `session/projection`** — the live session state object:
```ts
{ sessionId, status: idle|running|waiting|paused|completed|error, mode,
  turnCount, totalTokenCount, contextUsed, contextWindow, currentTurnId?,
  pendingPermissions: [{…}],
  activeToolCalls: [{toolCallId, toolName, status: pending|running|completed|failed|denied, startedAt?}],
  backgroundJobs: [ … ],
  target?: goal | null,
  lastError?: {type, code?, message, detail?, attribution?} }
```

### 1.7 Internal event sequence (`kind`-tagged, agent-side)
A second, finer-grained stream exists using a `kind` discriminator — these are the durable
persisted events:
```
turn-started | turn-completed | turn-failed | tool-scheduled | tool-started | session-closed
```
Envelope: `{eventId, sequenceNumber, sessionId, timestamp, kind, turnId?, toolCallId?, toolName?}`.

### 1.8 Turn phases (observable in logs)
`turn.phase.started` / `turn.phase.completed` with `context.phase`:
`context_initialization`, `session_start_hooks`, … (further phases exist; see
`ZCODE_UNKNOWNS.md` U-6).
Log events per turn: `turn.started`, `model.request.started|completed|failed`,
`model.network.completed|failed`, `model.sdk.stream.completed|failed`, `model.retry.delay.resolved`,
`model.response.diagnostics`, `session.event.persistence.started|completed`,
`tool.call.started|completed|failed`, `background_task.tracking.started|terminal`,
`turn.completed|failed`.

---

## 2. Host RPC registry

### 2.1 Requests (renderer/client → host)
| Name | Semantics |
|---|---|
| `workspace.list` | enumerate workspaces |
| `workspace.set` | activate/switch workspace |
| `task.list` | enumerate tasks |
| `task.set` | set active task |
| `session.event` | inject/forward a session event |
| `model.list` | list models in the registry |
| `model.set` | choose model |
| `model.provider.set` | choose provider |
| `model.streaming` | streaming model output carrier |
| `mode.list` / `mode.set` | permission mode |
| `thoughtLevel.list` / `thoughtLevel.set` | reasoning effort |
| `reply.list` / `reply.set` | reply granularity/verbosity |
| `permission.request` / `permission.respond` | approval round-trip |
| `elicitation.submit` / `elicitation.respond` | structured question round-trip |
| `selection.cancel` | cancel current selection/UI focus (also `"0"` in bot input) |
| `userInput.request` / `userInput.response` | free-form user input round-trip |
| `mcp.servers` | MCP server inventory |

### 2.2 Events (host → client)
`workspace.upserted`, `workspace.removed`, `task.upserted`, `task.removed`, `session.updated`,
`session.upserted`, `state.updated`, `tool.updated`, `turn.started`, `turn.completed`,
`turn.failed`, `turn.steerQueued`, `turn.steerDrained`, `permission.requested`,
`permission.resolved`, `elicitation.submit`, `elicitation.respond`, `userInput.request`,
`phase.completed`, `phase.error`, `streamRecovery.updated`, `meta.mode`, `meta.model`,
`meta.provider`, `meta.titleUpdated`.

---

## 3. Agent tool registry ★

**Two lists exist.** Both are verbatim from `zcode.cjs`.

### 3.1 Internal tool set (`mCn`) — dispatch names
```
Read  Write  Edit  ApplyPatch  Bash  Glob  Grep  WebFetch  WebSearch  web_search
TodoRead  TodoWrite  GoalRead  ReadSessionContext  AskUserQuestion  SendMessage
RespondToCoordinator  TaskOutput  TaskStop
js  js_reset  js_add_node_module_dir
mcp__node_repl__js  mcp__node_repl__js_reset  mcp__node_repl__js_add_node_module_dir
Agent  Task  Skill
```
Lookup is case-insensitive (`KXi = new Map(mCn.map(e => [e.toLowerCase(), e]))`).
`isZCodeFileStreamingToolInputPreviewTool` treats `write`/`edit` specially for streaming preview.

### 3.2 Provider-visible tool contracts (`eli`) — what the model sees
`orderProviderVisibleToolContracts` puts members of this set first (alphabetically), then the rest
alphabetically:
```
Agent  AskUserQuestion  Bash  CronCreate  CronDelete  CronList  CronUpdate  Edit
EnterPlanMode  EnterWorktree  ExitPlanMode  ExitWorktree  Glob  Grep  LSP  NotebookEdit  Read
ScheduleWakeup  Skill  TaskCreate  TaskGet  TaskList  TaskOutput  TaskStop  TaskUpdate
TodoRead  TodoWrite  WebFetch  WebSearch  Workflow  Write
```
**ZCode-specific additions over the Claude-Code-like baseline:** `ApplyPatch`, `GoalRead`,
`ReadSessionContext`, `RespondToCoordinator`, `SendMessage`, `Cron*` (4), `ScheduleWakeup`,
`Workflow`, `LSP`, `NotebookEdit`, `EnterWorktree`/`ExitWorktree`, `TaskCreate/Get/List/Update`,
`js`/`js_reset`/`js_add_node_module_dir` (QuickJS WASM sandbox).

Notable tool semantics:
- `Bash` — shell execution with process-tree ownership and background job tracking.
- `Read` / `Write` / `Edit` — file ops; `Edit` streams a diff preview to the UI
  (`isZCodeFileStreamingToolInputPreviewTool`).
- `Agent` / `Task` — spawn subagents (child sessions with `sessionKind: subagent_child`);
  `TaskOutput` / `TaskStop` manage them.
- `SendMessage` / `RespondToCoordinator` — inter-agent messaging.
- `Skill` — load a skill by name (skills come from plugins).
- `js` — execute JavaScript in an embedded **QuickJS** (`quickjs.wasm`, `qjs_*` host API).
- `web_search` (snake_case) and `WebSearch` both exist; and MCP servers contribute
  `mcp__<server>__<tool>` names.
- `Cron*` and `ScheduleWakeup` overlap with the host's automation subsystem.
- `EnterPlanMode`/`ExitPlanMode` — plan mode transitions (matches mode `plan`).
- `EnterWorktree`/`ExitWorktree` — git worktree isolation.

Tool call log fields: `{toolCallId, toolName, durationMs, status, iteration, model, querySource}`.

---

## 4. Bot command language (host-side parser) ★

Function `parseBotCommand` in `out/host/index.js` converts chat text into typed commands. This is a
**published, stable, semantic command language** — very useful because it is text-based and
therefore trivially driveable from outside.

```js
v0e = ["status","new","workspace","model","mode","thoughtLevel","reply"]
TS  = ["help", ...v0e, "bind"]
```

| Input | Parsed command |
|---|---|
| *(no `/`)* | `{type:"message", text}` — except bare `"0"` → `{type:"selection.cancel"}` |
| `/help` `/帮助` | `{type:"help"}` |
| `/cancel` `/取消` | `{type:"selection.cancel"}` |
| `/status` `/状态` | `{type:"status"}` |
| `/new` `/clear` `/新建` | `{type:"new"}` |
| `/reconnect` `/重连` | `{type:"reconnect"}` |
| `/workspace` `/project` `/项目` | `{type:"workspace.list"}` |
| `/workspace <path>` | `{type:"workspace.set", value}` |
| `/model` `/模型` | `{type:"model.list"}` |
| `/model <id>` | `{type:"model.set", value}` |
| `/model provider <p>` | `{type:"model.provider.set", value}` |
| `/model model <m>` | `{type:"model.set", value:m}` |
| `/mode` `/模式` | `{type:"mode.list"}` |
| `/mode <m>` | `{type:"mode.set", value}` |
| `/thoughtLevel` `/thought_level` `/thought-level` `/think` `/思考` | `{type:"thoughtLevel.list"}` |
| `/thoughtLevel <v>` | `{type:"thoughtLevel.set", value}` |
| `/task` | `{type:"task.list"}` |
| `/task <id>` | `{type:"task.set", value}` |
| `/reply` `/回复` | `{type:"reply.list"}` |
| `/reply <v>` | `{type:"reply.set", value}` |
| `/stop` `/停止` | `{type:"stop"}` |
| `/permission <opt>` | `{type:"permission.respond", value}` |
| `/elicitation submit\|done\|完成\|提交` | `{type:"elicitation.submit"}` |
| `/elicitation <answer>` `/answer <answer>` `/回答 <answer>` | `{type:"elicitation.respond", value}` |
| `/approve <requestId> <optionId>` | `{type:"approve", requestId, optionId}` |
| `/deny <requestId>` | `{type:"deny", requestId}` |
| `/bind <code>` | `{type:"bind", code}` |
| unknown | `{type:"unknown", name, raw}` |

The command set is **bilingual (en/zh-CN)** and the parser is tolerant of whitespace.
`normalizeBotCommandPolicy`, `normalizeBotCurrentOptions`, `normalizeBotReplyGranularity`
normalise bot options; `buildBotCredentialKey` / `buildBotWebhookSecretKey` derive secret keys
from a bot id.

Bot integration channels observed: Feishu (webhook + WebSocket long-polling), Telegram long-polling,
WeChat long-polling — statuses `bots.runtime.{feishuWebSocket,telegramLongPolling,
weixinLongPolling}{Starting,Running,Stopped}`, `bots.runtime.telegramTokenMissing`,
`bots.runtime.telegramPollingFailedRetrying`, `bots.runtime.telegramLongPollingHandledElsewhere`,
`bots.runtime.botDisabled`. Protocol methods `zcode.bot.test`, `zcode.bot.message`.
Bot state: `~/.zcode/v2/bot-state.v2.json` (`{"version":2,"bots":{}}`).

---

## 5. CLI slash commands

`/help [command]`, `/login`, `/logout`, `/compact [instructions]`,
`/expert [status|resume|stop|<task>]`, `/fork [latest|checkpointId]`,
`/mcp [list|status|connect|disconnect]`, `/mode [mode]`, `/model [id]`, `/new`,
`/resume [sessionId]`, `/rewind [latest|checkpointId]`, `/skill [name] [task]`, `/goal [action]`.
Plus TUI-only: `commands list`, `skills list`, `plugins list`.

Renderer-side slash commands (from `workspace/readState.slashCommands`): `goal`, `compact`,
`init` ("Create or update workspace AGENTS.md instructions"), `plan` ("Switch to Plan mode and
optionally send a task"), with `source: "builtin" | "custom"`.

---

## 6. Plugin / MCP command registry

- `v4/commands/query` resolves commands by `{sessionId, …}` → results from `inbox.query`.
- Plugin components of `kind: "command"` become user-invocable commands
  (e.g. plugin `android-emulator` exposes command `android-dev`).
- Custom slash commands are listed by the CLI `commands list`.
- MCP servers contribute tools named `mcp__<server>__<tool>`.

---

## 7. Command suitability for MCP tools

| Protocol method | MCP tool | Rating | Reason |
|---|---|---|---|
| `session/list` | `zcode.session.list` | **A** | works with `{}`, read-only, structured |
| `session/read` / `messages` / `events` | `zcode.session.get` | **A** | read-only |
| `session/create` | `zcode.session.create` | **A** | explicit, validated |
| `v4/command` (`sendText`) | `zcode.agent.chat` | **A** | the sanctioned prompt path |
| `v4/commands/query` | `zcode.command.query` | **A** | read-only command resolution |
| `session/stop` | `zcode.agent.cancel` | **A** | queue-bypassing by design |
| `session/setMode` / `setModel` / `setThoughtLevel` | settings tools | **A** | narrow, validated |
| `workspace/readState` | `zcode.status` | **A** | rich status, read-only |
| `usage/stats` | `zcode.usage` | **A** | read-only analytics |
| `plugins/list` | `zcode.extension.list` | **A** | read-only |
| `mcp/list` | `zcode.mcp.list` | **A** | read-only |
| `automation/*` | `zcode.automation.*` | **A** | CRUD, capped at 20 |
| `v4/conversation/subscribe` + `frame` notifications | streaming | **B** | needs long-lived connection |
| `v4/conversation/fileChanges` / `fileRewindPreview` | `zcode.diff.*` | **B** | needs `baseLogEpoch`/`baseRevision` |
| `session/fork` / `compact` / `goal` | `zcode.session.*` | **B** | mutating but bounded |
| `interaction/*` | approval bridge | **B** | requires being the attached client |
| host RPC dotted names | — | **D** | MessagePort only, no external reach |
| shell `zcode:*` IPC | — | **E** | in-process only |
| SQLite/config files | `zcode.settings.*` | **B** | file-based, restart-dependent |
