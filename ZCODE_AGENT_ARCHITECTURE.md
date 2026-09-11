# ZCODE_AGENT_ARCHITECTURE.md

AI / agent / model / tool execution architecture of ZCode, reconstructed from the shipped
`zcode.cjs` (v0.16.5), the host bundle, and live runtime logs.

---

## 1. Component layout inside the agent runtime

```
                          ┌──────────────────────────────────────┐
                          │ bootstrap                            │
                          │  app.startup: config → runtime_config│
                          │   → storage → mcp → runtime → plugins│
                          └──────────────┬───────────────────────┘
                                         │
        ┌────────────────────────────────▼─────────────────────────────────┐
        │ bootstrap.zcode_protocol   (the server we drive)                  │
        │  • sqlite migration   • MCP bootstrap   • workspace_read_state     │
        │  • class Q3e: handleMessage→handleRequest→dispatchRequest          │
        │  • class X3e: NDJSON transport, serial processing queue            │
        │  • bootstrap.zcode_protocol_v4.commands  (v4 command gateway)      │
        └──────────────┬───────────────────────────────────────────────────┘
                       │
   ┌───────────────────┼────────────────────┬─────────────────────┬──────────────────┐
   │                   │                    │                     │                  │
┌──▼──────────────┐ ┌──▼─────────────────┐ ┌▼──────────────────┐ ┌▼────────────────┐ ┌▼─────────────┐
│ core.runtime    │ │ core.tool.executor │ │ core.subagent      │ │ adapters.model  │ │ adapters.mcp │
│ turns, phases,  │ │ tool dispatch,     │ │ child sessions,    │ │ provider SDK,   │ │ + .pool      │
│ queue, sessions │ │ iteration N,       │ │ Agent/Task tools,  │ │ streaming,      │ │ lifecycle,   │
│ event persist   │ │ permissions        │ │ SendMessage        │ │ retry, diag     │ │ leases       │
└─────────────────┘ └────────────────────┘ └────────────────────┘ └─────────────────┘ └──────────────┘
```

Confirmed module names from live log `module` fields:
`core.runtime`, `core.tool.executor`, `core.subagent`, `adapters.model`,
`adapters.model.provider_endpoint_routing`, `adapters.mcp`, `adapters.mcp.pool`,
`adapters.logging`, `bootstrap`, `bootstrap.zcode_protocol`, `bootstrap.zcode_protocol.mcp`,
`bootstrap.zcode_protocol_v4.commands`.

---

## 2. Model providers

### 2.1 Registry, not hardcoding
Providers are **data**, held in the desktop (`~/.zcode/v2/config.json`) and pushed to the agent
over `workspace/updateProviderRegistry`. The agent does not own credentials.

```ts
provider = {
  id:            "builtin:zai" | "builtin:bigmodel" | custom,
  name:          string,
  kind:          "anthropic" | …,                 // adapter family
  options:       { apiKey?, baseURL, apiKeyRequired? },
  enabled:       boolean,
  source:        "custom" | "builtin",
  models: {
    [modelId]: {
      reasoning:  { enabled, variants: ["low","max","high"], defaultVariant },
      limit:      { context, output },
      modalities: { input: ["text","image","video"], output: ["text"] },
      zcode:      { modified: boolean, priority: number }
    }
  },
  systemDisabledReason?: "oauth_provider_inactive"
}
```
Concrete values observed:
| Provider | baseURL | kind |
|---|---|---|
| `builtin:zai` | `https://api.z.ai/api/anthropic` | anthropic |
| `builtin:bigmodel` | `https://open.bigmodel.cn/api/anthropic` | anthropic |

Live model ids take the `<providerId>/<modelId>` form, e.g. `builtin:zai-coding-plan/GLM-5.3-Flash`,
and a user-added `openai-compatible` provider contributes ids of the form
`<provider-uuid>/<model-id>`.
Provider families: `zai`, `bigmodel`. Descriptor `providerFamilyDomain` in `setting.json`.

