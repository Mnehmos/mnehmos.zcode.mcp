# ZCODE_STATE_MODEL.md

How ZCode represents application state: the objects, their owners, their mutation paths, and their
persistence.

**Central fact:** ZCode has a **split state model with three authorities**, and they are not
replicas of one another.

| Authority | Owns | Persistence |
|---|---|---|
| **Agent runtime** | sessions, turns, messages, parts, todos, goals, queue, automations, usage, checkpoints | `~/.zcode/cli/db/db.sqlite` + rollout JSONL |
| **Desktop/host** | workspaces, tasks, provider registry, UI settings, credentials, plugin enablement, bot state | `~/.zcode/v2/*.json`, `tasks-index.sqlite` |
| **Renderer** | transient UI state only (tabs, panels, scroll, drafts, open editors) | Electron `session/` profile |

There is **no shared document model**. File text is not a first-class object anywhere in the
protocol; it exists only inside agent tool operations and the conversation's file-change records.

---

## 1. Core objects

### 1.1 WorkspaceRef (`zt` / `Yo`) — the addressing primitive ★
```ts
{ workspacePath: string,        // absolute native path, e.g. "F:\\projects\\example"
  workspaceIdentity?: string,   // present for remote/special workspaces
  remoteSessionId?: string,     // present for remote
  workspaceKey: string }        // the canonical key
```
`buildWorkspaceRef(entity)` produces exactly these four fields.
Observed `workspaceKey` values are the path itself (`F:\\Github`, `F:\\ComfyUI`), and a
placeholder workspace exists at `C:\Users\<u>\.zcode\workspace\default`.
`workspacePurpose: "project" | …` appears in `setting.json.lastWorkspaceSession`.

**✅ The derivation rule is CONFIRMED** (resolved from source, superseding the earlier "opaque" note):

```js
// out_host_chunk-BG4MS6RN.js @47323  — exported as "workspaceKey"
function workspaceKey(r) { return r.workspaceIdentity?.trim() || r.workspacePath; }
// out_host_index.js @1393702 — "getWorkspaceKey", identical
function getWorkspaceKey(path, identity) { return identity?.trim() || path; }
```
with a zod refinement enforcing it: *"workspaceKey must match workspaceIdentity fallback rule"*.

So **`workspace_key = workspace_identity.trim() || workspace_path`**. `workspace_identity` is supplied
for remote/bridged workspaces (required together with `remoteSessionId` for bridges) and otherwise
omitted, which is why key == path on a local machine.

Two further derived identifiers:

| Derived value | Rule | Where it is used |
|---|---|---|
| workspace hash | `sha256(getWorkspaceKey(path, identity)).hex.slice(0,12)` | `~/.zcode/v2/sessions/<hash12>`, `~/.zcode/v2/agent-config/<provider>/<hash12>` |
| session `project_id` | `proj_<lowercased path, - and _>` e.g. `proj_example` | the agent DB's `session.project_id` |

**Overrides**: the data root is `process.env.ZCODE_DATA_BASE_DIR` → `~/.zcode`; the session DB path is
the config key `storage.sessionDbPath` (default `~/.zcode/cli/db/db.sqlite`).

> **Rule for the MCP (unchanged in spirit, now with a known rule):** obtain `workspaceKey` from ZCode
> — via `session/list`, `workspace/readState`, or a `session/create` echo — and use that key for the
> runtime registry. The derivation is now known, but recomputing it would still be wrong: identity
> handling and remote bridges are edge cases the server has no reason to own.

