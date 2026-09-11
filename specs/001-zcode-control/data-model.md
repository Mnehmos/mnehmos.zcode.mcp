# Data Model: ZCode Programmatic Control Surface

**Phase 1 output** for `specs/001-zcode-control`.

This model has two halves: **external entities** (owned by ZCode; we read and address them, never
own them) and **internal entities** (owned by this server and persisted locally).

---

## Part A — External entities (owned by ZCode)

Addressing rule: entities are referenced only by identifiers ZCode gave us. We never synthesise a
`workspaceKey`, a `sessionId`, a `rowId`, a `logEpoch` or a `revision`.

### A1. WorkspaceRef — the addressing primitive

| Field | Type | Notes |
|---|---|---|
| `workspaceKey` | string | **The join key.** Every runtime, session, subscription and event map is keyed on it. Opaque; never re-derived. |
| `workspacePath` | string | Absolute native path. Observed equal to `workspaceKey` for local workspaces. |
| `workspaceIdentity` | string? | Present for remote/special workspaces. |
| `remoteSessionId` | string? | Present for remote workspaces. |

**Relationships**: owns 0..n Sessions; owns 0..n Automations; has 0..1 ModelProviderRegistry;
has 0..1 InteractionPreferences and 0..1 ModelIoPreferences.
**Lifecycle**: created/activated by the desktop; we observe it via session list, state read, or a
session-create echo.

### A2. Session

| Field | Type | Notes |
|---|---|---|
| `sessionId` | string | `sess_<uuid>` or `sess_subagent_agent_<uuid>` |
| `sessionKind` | enum | `interactive` \| `fork` \| `selection_side_chat` \| `workflow_parent` \| `workflow_child` \| `subagent_child` \| `nested_workflow_child` |
| `status` | enum | `idle` \| `running` \| `waiting` \| `paused` \| `completed` \| `error` |
| `mode` | enum | `plan` \| `build` \| `edit` \| `yolo` \| `auto` |
| `title` | string | |
| `titleSource` | enum | `generated` \| `custom` \| `first_input` \| `default` |
| `createdAt` / `updatedAt` | epoch ms | |
| `traceId` | uuid | |
| `workspace` | WorkspaceRef (key+path) | |
| `parentSessionId` | string? | set for fork/subagent/workflow children |
| `model` / `runtimeModel` | ModelRef? | |
| `thoughtLevel` | string? | provider-declared variant (`low`/`max`/`high` observed) |
| `persistence`, `titleGenerationEnabled`, `mcpServers`, `toolAllowlist`, `toolDenylist`, `importedHistory` | | session-create options, echoed back |

**Validation**: `sessionId` must belong to the requesting workspace. A session id from another
workspace is a failure, never a silent new session.
**Lifecycle**: create → resume/fork → (turns) → compact → close.

### A3. SessionProjection — the live read model

| Field | Type | Notes |
|---|---|---|
| `sessionId`, `status`, `mode` | | mirrors A2 |
| `turnCount` | int | |
| `totalTokenCount`, `contextUsed`, `contextWindow` | int | drives the context meter |
| `currentTurnId` | string? | |
| `pendingPermissions` | PermissionRequest[] | |
| `activeToolCalls` | ToolCall[] | |
| `backgroundJobs` | object[] | |
| `target` | Goal? | |
| `lastError` | `{type, code?, message, detail?, attribution?}`? | |

### A4. Turn

| Field | Type |
|---|---|
| `turnId` | string (`turn_<uuid>`) |
| `turnNumber` | int (observed up to 87) |
| `queryId` | string (`01a0…` ulid-like, or `automation-<uuid>:<epochMs>`) |
| `input` | string |
| `executionKind` | `agent` \| `controlOnly` |
| `inputSource`, `inputVisibility`, `targetId`, `messageId`, `intent`, `originMeta`, `attachments` | optional |

**Terminal outcomes** (the only thing that lets a chat tool report success): `turn.completed` or
`turn.failed`.

### A5. Message / Part

- Message: identified by `messageId` / `assistantMessageId`; ordered within a turn.
- Part: typed content unit. Streaming kinds: `start`, `finish`, `error`, `text_start`, `text_delta`,
  `text_end`, `reasoning_start`, `reasoning_delta`, `reasoning_end`, `tool_input_start`,
  `tool_input_delta`, `tool_input_end`, `tool_call`.
- Part lifecycle events: `part.started`, `part.delta`, `part.upserted`, `part.removed`.

### A6. QueueItem — the admission record