### 2.2 Model reference
```ts
modelRef = { providerId: string, modelId: string, variant?: string }
```
`enabledBuiltinAgentCliProviders: ["glm"]`; `modelProviderFamilyModes: {zai:"oauth"}`;
`modelProviderFamilySelectedKeys: {zai:"coding-plan:builtin:zai-coding-plan"}`.

### 2.3 Registry sync (revision-ordered, race-safe)
```
host  → agent  workspace/updateProviderRegistry { workspace, registry:{providers,revision,generatedAt}, includeWorkspaceState }
agent → host   { appliedProviderRevision, providerCount, status }
```
Host drops pushes whose `generatedAt` is older than the last applied revision
(`跳过过期 provider registry 同步`). Local providers are skipped for remote workspaces
(`jm(workspace)` guard). On registry change the host re-pushes to the active workspace and to
**pending startups** (`startup_ready:<reason>`).

### 2.4 Credentials and headers on demand
The agent never stores provider keys when running under the desktop. Instead:
```
agent → host  (request) interaction/requestProviderRuntimeHeaders
   { modelRef, providerId, requestId, sessionId, turnId? }
host  → u.get(workspaceKey).fire(...)  → service resolves headers → respond(id, headers)
```
And for official MCP servers:
```
agent → host  (request) interaction/requestOfficialMcpAuthHeaders
   { mcpKey, pluginId, targetOrigin, requestId, workspace }
host validates trust (officialMcpTrustedOrigins.isTrusted({mcpKey, origin, pluginId}))
   → {ok:true, headers} | {ok:false, reason:"official_mcp_origin_untrusted"|"official_auth_unavailable"}
```
**Design implication:** a bare `app-server` (no host) has **no credentials**. An MCP driving a bare
`app-server` must supply provider config itself (`workspace/upsertModelProvider` +
`workspace/updateProviderRegistry` or the CLI `--settings` file), or rely on
`login`-persisted OAuth (`~/.zcode/v2/credentials.json`, `zcodejwttoken`).
CONFIRMED empirically: bare `app-server` reports
`model:{current:{modelId:"missing-model",providerId:"zcode-unconfigured"}}`.

---

## 3. Turn lifecycle

### 3.1 Observed phases and events (CONFIRMED from `~/.zcode/cli/log/zcode-*.jsonl`)
```
turn.started
  turn.phase.started   { phase: "context_initialization" }
  turn.phase.completed { phase: "context_initialization", durationMs }
  turn.phase.started   { phase: "session_start_hooks" }
  … (further phases) …
  loop:
    model.request.started        { messageCount, iteration, turnNumber }
    model.network.completed      { … }
    model.sdk.stream.completed   { … }
    model.response.diagnostics   { … }
    session.event.persistence.started/completed      (per emitted event)
    tool.call.started            { toolCallId, toolName, iteration }
    tool.call.completed          { durationMs, status, iteration, toolName }
    model.request.started        (iteration N+1, messageCount grows)
  turn.completed
```
Failure paths: `model.request.failed`, `model.network.failed`, `model.sdk.stream.failed`,
`model.retry.delay.resolved`, `tool.call.failed`, `turn.failed`, `turn.phase.error`.

Log record shape:
```json
{"timestamp":"…","level":"info","event":"tool.call.completed","module":"core.tool.executor",
 "message":"Tool call completed","traceId":"…","spanId":"…","parentSpanId":"…",
 "sessionId":"sess_…","turnId":"turn_…","toolCallId":"call_00_…","durationMs":85855,
 "status":"completed",
 "context":{"queryId":"…","turnNumber":87,"model":"…","iteration":9,
            "querySource":"main_turn","toolName":"Bash"}}
```
This is a **complete, structured, machine-readable trace of every agent turn** — directly usable as
an MCP observability surface.

### 3.2 Turn input record
```ts
{ turnNumber, input: string, inputId?, queryId?,
  inputSource?, inputVisibility?, executionKind: "agent" | "controlOnly",
  targetId?, messageId?, foregroundExecutionId?, intent?, originMeta?, attachments? }
```
`executionKind: "controlOnly"` distinguishes control-plane turns (e.g. `/status`) from model turns.