### 1.2 Session
```ts
{ sessionId: "sess_<uuid>",
  sessionKind: "interactive" | "fork" | "selection_side_chat" | "workflow_parent"
             | "workflow_child" | "subagent_child" | "nested_workflow_child",
  status: "idle" | "running" | "waiting" | "paused" | "completed" | "error",
  mode: "plan" | "build" | "edit" | "yolo" | "auto",
  title: string,
  titleSource: "generated" | "custom" | "first_input" | "default",
  createdAt: epochMs, updatedAt: epochMs, traceId: uuid,
  workspace: { workspaceKey, workspacePath },
  parentSessionId?: string,
  model?, runtimeModel?, persistence?, thoughtLevel?, titleGenerationEnabled?,
  mcpServers?, toolAllowlist?, toolDenylist?, importedHistory? }
```
Created by `session/create`; enumerated by `session/list` (**works with no params**);
detailed by `session/read`.

### 1.3 Session projection (`q1n`) — the live state object ★
This is the object an MCP should read to answer "what is the agent doing right now".
```ts
{ sessionId, status, mode,
  turnCount: int, totalTokenCount: int, contextUsed: int, contextWindow: int,
  currentTurnId?, 
  pendingPermissions: [{…}],
  activeToolCalls: [{ toolCallId, toolName,
                      status: "pending"|"running"|"completed"|"failed"|"denied",
                      startedAt? }],
  backgroundJobs: [ … ],
  target?: Goal | null,
  lastError?: { type, code?, message, detail?, attribution? } }
```

### 1.4 Session snapshot (`pce`) — the full read model
```ts
{ protocol: { name: "ZCode Protocol", version: 1 },
  session, settings, projection, runtime,
  messages: [ … ],
  goalStats?, todos?, todoGroups?, slashCommands? }
```

### 1.5 Turn
```ts
{ turnNumber: int,
  input: string,
  inputId?, queryId?, inputSource?, inputVisibility?,
  executionKind: "agent" | "controlOnly",
  targetId?, messageId?, foregroundExecutionId?,
  intent?, originMeta?, attachments? }
```
Live sample: `turnNumber: 87`, `queryId: "01a08f2d-6161-7b2f-ad33-98b21342a6d6"`,
and for automations `queryId: "automation-f977de5d-…:1788937186947"`.

### 1.6 Message / Part
Messages carry an `assistantMessageId` / `messageID`. Content is decomposed into **parts**
(events `part.started`, `part.delta`, `part.upserted`, `part.removed`) — the same part model used
by the streaming kinds (`text_*`, `reasoning_*`, `tool_input_*`, `tool_call`).

### 1.7 Conversation row (addressable conversation unit)
Conversation reads are **row-addressed**, not message-addressed:
`rowsRange` returns a window of rows (`snapshotTailWindowRows: 60`, `rowsRangeMaxLimit: 200`).
Row kinds include `userInput` and `assistantText` (CONFIRMED from `findPreviewableAttachment`,
which scans `rows.window` for `kind === "userInput"` with `attachments[]`, and `assistantText`
with image references). Row identity:
```ts
{ rowId, entityId, turnId, kind }
```
`v4/conversation/fileChanges` and `fileRewindPreview` take `target: {rowId}` plus
`baseLogEpoch` + `baseRevision` — i.e. **read-modify-write against a versioned log**.

### 1.8 Goal (`$Be`)
```ts
{ sessionId, targetId, objective, summaryTitle: string|null,
  status: "active" | "paused" | "budget_limited" | "complete",
  tokenBudget: int|null, tokensUsed: int, timeUsedSeconds: int,
  activeInputId?: string|null,
  activeRunStartedAtMs?, activeRunLastSeenAtMs?,
  createdAt, updatedAt }
```

### 1.9 Queue item (`gP`)
The admission record for every user input — see `ZCODE_COMMAND_CATALOG.md` §1.3.
```ts
{ sourceCommandId, queueItemId, clientId, kind: "sendText"|"sendGoalCommand"|"compact",
  text, attachments:[{ref,fileName,mime,bytes,previewRef?}],
  delivery:{requested, admitted, fallbackReasonCode?},
  order:{admissionSeq, queuePosition?},
  steer:{state, reasonCode?},
  dispatch:{state, reservationId?} }
```
Host helpers: `getQueueItem`, `hasQueueItemKind`, `hasQueuedDelivery`, `getQueueLength`,
`hasResidencyBlockingCommands`, `getQueueHead`.
`pendingCommandsDisplayMax: 32`, `commandPendingTtlMs: 24 h`, `idempotencyTablePerSession: 512`
→ **inputs are idempotent and TTL'd**, which makes retry-safe MCP calls possible.