| Field | Type | Notes |
|---|---|---|
| `sourceCommandId`, `queueItemId`, `clientId` | string | |
| `kind` | `sendText` \| `sendGoalCommand` \| `compact` | |
| `text` | string | |
| `attachments` | `{ref, fileName, mime, bytes, previewRef?}[]` | |
| `delivery` | `{requested: auto\|startNow\|queue\|guide, admitted: startNow\|queue\|guide, fallbackReasonCode?}` | |
| `order` | `{admissionSeq: int≥0, queuePosition?: int≥0}` | |
| `steer` | `{state: notRequested\|submitting\|steering\|guided\|fellBack, reasonCode?}` | |
| `dispatch` | `{state: admitted\|queued\|reserved\|promoting\|drained, reservationId?}` | |

**Invariants**: idempotent under a stable `sourceCommandId` (`idempotencyTablePerSession: 512`),
pending lifetime 24 h (`commandPendingTtlMs`), display cap 32 (`pendingCommandsDisplayMax`).
**Contract with the chat tool**: a retry MUST reuse the same `commandId`, or it starts a second turn.

### A7. Goal

`{sessionId, targetId, objective, summaryTitle, status: active|paused|budget_limited|complete,
tokenBudget, tokensUsed, timeUsedSeconds, activeInputId?, activeRunStartedAtMs?,
activeRunLastSeenAtMs?, createdAt, updatedAt}` — `goalVerificationsRetained: 20`.

### A8. ToolCall

`{toolCallId, toolName, status: pending|running|completed|failed|denied, startedAt?, durationMs?,
iteration?, input?, turnId?}`. Tool names: `Read`, `Write`, `Edit`, `ApplyPatch`, `Bash`, `Glob`,
`Grep`, `WebFetch`, `WebSearch`, `TodoRead/Write`, `GoalRead`, `ReadSessionContext`,
`AskUserQuestion`, `SendMessage`, `RespondToCoordinator`, `TaskOutput`, `TaskStop`, `Agent`, `Task`,
`Skill`, `Cron*`, `ScheduleWakeup`, `Workflow`, `LSP`, `NotebookEdit`, `EnterPlanMode`/`ExitPlanMode`,
`EnterWorktree`/`ExitWorktree`, `TaskCreate/Get/List/Update`, `js`/`js_reset`/`js_add_node_module_dir`,
and `mcp__<server>__<tool>`.

### A9. PermissionRequest / Elicitation

`{sessionId, requestId, toolName?, …}`. Decision: `allow` \| `deny` \| `escalate` \| `modify`, with
optional `reason`, `modifiedInput`, and `permissionUpdates[{type:"addRules", behavior:
allow|deny|ask, rules:[{toolName, ruleContent?}]}]`.
**Invariant**: one owner per `(workspace, session, requestId)`; the request is emitted once and must be
answered exactly once.

### A10. Automation

`{automationId, title, cronExpr, prompt, model?, provider?, mode?, thoughtLevel?, workspaceKey,
workspacePath, workspaceIdentity?, targetTaskId?, locationKind: local|remote, recurring, maxRuns,
intervalUnit?, interval?}`. **Cap: 20 retained.** Creating the 21st fails with the runtime's own
`AutomationCreateLimitError`.

### A11. Plugin

`{id: "<name>@<marketplace>", name, description, version, enabled, source, marketplace, author,
skillCount, skillRootCount, commandRootCount,
components: [{kind: command|skill|mcp|hook, items: [{name, description}]}],
declaredMcpServerNames[], mcpServerNames[], hookDetails[], rootPath,
userConfig: Record<string, {type, default, description}>}`.

### A12. McpServerStatus

`{status: connected|failed, transport: stdio|http|sse, toolCount: int, updatedAt: iso,
error?: string, failureKind?: network_unreachable|process_start_failed, protocolEra?: string}`.
Keyed by bare server name, or `plugin:<pluginId>:<serverName>` for plugin-provided servers.
**Side effect**: obtaining this list starts the servers.

### A13. Attachment

`{ref, fileName, mime, bytes, previewRef?}`. Limits: 20 MiB max, 512 KiB per chunk, ≤64 chunks, ≤16
concurrent, 64 MiB staged, 5 min upload TTL, 24 h unreferenced TTL, 30 MiB read cap.

### A14. FileChange / RewindPreview

Addressable by `{sessionId, rowId}` and guarded by `{logEpoch, revision}`. Read-only preview; applying
a rewind is a session fork or an explicit confirmed action.

### A15. ConversationRow

`{rowId, entityId, turnId, kind}` where `kind` includes `userInput` and `assistantText`. Windowed
access: default tail 60 rows, maximum 200 per request.

### A16. Version tokens

| Token | Scope | Marker on mismatch |
|---|---|---|
| `logEpoch` | a conversation log; changes on compaction/fork | `proto.staleLogEpoch` |
| `revision` | monotonic revision of a topic's log | `proto.staleRevision` |

**Rule**: read → carry tokens → on stale marker re-read tokens and retry **once** → if still stale,
report degraded. Row identifiers MUST NOT be cached across an epoch change.