### 3.3 Context construction
```
YEe(context) = [ ...context.systemMessages.map(m => ({message: m})),
                 ...context.metaUserAttachments.map(a => Js(a.source, a.content)) ]
```
i.e. history = system messages + injected meta-user attachments.
`_gt(context, modelRef)` supplies `{language, modelRef, outputStyle?}`.
`contextConfigurationSnapshot` / `config.envInfo.currentMode` drive behaviour.
`--force-mcs` forces **mid-conversation system projection** for Anthropic providers.
Context accounting is exposed as `contextUsed` / `contextWindow` on the session projection.

### 3.4 Streaming part model
`model.streaming` payload kinds:
```
start | finish | error
text_start | text_delta | text_end
reasoning_start | reasoning_delta | reasoning_end
tool_input_start | tool_input_delta | tool_input_end
tool_call
```
with `{assistantMessageId?, delta?, done?, input?, partId?, providerExecuted?, toolCallId?,
toolName?}`. High-frequency `model.streaming` events are **coalesced host-side**
(`createBackgroundSessionEventCoalescer`: 1500 ms flush, ≤96 items, merge adjacent deltas) before
fan-out, so subscribers see batched deltas.

### 3.5 Cancellation
- `session/stop` — **bypasses the serial processing queue** so it is never blocked behind work.
- `workspace/generateText` / `cancelGenerateText` — an `AbortSignal` is threaded into the model call
  (`withWorkspaceGenerateTextSignal`).
- `plugins/cancelOperation` — aborts long plugin ops.
- Permission-broker calls model cancellation explicitly so a cancelled request is never
  half-delivered.
- `session/cancelBackgroundTask` for background jobs.

### 3.6 Retries
`model.retry.delay.resolved` is emitted per retry; `model.request.failed` carries
`retryable?: boolean` in the error model:
```ts
{ type, message, stack?, code?, detail?, attribution?, retryable?, data? }
```
`streamRecovery.updated` events support resuming a stream after a mid-stream failure;
`recoverCompactTimelineCount` / `recoveredSteerInputCount` appear in the resume report.

---

## 4. Tool invocation and permissions

### 4.1 Tool sets
See `ZCODE_COMMAND_CATALOG.md` §3. Two lists: internal dispatch names (`mCn`, 30) and
provider-visible contracts (`eli`, 32). Ordering is normalised by
`orderProviderVisibleToolContracts`.

### 4.2 Permission model
```
agent tool executor → needs approval
   → (request) interaction/requestPermission  { sessionId, requestId, … }
host: key = <workspace,session,requestId>; dedupes; emits  permission.request
renderer decides
   → host permission.respond { decision: allow|deny|escalate|modify,
                               reason?, modifiedInput?, permissionUpdates? }
host → m.respond(protocolRequestId, decision)
```
Decision enum: `allow | deny | escalate | modify`.
`permissionUpdates: [{ type:"addRules", behavior:"allow"|"deny"|"ask",
                        rules:[{toolName, ruleContent?}] }]` — **the decision can persist a rule**,
which is the mechanism behind "always allow this".
Modes: `plan | build | edit | yolo | auto`; `build`/`edit`/`plan` are the user-facing CLI values,
`--prompt` defaults to `yolo`.
CLI tool gating: `--allowed-tools`, `--disallowed-tools`,
`--disallowedTools` with `Edit`, `Bash(git *)` (prefix/glob rule content) syntax.
Session-level gating: `toolAllowlist`, `toolDenylist` on `session/create`/`resume`/`send`.

### 4.3 Separate CUA permission broker
Computer-Use-Agent permissions go through a **different** channel: a local socket/named-pipe
`PermissionBrokerClient` to `cua-helper`, with token auth, peer-credential verification, and
a Windows named-pipe namespace restriction. Desktop-side onboarding channels
(`OpenCuaPermissionOnboarding`, `PrepareCuaHelperPermissionDrag`, …) exist because macOS/Windows
require a *human drag* to grant screen-recording permission.
`v4/cua/permission-observation` streams CUA permission state back to the client.