### 1.10 Attachment
```ts
{ ref: string, fileName: string, mime: string, bytes: int, previewRef?: string }
```
Staged with `v4/attachment/begin → chunk → commit` (≤512 KiB/chunk, ≤64 chunks, ≤64 MiB staged,
5 min TTL, ≤16 concurrent uploads); read with `v4/attachment/read`
(`maxBytes` ≤ 30 MiB preview cap); unreferenced attachments expire after 24 h.

### 1.11 Checkpoint / Rewind
`checkpoint.created` and `rewind.triggered` session events; `session/fork {checkpointId}` and
`/rewind [latest|checkpointId]` surface them. Rewind *preview* is
`v4/conversation/fileRewindPreview` — a dry run of what files would be restored.

### 1.12 Tool call
```ts
{ toolCallId, toolName,
  status: "pending"|"running"|"completed"|"failed"|"denied",
  startedAt?, durationMs?, input?, iteration?, turnId? }
```
Streaming input preview is special-cased for `Write`/`Edit`
(`resolveZCodeToolProjectionMetadata`, `finalizeZCodeToolProjectionInput`).

### 1.13 Automation
SQLite-backed `{automation_id, title, cron_expr, prompt, model, provider, mode, thought_level,
workspace_key, workspace_path, workspace_identity, target_task_id, location_kind}`; ≤20.

---

## 2. Desktop-side objects

### 2.1 Task
`task.list` / `task.set` / `task.upserted` / `task.removed`; persisted in
`~/.zcode/v2/tasks-index.sqlite`. A task links to sessions, can be archived
(`taskAutoArchiveEnabled`, `taskAutoArchiveOlderThanDays: 7`), and can be bound to an automation
(`syncTaskMeta({cronAutomationId})`).
`task.set` selects the "active task"; `SyncActiveTaskSession` propagates it to the shell.

### 2.2 Settings (`~/.zcode/v2/setting.json`, CONFIRMED full key list)
```jsonc
{ "recentProjects": string[],
  "locale": "en-US", "localePreference": "system",
  "terminalInheritSystemProfile": true,
  "embeddedBrowserAllowInsecureCertificates": false,
  "embeddedBrowserViewportPreference": {"mode":"normal","viewport":{"width":393,"height":852},"zoom":"fit"},
  "computerUseComposerEntryHidden": false,
  "taskAutoArchiveEnabled": false, "taskAutoArchiveOlderThanDays": 7,
  "closeToTrayOnWindows": true, "closeToTrayOnWindowsMigrationInitialized": true,
  "keepAwakeWhileRunning": false,
  "desktopWindowSize": {"width":1920,"height":1040,"maximized":true},
  "desktopChromiumHardwareAccelerationEnabled": true,
  "messageStreamShowReasoning": true, "messageStreamShowReasoningMigrationInitialized": true,
  "messageStreamShowTodos": false,
  "toolGroupingExploreEnabled": true, "toolGroupingTerminalEnabled": true,
  "toolGroupingChangesEnabled": false,
  "zcodeInteractionBehavior": "queue",
  "askUserQuestionAutoResolutionEnabled": true,
  "modelIoFullRetentionEnabled": false,
  "optimizeAgentExperienceEnabled": false, "optimizeAgentExperienceMigrationInitialized": true,
  "enabledBuiltinAgentCliProviders": ["glm"],
  "modelProviderFamilyModes": {"zai":"oauth"},
  "modelProviderFamilySelectedKeys": {"zai":"coding-plan:builtin:zai-coding-plan"},
  "providerFamilyDomain": "zai", "providerFamilyDomainUpdatedAt": 1788449671131,
  "providerFamilyDomainMigrated": true,
  "repoSnapshotIndexingEnabled": false, "instantGrepIndexingEnabled": false,
  "nativeSearchEnhancementsEnabled": true, "memoryEnabled": false,
  "lastWorkspaceSession": [{"kind":"local","workspacePath":"…","workspacePurpose":"project"}] }
```
Two of these are pushed to the agent as **interaction preferences**
(`askUserQuestionAutoResolutionEnabled`) and **model-I/O preferences**
(`modelIoFullRetentionEnabled` → `fullRetentionEnabled`) via dedicated protocol methods —
i.e. **some desktop settings are mirrored into the agent's own state.**