---

## Part B — Internal entities (owned by this server)

### B1. Runtime (in-memory, keyed by `workspaceKey`)

| Field | Type | Notes |
|---|---|---|
| `workspaceKey` | string | registry key |
| `child` | ChildProcess | owned |
| `pid` | number | reported in status |
| `startedAt` | epoch ms | |
| `protocolVersion` | `{name, version}` | asserted at first contact |
| `transportState` | `starting` \| `ready` \| `dead` | |
| `pending` | Map<id, {method, resolve, reject, timer, schema?}> | |
| `notifications` | ring buffer, bound `ZCODE_MCP_EVENT_BUFFER` (2000) | |
| `seenEventIds` | LRU, bound 2000 | de-duplication |
| `idleTimer` | handle | eviction |

**Invariants**: at most `ZCODE_MCP_MAX_CHILDREN` (default 2) live runtimes; evicted after
`ZCODE_MCP_CHILD_IDLE_MS` (default 900 s); every exit path kills the owned process group.

### B2. RunOutcome

The internal record every action produces and the envelope consumes:
`{ok, tool, action, mode: local|child|headless, runtime, payloadSource: protocol|filesystem|stdout|local,
exitCode, durationMs, timedOut, warnings: [{code, detail, impact: advisory|degraded|unreliable}],
errors[], diagnostics: {methods: [{method, ok, ms, error?}], stderrTail[]}, runId}`.

**`warnings[].impact` is the routing key** — `advisory` (note it), `degraded` (usable but incomplete),
`unreliable` (do not act on this).

### B3. Persisted schema (`data/audit.db`, SQLite)

```sql
CREATE TABLE runs (
  run_id TEXT PRIMARY KEY, ts INTEGER NOT NULL,
  tool TEXT NOT NULL, action TEXT NOT NULL,
  workspace_key TEXT, session_id TEXT,
  ok INTEGER NOT NULL,
  payload_source TEXT, exit_code INTEGER, duration_ms INTEGER, timed_out INTEGER,
  runtime_version TEXT, protocol_version INTEGER,
  command TEXT, argv_json TEXT
);

CREATE TABLE artifacts (
  run_id TEXT NOT NULL, kind TEXT NOT NULL,      -- wire|stdout|stderr|settings|attachment|report
  path TEXT NOT NULL, bytes INTEGER, sha256 TEXT,
  PRIMARY KEY (run_id, kind, path)
);

CREATE TABLE protocol_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL, seq INTEGER NOT NULL,
  direction TEXT NOT NULL,                        -- out|in|notification|request
  method TEXT, request_id TEXT, ok INTEGER, error_code INTEGER,
  ms INTEGER, bytes INTEGER
);

CREATE INDEX idx_runs_ws_ts   ON runs(workspace_key, ts);
CREATE INDEX idx_runs_session ON runs(session_id, ts);
CREATE INDEX idx_calls_run    ON protocol_calls(run_id, seq);
```

**Join to ZCode's own logs**: `runs.session_id` + the `turnId` recorded in the result join to
`~/.zcode/cli/log/zcode-<date>.jsonl` (`sessionId`, `turnId`, `traceId`, `spanId`) and to
`~/.zcode/cli/rollout/model-io-<sessionId>.jsonl`.

### B4. Redaction record

Every wire line, result and row passes through one redactor keyed by
`apiKey`, `authorization`, `*token*`, `*secret*`, `*password*` → `[REDACTED]`, controlled by
`ZCODE_MCP_REDACT` (default on). Verified by `test/redact.test.ts`.

### B5. PolicyState

`{mode: deny|allow|ask, allowlist: {toolName, ruleContent?}[], pending: PermissionRequest[],
counters: {allowed, denied, asked, parked}}`, plus the always-answered request kinds
(`session/requestRuntimePreferences`, `interaction/requestProviderRuntimeHeaders`,
`interaction/browserList`, `interaction/browserExecute`) and their canned responses.

---

## State transitions that matter

### Turn lifecycle (what the chat tool waits on)
```
queue item admitted ──▶ turn.started ──▶ (model.streaming | tool.updated)*
                                      ──▶ turn.completed | turn.failed      [terminal]
                                      ──▶ turn.steerQueued / turn.steerDrained  [during]
```

### Session status
```
idle ──▶ running ──▶ {idle | waiting | paused | completed | error}
                 ▲                          │
                 └────── resume ────────────┘
```
`waiting` is the observable state while an approval or user-input request is outstanding. **A tool
that observes `waiting` with a pending request that nobody answers is a bug in our policy module.**

### Runtime
```
(absent) ──spawn──▶ starting ──first response──▶ ready
                      │                            │
                      └──startup timeout──▶ dead ◀─┴──transport closed / killed──▶ dead
                                                 │
                                       next call ─┘ respawn
```