### 4.4 Elicitation and user input
| Mechanism | Agent → client | Client → agent |
|---|---|---|
| Elicitation (structured) | `permission.request`-style request, events `elicitation.*` | `elicitation/submit`, `elicitation/respond` |
| Free-form user input | request `interaction/requestUserInput`; event `userInput.request` | `userInput/response` |
| AskUserQuestion tool | tool `AskUserQuestion` → userInput path | same |

### 4.5 Session runtime preferences (agent asks the host)
```
agent → host (request) session/requestRuntimePreferences { scope, sessionId }
host  → { askUserQuestionAutoResolutionEnabled, nativeSearchEnhancementsEnabled, memoryEnabled }
```
When `sessionRuntimePreferencesAuthority === "local"` the host answers immediately from its own
resolver; otherwise it forwards to the desktop and can time out (error `-32022`,
`"Session runtime preferences request timed out"`, `timeoutMs` in `data`).

---

## 5. Subagents, workflows, background work

- **Subagents**: `Agent` / `Task` tools create child sessions
  (`sessionKind: subagent_child`, `sessionId` = `sess_subagent_agent_<uuid>` observed on disk).
  Enumerated with `session/subagents`. Cross-agent messaging via `SendMessage` /
  `RespondToCoordinator`. Child session dirs exist under
  `~/.zcode/cli/{agents,artifacts,exec,image-cache}/sess_subagent_agent_*`.
- **Workflows**: session kinds `workflow_parent`, `workflow_child`, `nested_workflow_child`, plus a
  `Workflow` tool — a declarative multi-step orchestration layer layered on the same session engine.
- **Goal mode**: `session/goal` + the `$Be` model
  `{sessionId, targetId, objective, summaryTitle, status: active|paused|budget_limited|complete,
    tokenBudget, tokensUsed, timeUsedSeconds, activeInputId?, activeRunStartedAtMs?,
    activeRunLastSeenAtMs?, createdAt, updatedAt}`
  with `goalVerificationsRetained: 20`. CLI `--target` / `--target-replace` and `/goal` drive it.
- **Background tasks**: `background_task.tracking.started` / `.terminal`,
  `background_task.notification.enqueued` / `.runtime_enqueued`, and
  `session/cancelBackgroundTask`. Session projection carries `backgroundJobs[]`.
- **Automations**: cron/interval scheduling persisted in the agent SQLite (≤20), executed as
  ordinary turns with `queryId: "automation-<uuid>:<epochMs>"` (CONFIRMED in logs). Fields include
  `relativeDelayMinutes`, `intervalUnit`, `interval`, `maxRuns`, `recurring`, `cronExpr`,
  `botDeliveryTarget`, `targetTaskId`.

---

## 6. MCP integration

```
adapters.mcp  +  adapters.mcp.pool
  mcp.server.connect.started → mcp.server.connected → mcp.tools.registered
  mcp.pool.connection.created → mcp.pool.lease.acquired → … → mcp.pool.lease.released
  mcp.pool.connection.stale → mcp.pool.connection.closed
  mcp.server.ping.failed / mcp.server.failed / mcp.adapter.closed
```
- Isolation: `mcpIsolation: "session" | "workspace"`; source `"custom" | "builtin"`.
- Instance identity: `mcpId` (e.g. `custom:12da4ce26509`, `builtin:node_repl`) +
  `mcpInstanceId` (uuid). **The `mcpId` hash is derived from the server config** — useful as an
  identity key.
- Tools registered as `mcp__<server>__<tool>`.
- Pool uses **leases** so concurrent sessions share connections safely, with staleness eviction.
- `mcp/list` protocol method + `zcode:load-mcp-from-user-directory` /
  `zcode:save-mcp-to-user-directory` IPC for file-based management.
- Official MCP servers can request auth headers through the trusted-origin validator (§2.4).