### 2.3 Provider registry (`~/.zcode/v2/config.json`)
See `ZCODE_AGENT_ARCHITECTURE.md` §2.1. Authoritative in the desktop; pushed to agents.

### 2.4 Credentials (`~/.zcode/v2/credentials.json`)
Keys: `oauth:zai:access_token`, `oauth:zai:user_info`, `oauth:active_provider`, `zcodejwttoken`.
Values were **not** printed (redacted). Node-forge is a dependency → likely encrypted at rest or
used for OAuth PKCE/signature work. **HYPOTHESIS:** at least some values are protected via Electron
`safeStorage` (DPAPI on Windows); unverified — see `ZCODE_UNKNOWNS.md` U-4.

### 2.5 Bot state (`~/.zcode/v2/bot-state.v2.json`) — `{"version":2,"bots":{}}`
Per-bot configuration/credentials for Feishu / Telegram / WeChat integrations.

### 2.6 Plugin enablement (`~/.zcode/cli/config.json`)
```json
{ "mcp": { "servers": { "<name>": { "command": "...", "args": [...], "env": {...} } } },
  "plugins": { "enabledPlugins": { "<plugin>@<marketplace>": true|false } } }
```

---

## 3. Mutation and observation map

| Mutation | Trigger | Event(s) emitted | Persisted to |
|---|---|---|---|
| session created | `session/create`, `v4/command{createSession}` | `session.created`, `session.upserted` | agent DB |
| session resumed | `session/resume` | `session.resumed` | agent DB |
| session title changed | model title generation or user rename | `session.titleUpdated`, `meta.titleUpdated` | agent DB |
| turn started | `session/send` / `v4/command{sendText}` | `turn.started` | agent DB |
| model streaming | model call | `model.streaming` (coalesced) | agent DB (per-event persistence) |
| message/part changed | model output | `message.upserted`, `part.started/delta/upserted/removed` | agent DB |
| tool status changed | tool executor | `tool.updated` | agent DB |
| approval needed | permission gate | `permission.requested` | — |
| approval decided | client responds | `permission.resolved` | agent DB (rules may persist) |
| user input needed | `AskUserQuestion` | `userInput.requested` | — |
| user answered | client responds | `userInput.resolved` | agent DB |
| turn finished | runtime | `turn.completed` / `turn.failed` | agent DB |
| steering changed | new input during a turn | `turn.steerQueued`, `turn.steerDrained` | agent DB |
| checkpoint | file-modifying turn | `checkpoint.created` | agent DB + FS |
| rewind accepted | user action | `rewind.triggered` | FS |
| stream recovered | retry after failure | `streamRecovery.updated` | agent DB |
| session closed | `session/close` | `session.closed` | agent DB |
| workspace created/removed | host | `workspace.upserted` / `workspace.removed` | desktop |
| task created/removed | host | `task.upserted` / `task.removed` | `tasks-index.sqlite` |
| settings changed | UI | `settings-changed`, `state.updated`, `meta.*` | `setting.json` |
| provider registry changed | UI/OAuth | `model.provider_endpoint_routing.snapshot_updated` | `config.json` + agent push |
| plugin op | `plugins/*` | `plugins/operationProgress` | plugin tree |
| MCP server connected | pool | `mcp.server.connected`, `mcp.tools.registered` | — |
| automation fired | scheduler | `turn.started` with `queryId: automation-…` | agent DB |

**Observation contract for an MCP:**
- one-shot reads → `session/list`, `session/read`, `workspace/readState`, `usage/stats`,
  `v4/conversation/*`, `plugins/list`, `mcp/list`
- live updates → `v4/conversation/subscribe` (topic-based) or `session/subscribe`
- durable history → agent SQLite + `rollout/model-io-*.jsonl` + daily log JSONL

---

## 4. Versioning and consistency model

Two independent optimistic-concurrency tokens guard conversation reads:

| Token | Error on mismatch | Meaning |
|---|---|---|
| `baseLogEpoch` | `proto.staleLogEpoch` | log identity (changes on compaction/fork) |
| `baseRevision` | `proto.staleRevision` | monotonic revision of a topic's log |

Plus per-subscription ownership: a connection acting on a subscription it does not own receives
`fault.subscription.notOwned`.

**Practical rule for an MCP:** treat reads as *snapshot + token*; on
`proto.staleLogEpoch` / `proto.staleRevision`, re-read the current tokens before retrying.
Never cache row ids across a `logEpoch` change — compaction or fork invalidates them.

Session-event ordering is made safe by the host:
`normalizeSessionEventSeq` assigns a monotonic `seq`, de-duplicates by `eventId`
(retaining up to `eventRetentionPerSession: 2000` ids), and `shouldDeliverLiveSessionEvent`
prevents duplicate live delivery.

---

## 5. Conceptual state schema (for MCP consumers)

```
Workspace (workspaceKey)
 ├── ProviderRegistry   (desktop-owned, pushed to agent)
 ├── Tasks[]
 ├── Settings (desktop)          + InteractionPrefs / ModelIoPrefs (mirrored to agent)
 ├── Automations[]               (agent DB, scoped by workspace_key)
 └── Sessions[]
      ├── SessionMeta            (id, kind, status, mode, title, titleSource, timestamps)
      ├── Projection             (status, turnCount, tokens, context, activeTools, permissions, goal)
      ├── Settings               (model, runtimeModel, thoughtLevel, permission mode)
      ├── Queue[]                (pending inputs; idempotent, TTL 24 h)
      ├── Goal                   (objective, budget, status)
      ├── Todos[] / TodoGroups[]
      ├── Turns[]
      │    ├── Messages[] → Parts[]
      │    ├── ToolCalls[]
      │    ├── FileChanges[]      (per-row; versioned by logEpoch+revision)
      │    └── Checkpoints[]
      ├── Subagents[]  (child session refs)
      ├── Attachments[] (refs, staged, TTL'd)
      └── Subscriptions[] (topic, subscriptionId, connectionId, base{logEpoch,seq})
```

---

## 6. Safe-write rules for an external controller

1. **Never write `~/.zcode/cli/db/db.sqlite` or `tasks-index.sqlite` directly.** Both are live WAL
   databases owned by running processes. Read from a copied snapshot.
2. **Never invent a `workspaceKey`.** Obtain it from `session/list`, `workspace/readState`, or
   `session/create`'s echo. It is a join key.
3. **Prefer protocol mutations over file edits.** Config files are read at startup; protocol
   mutations take effect immediately.
4. **Respect `maxFrameBytes` (1 MiB).** Use `v4/attachment/*` for larger payloads.
5. **Never mutate `credentials.json`.** It may be DPAPI-encrypted and a bad write can lock the user
   out of their account. Use `login`/`logout` instead.
6. **Treat `logEpoch`/`revision` as opaque**; re-read on staleness rather than guessing.
7. **Plugin/MCP config lives in `~/.zcode/cli/config.json`** and is safe to read; write it only
   with a backup, and restart the agent runtime to apply.