**Tool-budget ceiling (CONFIRMED constraint):** GLM rejects >~89–94 registered tools with
`[1210] Invalid API parameter`. The user's own `mcp-profile.cmd` documents a full profile (~116
tools) vs a trimmed profile (~63). Any MCP server ZCode loads must keep its tool count modest.

---

## 7. Persistence and observability of the agent

| Artifact | Path | Contents |
|---|---|---|
| Sessions/turns/messages/parts | `~/.zcode/cli/db/db.sqlite` | relational state, WAL |
| Model I/O | `~/.zcode/cli/rollout/model-io-<sessionId>.jsonl` | **full request/response per model call** |
| Logs | `~/.zcode/cli/log/zcode-<date>.jsonl` | structured events, retention-managed |
| Shell state | `~/.zcode/cli/exec/{bash-startup,shell-snapshots}` | bash env snapshots |
| Artifacts | `~/.zcode/cli/artifacts/<sessionId>` | generated files |
| Images | `~/.zcode/cli/image-cache/<sessionId>` | attachment/image cache |

Log retention: `log.retention.cleanup.scheduled` (daily files, currently ~25 MB/day).

---

## 8. End-to-end AI request trace (with real evidence)

```
1. user types in composer
2. renderer builds v4 command envelope {type:"sendText", payload:{text, attachments, delivery}}
3. host RPC → host.admitCommandInput(envelope, {admissionSeq, admittedAt, queueItemId})
4. v4/command → agent Inbox.admit → queue item kind:"sendText"
   └ size guard: projected bytes ≤ 16 MiB else {status:"failed", reasonCode:"proto.payloadTooLarge"}
5. agent core.runtime:
   turn.started → phase context_initialization → phase session_start_hooks
6. context construction: systemMessages + metaUserAttachments (+ AGENTS.md, skills, MCP tool schemas)
7. adapters.model → model.request.started {messageCount, iteration, turnNumber}
                   → model.network.completed → model.sdk.stream.completed
   [live sample] turnNumber 87, iteration 9, messageCount 174
8. streaming: session/event {type:"model.streaming", payload:{kind:"text_delta", delta}}
              + session.event.persistence.started/completed per event
9. tool calls: tool.call.started {toolName:"Bash", toolCallId:"call_00_…"}
               [live sample durationMs 85855] → tool.call.completed {status:"completed"}
10. events normalized host-side (seq), delta-coalesced (1500 ms), fanned out to subscribers
11. terminal: turn.completed
```
Every numbered step except 1–2 and 11 is directly observable in
`~/.zcode/cli/log/zcode-2026-09-11.jsonl`.

---

## 9. What an MCP can and cannot control

| Capability | Feasible via protocol? | Best path |
|---|---|---|
| Create/read/list/fork/close sessions | ✔ | `session/*` |
| Send a prompt and stream the result | ✔ | `v4/command` + `session/event` |
| Cancel a running turn | ✔ | `session/stop` (queue-bypassing) |
| Choose model / thought level / mode per session | ✔ | `session/setModel`, `setThoughtLevel`, `setMode` |
| Inspect conversation, plans, usage | ✔ | `v4/conversation/*`, `usage/stats` |
| Inspect and rewind file changes | ✔ (capability-gated) | `v4/conversation/fileChanges` / `fileRewindPreview` |
| Approve/deny a permission request | ✔ **only if you are the attached client** | respond to `interaction/requestPermission` |
| Enumerate/install/configure plugins | ✔ | `plugins/*` |
| List MCP servers | ✔ | `mcp/list` |
| Create cron automations | ✔ | `automation/*` |
| Read/write files as the *editor* would | ✘ (no editor service exists) | use `Read`/`Write`/`Edit` tools via a turn, or plain FS I/O in the MCP |
| Query the running desktop's open tabs / selection | ✘ over protocol | host RPC `workspace.list`/`state.updated` only, via MessagePort |
| Drive the desktop UI itself | ✘ | UI automation only (rating E) |
