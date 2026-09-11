# ZCODE_MCP_SPEC.md

Architecture, tools and schemas for **`mnehmos.zcode.mcp`** — a thin semantic control layer over
ZCode, built on the reverse-engineering findings in this repository.

---

## 0. Doctrine mapping

Following `mnehmos.unreal.mcp` and the *vibe-coders-bible* control hierarchy:

| Control | Here |
|---|---|
| **Elimination** (ch.8) | no UI automation, no mouse/keyboard simulation, no direct SQLite writes, no writing `credentials.json`, no unbounded protocol surface by default |
| **Substitution** (ch.9) | a bounded set of typed tools + discriminated-union actions **replaces** "send raw JSON to ZCode"; the raw protocol call survives as an explicit, kill-switchable escape hatch |
| **Engineering controls** (ch.10) | zod validates every argument before a process is touched; the protocol version and method catalog gate the vocabulary against the installed binary; every mutation is read back |
| **The repo is the memory** (ch.14) | every session, turn and protocol call is a row in `data/audit.db`; raw wire traffic is kept in `work/wire/` |
| **Tests are reflexes** (ch.15) | unit tests for schemas and the protocol codec; opt-in integration tests that spawn the real runtime |
| **Schemas are contracts** (ch.16) | an invalid action costs zero process starts |
| **The model narrates, the engine rules** (ch.25) | the MCP never claims a mutation happened without reading the new state back from ZCode |
| **State first** (ch.28) | the answer is the state ZCode actually returned, with ids, timestamps and revision tokens |

**The one rule:** *a tool must never report success for something that did not happen.*
Every mutating tool performs a **read-back** (`session/read`, `session/list`, `workspace/readState`,
`plugins/list`, `automation/list`, `mcp/list`) and reports the read-back, not the request. If
read-back is impossible, the envelope carries `warn(..., impact: 'degraded')` or the call fails.

---

## 1. Architecture

```
 MCP client (any agent, incl. ZCode itself)
   │  tools/call { tool, action, ...args }
   ▼
 src/index.ts                     zod discriminated union per tool
   │                              (invalid action never spawns a process)
   ▼
 src/zcode/actions/*.ts            one dispatcher per tool
   │                              each builds ZCode Protocol params
   ▼
 src/zcode/registry.ts             agent-runtime registry, keyed by workspaceKey
   │                              spawn / reuse / health / idle-evict / reap
   ▼
 src/zcode/transport.ts            spawn <node> zcode.cjs app-server --stdio
   │                              NDJSON codec, frame limits, serial in-flight ids
   ▼
 src/zcode/protocol.ts             ZCodeProtocolClient equivalent:
   │                              request/notify/respond, timeouts, zod result parse
   ▼
 src/zcode/policy.ts               approval policy, mode/allowlist/denylist defaults
   │
   ▼
 work/wire/<runId>.ndjson          exact bytes in and out (redacted)
 data/audit.db                     one row per call + one row per artifact
   │
   ▼
 src/envelope.ts                   { ok, tool, action, mode, evidence, diagnostics, result, run }
```

### 1.1 Why spawn our own runtime (the two-tier design)

**CONFIRMED empirically:** the agent runtime requires *its own* provider configuration and does not
inherit the desktop's. A bare `app-server` reports
`model.current = {modelId:"missing-model", providerId:"zcode-unconfigured"}` and
`modelCatalog.available = []`, and `zcode --prompt …` fails with
`Error: Model config is missing. Create C:\Users\<u>\.zcode\cli\config.json with an explicit model
provider before running ZCode.`

Therefore:

| Tier | Mechanism | Rating | Status |
|---|---|---|---|
| **A — owned runtime** (default, and the ONLY viable tier) | spawn `zcode app-server --stdio`; the MCP *is* the only client, so it answers `interaction/*` requests itself and fully controls model/mode/tools | **A** | available today, proven |
| ~~B — attached desktop~~ | ⛔ **not buildable.** The desktop opens **no** local HTTP/WS listener. Web Remote Control is a pure *outbound* `ws` client to `wss://zcode.z.ai/ws`; the phone/browser talks to that relay, and the desktop↔host MessagePort is tunnelled through it in **binary** `rpc-frame` fragments. Attaching to the desktop would mean impersonating a paired device against Z.ai's cloud relay — out of scope and inappropriate. | — | ruled out (addendum §A16) |
| C — remote ZCode *server* | ⚠️ real but a different surface: `wss://<base>/ws/host?token=…` with `Authorization: Bearer` + `x-zcode-rpc-host-capability`, discovered via `GET /api/server-info` (`capabilities.websocketRpc: true`). Requires operating a ZCode server component and holding a token. | B | **possible future tier, explicitly not v1** |

`mnehmos.zcode.mcp` v0.1 ships **Tier A only** — and the audit showed Tier A is the *only* local
option, which means there is exactly one clean boundary: the agent runtime's stdio protocol.

#### 1.1.1 Provider bootstrap — the schema is known ★

Reconnaissance resolved this statically (`ZCODE_UNKNOWNS.md` U-3). The agent reads its model config
from the top-level `model` key, sourced **project-first then user**
(`~/.zcode/cli/config.json` by default):

```jsonc
{
  "model": {
    "main": { "provider": "<id>", "model": "<modelId>",
              "kind": "anthropic" | "openai" | "openai-compatible",
              "baseURL": "https://…", "apiKeyRequired": true },
    "lite": { },        // optional
    "available": [ ]    // optional
  }
}
```

**The API key may come entirely from the environment** — resolution order is
`OPENAI_API_KEY` → `ANTHROPIC_API_KEY` → `<PROVIDERNAME>_API_KEY` → `<PROVIDER>_API_KEY` →
`ZCODE_API_KEY`. The MCP therefore **injects the key via the child's environment and never writes a
secret to disk**; only `provider` / `model` / `kind` / `baseURL` go into a generated settings file.

### 1.2 Consequence of owning the runtime: we must answer `interaction/*`

A spawned `app-server` sends **client requests** to its only client (us):

```
{"id":"server-1","method":"interaction/requestPermission","params":{sessionId,requestId,…}}
{"id":"server-2","method":"interaction/requestUserInput","params":{…}}
{"id":"other",  "method":"interaction/requestProviderRuntimeHeaders","params":{…}}
{"id":"other",  "method":"interaction/requestOfficialMcpAuthHeaders","params":{…}}
{"id":"other",  "method":"session/requestRuntimePreferences","params":{scope,sessionId}}
{"id":"other",  "method":"interaction/browserList"|"interaction/browserExecute", …}
```
Unanswered, these block the turn. So `src/zcode/policy.ts` implements a **default-deny** policy and
a pending-request queue surfaced through `zcode_approval`:

| Env | Behaviour |
|---|---|
| `ZCODE_MCP_APPROVAL=deny` (**default**) | auto-deny; every denial is recorded and visible in `zcode_approval list` |
| `ZCODE_MCP_APPROVAL=allow` | auto-allow (only for trusted, sandboxed workspaces) |
| `ZCODE_MCP_APPROVAL` = allowlist file | allow only listed `toolName` / `toolName(ruleContent)` patterns |
| `ZCODE_MCP_APPROVAL=ask` | hold pending; the caller resolves via `zcode_approval respond {request_id, decision, rule?}` |
| `session/requestRuntimePreferences` | always answered locally from config (never blocks) |
| `interaction/requestProviderRuntimeHeaders` | answered from the configured provider block |
| `interaction/browserList` / `browserExecute` | answered `{browsers:[]}` / `{ok:false, error:{code:"backend_unavailable"}}` unless a browser backend is configured |

`mode` defaults to `edit`; `yolo` is opt-in per call.

### 1.3 Process model

- One `app-server` child **per `workspaceKey`**, lazily spawned, reused across calls.
- Registry keyed by `workspaceKey` (the system-wide join key — see `ZCODE_STATE_MODEL.md` §1.1).
- Idle eviction (`ZCODE_MCP_CHILD_IDLE_MS`, default 15 min) closes stdin and kills the **owned
  process group**, mirroring ZCode's own `disposeAndWait` behaviour.
- Hard cap `ZCODE_MCP_MAX_CHILDREN` (default 2) to bound memory: each runtime is a ~12.6 MB bundle
  plus its SQLite handles.
- Startup grace: the runtime answers the first request in ~1.1 s; the transport waits for the first
  response with `ZCODE_MCP_STARTUP_MS` (default 30 s) before declaring failure.
- **`--cwd` is always an explicit workspace root**, never inherited.

### 1.4 Wire discipline

- Request ids are monotonically increasing integers, stringified on send (matches the client
  contract), echoed back verbatim.
- `maxFrameBytes` = 1 MiB is enforced **before** send; larger payloads are routed through
  `v4/attachment/begin|chunk|commit`.
- Every line in and out is appended to `work/wire/<runId>.ndjson` with secrets redacted.
- Notifications are buffered into a bounded ring per session
  (`ZCODE_MCP_EVENT_BUFFER`, default 2000 — matching `eventRetentionPerSession`).
- `maxFrameBytes`/`logicalFrameAssembly*` limits and the protocol name/version are **read from the
  live runtime** at first contact (`version` + a probe `session/list`) and recorded in the audit row;
  a mismatch against the baked-in catalog degrades the vocabulary, it does not silently pass.

---

## 2. Tool surface

14 tools, discriminated-union `action` in each — matching the sibling repo convention and staying
well inside the GLM tool-budget ceiling (~89–94 tools total across all ZCode MCP servers).

> **Naming note (important):** MCP tool names must match `^[a-zA-Z0-9_-]{1,64}$` — **dots are not
> legal**. The dotted names suggested in the brief (`zcode.status`, `zcode.file.read`) are
> therefore exposed as `zcode_status`, `zcode_files` (with `action: "read"`), etc. The mapping is
> given per tool below.

| # | Tool | Replaces requested | Underlying protocol methods | Rating |
|---|---|---|---|---|
| 1 | `zcode_status` | `zcode.status`, `zcode.workspace.current`, `zcode.editor.active`(partial) | `session/list`, `workspace/readState`, `version`, `doctor` | **A** |
| 2 | `zcode_session` | `zcode.workspace.list`, `zcode.agent.list`, `zcode.agent.state` | `session/list`, `session/read`, `session/create`, `session/resume`, `session/close`, `session/fork`, `session/compact`, `session/subagents`, `session/setModel`, `session/setMode`, `session/setThoughtLevel`, `session/goal`, `session/usage` | **A** |
| 3 | `zcode_chat` | `zcode.agent.chat`, `zcode.agent.cancel` | `v4/command`, `session/send`, `session/stop`, `session/cancelBackgroundTask`, `session/events` | **A** |
| 4 | `zcode_conversation` | `zcode.agent.state`, `zcode.diagnostics.list` | `session/messages`, `session/events`, `v4/conversation/rowsRange`, `v4/conversation/plans`, `v4/conversation/usage` | **B** |
| 5 | `zcode_files` | `zcode.diff.list`, `zcode.diff.accept`, `zcode.diff.reject`, `zcode.file.read` | `v4/conversation/fileChanges`, `v4/conversation/fileRewindPreview`, `v4/attachment/read`, `v4/attachment/begin|chunk|commit` | **B** |
| 6 | `zcode_command` | `zcode.command.list`, `zcode.command.execute` | `v4/commands/query`, `v4/command` | **A** |
| 7 | `zcode_settings` | `zcode.settings.get`, `zcode.settings.set` | `workspace/readState`, `workspace/setDefault*`, `workspace/updateInteractionPreferences`, `workspace/updateModelIoPreferences`, `workspace/upsertModelProvider`, `workspace/removeModelProvider`, `workspace/updateProviderRegistry`, `workspace/hooks/trustGrant` | **A** |
| 8 | `zcode_plugins` | `zcode.extension.list` | `plugins/list`, `plugins/overview`, `plugins/describe`, `plugins/setEnabled`, `plugins/install`, `plugins/uninstall`, `plugins/update`, `plugins/configure`, `plugins/resetConfig`, `plugins/validate`, `plugins/marketplace/*` | **A** |
| 9 | `zcode_mcp` | — | `mcp/list`, `~/.zcode/cli/config.json` | **A** |
| 10 | `zcode_automation` | — | `automation/list|create|update|delete|checkTaskBinding` | **A** |
| 11 | `zcode_usage` | — | `usage/stats` | **A** |
| 12 | `zcode_approval` | `zcode.agent.approve` | answers `interaction/requestPermission`, `interaction/requestUserInput`, `elicitation/*` | **B** |
| 13 | `zcode_headless` | fallback for `zcode.agent.chat` | `zcode --prompt … --json` (no protocol) | **A** |
| 14 | `zcode_protocol` | — | raw `{method, params}` + baked-in method catalog | **C** (gated) |

### 2.1 The escape hatch

`zcode_protocol` is the ch.9 substitution escape hatch: one action for any protocol method, so the
MCP never becomes a bottleneck when ZCode adds methods. It is **disabled by default**:

```
ZCODE_MCP_DISABLE_PROTOCOL=1      # kill switch (mirrors UE_MCP_DISABLE_SCRIPT)
ZCODE_MCP_PROTOCOL_ALLOW=session/*,workspace/readState,v4/commands/query
```

`zcode_protocol methods` returns the baked-in catalog (66 methods, from
`data/zcode_protocol_methods.json`, regenerated by `tools/zcode_methods.py`) annotated with which
are read-only and which require `--allow-mutations`.

---

## 3. Tool contracts

Envelope (same shape as `mnehmos.unreal.mcp`, so mixed output routes mechanically):

```ts
{
  ok: boolean,
  tool: string, action: string, mode: 'local' | 'child' | 'headless',
  runtime: { version: string, protocol: {name: "ZCode Protocol", version: 1},
             transport: 'stdio', workspace_key: string } | null,
  evidence: {
    payload_source: 'protocol' | 'filesystem' | 'stdout' | 'local',
    exit_code: number | null, duration_ms: number, timed_out: boolean,
    warnings: [{ code: string, detail: string, impact: 'advisory'|'degraded'|'unreliable' }],
    errors: string[],
  },
  diagnostics: { methods: [{method, ok, ms, error?}], stderr_tail: string[] },
  result: unknown,
  run: { wire: string, settings: string|null, command: string } | null,
}
```

### 3.1 `zcode_status`
```ts
action:
 | { action: 'runtimes' }                                  // MCP-owned children: pid, workspace, uptime, version
 | { action: 'workspace', workspace?: string }               // → workspace/readState
 | { action: 'sessions',  workspace?: string, limit?: int<=200 }
 | { action: 'probe',     workspace?: string }               // version + session/list + mcp/list summary
 | { action: 'doctor',    workspace?: string }               // CLI doctor capture
 | { action: 'runs', limit?: int<=200 }                      // audit rows
```
- **Args:** `workspace` is a path or a `workspaceKey`; resolved, never invented.
- **Output:** the envelope with `result` = the verbatim `workspace/readState` payload
  (`modelCatalog`, `settings.mode|model|permission|thoughtLevel`, `slashCommands`, `workspace`).
- **Failure modes:** runtime not found (`ZCODE_MCP_CLI` unset and discovery failed); spawn error;
  first-response timeout; `-32602` (schema drift — reported as `impact:'degraded'`).
- **Permissions:** read-only. **Rating A.**

### 3.2 `zcode_session`
```ts
action:
 | { action: 'list',   workspace?: string, limit?: int<=200 }
 | { action: 'get',    session_id: string }
 | { action: 'create', workspace: string, mode?: Mode, model?: string,
                       thought_level?: string, mcp_servers?: string[],
                       title_generation?: boolean, persistence?: string }
 | { action: 'resume', session_id: string, model?: string, thought_level?: string }
 | { action: 'close',  session_id: string }
 | { action: 'fork',   session_id: string, checkpoint_id?: string }
 | { action: 'compact',session_id: string, instructions?: string }
 | { action: 'set_model',         session_id: string, model: string }
 | { action: 'set_mode',          session_id: string, mode: Mode }
 | { action: 'set_thought_level', session_id: string, thought_level: string }
 | { action: 'goal',   session_id: string, goal_action: 'show'|'set'|'pause'|'resume'|'clear',
                       objective?: string }
 | { action: 'subagents', session_id: string }
 | { action: 'usage',  session_id: string }
Mode = 'plan'|'build'|'edit'|'yolo'|'auto'
```
- **Read-back:** `create`/`resume`/`fork`/`set_*` re-issue `session/read` and return the observed
  `status`, `mode`, `model`, `title`. A `set_model` is only `ok:true` if the read-back shows the new
  model.
- **Failure modes:** unknown `session_id` (`-32004 sessionUnavailable`); model not in the pushed
  registry (agent rejects reuse of a removed model — surfaced as `impact:'unreliable'`);
  unknown `mode`/`thought_level` variant.
- **Permissions:** `set_*`, `goal`, `close`, `fork`, `compact` are mutating but bounded; none touch
  the filesystem. **Rating A.**

### 3.3 `zcode_chat`
```ts
action:
 | { action: 'send', session_id: string, text: string,
     attachments?: {path?: string, ref?: string, mime?: string, name?: string}[],
     delivery?: 'auto'|'startNow'|'queue'|'guide',
     tool_allowlist?: string[], tool_denylist?: string[],
     wait?: boolean, wait_timeout_ms?: int,                 // default true, 600000
     collect?: 'final'|'text'|'events'|'none' }             // default 'final'
 | { action: 'stop', session_id: string }
 | { action: 'cancel_background', session_id: string, task_id: string }
 | { action: 'steer', session_id: string, text: string }
 | { action: 'wait', session_id: string, until?: 'idle'|'turn_complete'|'any_terminal',
     timeout_ms?: int, collect?: 'final'|'text'|'events' }
```
- **Underlying:** `v4/command` with envelope
  `{commandId, sessionId, type:'sendText', payload:{text, attachments, delivery, …}}`;
  streaming observed by subscribing to `session/event` notifications for that session.
- **Attachment path handling:** a local `path` is uploaded by the MCP through
  `v4/attachment/begin → chunk (512 KiB) → commit` and the resulting `ref` is placed in
  `payload.attachments`. This keeps calls inside the 1 MiB frame limit.
- **Output (`collect:'final'`):** `{status, turn: {turnId, turnNumber, outcome:'completed'|'failed',
  duration_ms, tool_calls: n}, text: string, events: n, usage?: {…}, artifacts: [paths resolved from
  tool results]}`.
- **Read-back:** `collect:'final'` is only `ok:true` when a terminal `turn.completed`/`turn.failed`
  event was observed. A `status:"accepted"` response alone yields
  `warn(impact:'degraded', detail:'accepted but no terminal turn event observed')` — **this is the
  single most important read-back in the server**, because `v4/command` returns acceptance, not
  completion.
- **Failure modes:** `status:'noop'` (reason code passed through verbatim); `status:'failed'`
  (`fault.command.notImplemented`, `fault.command.executionFailed`, `proto.payloadTooLarge`); turn
  failure (`turn.failed` with the error model); approval denial (see §3.12); timeout.
- **Permissions:** starts model work. `mode` on the session governs tool authority. **Rating A.**

### 3.4 `zcode_conversation`
```ts
action:
 | { action: 'rows',     session_id: string, before_row_id?: string, limit?: int<=200 }
 | { action: 'messages', session_id: string }
 | { action: 'events',   session_id: string, limit?: int<=2000 }
 | { action: 'plans',    session_id: string, row_id?: string }
 | { action: 'usage',    session_id: string }
```
- **Version tokens:** every call echoes the `log_epoch` and `revision` it observed. On
  `proto.staleLogEpoch` / `proto.staleRevision` the tool **re-reads the tokens and retries once**,
  then reports `impact:'degraded'` with both token sets if it still fails. Row ids are never cached
  across an epoch change.
- **Failure modes:** `proto.staleLogEpoch`, `proto.staleRevision`, `-32004`. **Rating B.**

### 3.5 `zcode_files`
```ts
action:
 | { action: 'changes',        session_id: string, row_id: string }
 | { action: 'rewind_preview', session_id: string, row_id: string }
 | { action: 'read_attachment',session_id: string, ref: string, mime?: string,
     max_bytes?: int<=31457280, message_id?: string, attachment_index?: int }
 | { action: 'put_attachment', path: string, session_id?: string }
```
- **Explicit non-capability (documented, not hidden):** ZCode has **no editor document service**.
  There is no protocol method to read or write a file *as the editor sees it*, no "active editor",
  and no selection API. `zcode_files` therefore exposes only what exists: the conversation's
  **file-change and rewind records**, plus attachment I/O.
- For actual file mutation the spec deliberately routes through `zcode_chat` with the agent's own
  `Write`/`Edit`/`ApplyPatch` tools, **because that is the only path that produces
  `checkpoint.created`, participates in `rewind.triggered`, and is reversible.** A plain FS write
  from inside the MCP would bypass all of that.
- `changes` requires `baseLogEpoch` + `baseRevision`; obtained automatically from the session's
  current log state.
- **Failure modes:** `fault.fileChanges.unsupported`, `fault.fileRewindPreview.unsupported`,
  `fault.attachment.previewNotMedia`, `fault.attachment.previewTooLarge`, `-32004`.
  **Rating B.**
- `rewind_preview` is **read-only**. Actually applying a rewind is `zcode_session fork` (safe) or the
  `/rewind` slash command (destructive) — the latter requires `confirm: true`.

### 3.6 `zcode_command`
```ts
action:
 | { action: 'query',   session_id?: string, commands: {command_id: string, session_id?: string|null}[] }  // max 32
 | { action: 'execute', session_id?: string, envelope:
     { command_id: string, type: 'createSession'|'sendText'|'sendGoalCommand'|'compact',
       payload: Record<string, unknown> } }
 | { action: 'catalog' }   // baked-in list of protocol methods + slash commands
```
- `query` requires ≥1 entry, each with a string `commandId` (CONFIRMED by probe).
- `execute` returns `{status, result?, reasonCode?, message?}` verbatim and **never** claims
  completion — it is an admission, not a result. Use `zcode_chat wait` for outcomes.
- **Rating A.**

### 3.7 `zcode_settings`
```ts
action:
 | { action: 'read_state', workspace: string }
 | { action: 'get', file: 'agent_config'|'desktop_settings'|'provider_registry' }   // redacted
 | { action: 'set_desktop', patch: Record<string, unknown> }        // ~/.zcode/v2/setting.json
 | { action: 'set_default_model',          workspace: string, model: string }
 | { action: 'set_default_mode',           workspace: string, mode: Mode }
 | { action: 'set_default_thought_level',  workspace: string, thought_level: string }
 | { action: 'update_interaction_prefs',   workspace: string, ask_user_question_auto_resolution: boolean }
 | { action: 'update_model_io_prefs',      workspace: string, full_retention: boolean }
 | { action: 'upsert_provider', workspace: string, provider: ProviderBlock }
 | { action: 'remove_provider', workspace: string, provider_id: string }
 | { action: 'update_provider_registry', workspace: string, registry: Registry }
 | { action: 'hook_trust_grant', workspace: string }
```
- **Two backends, stated honestly in `evidence.payload_source`:**
  - `set_default_*`, `update_*`, `upsert_provider`, `remove_provider`, `update_provider_registry`,
    `hook_trust_grant` → **protocol** (immediate effect).
  - `set_desktop`, `get` → **filesystem** (read at startup; needs a restart to take effect). The
    envelope emits `warn(impact:'advisory', detail:'desktop settings are read at startup; restart
    required')`.
- **Secret handling:** `get` **redacts** `apiKey` and any `*token*` field to `"[REDACTED]"` before
  returning. This is not optional.
  ⚠ **Security finding:** `~/.zcode/v2/config.json` stores provider API keys in **plaintext**
  (`options.apiKey`). The MCP must never echo them, and `zcode_settings get` returns a redacted view
  only.
- **Mutating, provider-level** calls (`upsert_provider`, `remove_provider`,
  `update_provider_registry`) require `ZCODE_MCP_ALLOW_PROVIDER_EDIT=1`; otherwise they refuse with
  `reasonCode:'mcp.provider_edit.disabled'`. Changing the provider registry can silently break the
  user's model access.
- **Rating A** (with the guard).

### 3.8 `zcode_plugins`
```ts
action:
 | { action: 'list',        workspace: string }
 | { action: 'overview',    workspace: string }
 | { action: 'describe',    workspace: string, plugin_id: string }
 | { action: 'set_enabled', workspace: string, plugin_id: string, enabled: boolean }
 | { action: 'install'|'uninstall'|'update', workspace: string, plugin_id: string }
 | { action: 'configure',   workspace: string, plugin_id: string, config: Record<string, unknown> }
 | { action: 'reset_config',workspace: string, plugin_id: string }
 | { action: 'validate',    workspace: string, plugin_id?: string }
 | { action: 'marketplace', marketplace_action: 'add'|'remove'|'update', target: string }
 | { action: 'cancel_operation', operation_id: string }
```
- `list` requires a `workspace` (CONFIRMED by probe: `-32602` without it).
- Long operations emit `plugins/operationProgress`; the MCP surfaces the last progress frame and an
  `operation_id` so the caller can `cancel_operation`.
- **Read-back:** after `set_enabled` / `install` / `uninstall` / `configure`, re-issue
  `plugins/list` (or `describe`) and report the observed state.
- **Tool-budget warning:** enabling plugins increases the registered-tool count. If the resulting
  count would exceed `ZCODE_MCP_TOOL_BUDGET` (default 88), the envelope carries
  `warn(impact:'degraded', code:'tool_budget', detail:'… GLM rejects >~89-94 tools with [1210]')`.
  This is CONFIRMED from the user's own `mcp-profile.cmd` and is a real operational hazard.
- **Permissions:** installing a plugin executes third-party code. Rating A for read/`set_enabled`;
  install/update/uninstall gated behind `ZCODE_MCP_ALLOW_PLUGIN_INSTALL=1`.

### 3.9 `zcode_mcp`
```ts
action:
 | { action: 'list',      workspace: string }   // → mcp/list: statuses map
 | { action: 'servers',   scope?: 'agent'|'desktop' }   // from config files, secrets redacted
 | { action: 'status',    workspace: string, server: string }
```
- `mcp/list` returns, per server:
  ```ts
  { status: 'connected'|'failed', transport: 'stdio'|'http'|'sse',
    toolCount: number, updatedAt: string,
    error?: string, failureKind?: 'network_unreachable'|'process_start_failed',
    protocolEra?: 'legacy'|string }
  ```
  Keys are the bare server name for user servers and `plugin:<pluginId>:<serverName>` for
  plugin-provided servers. Observed real values: comfyui 4 tools, remcp 28, aseprite 5, blender 10,
  unreal 12.
- ⚠ **Side effect, documented:** calling `mcp/list` **starts** the MCP servers (CONFIRMED via
  `process/mcpTelemetry kind:"process_start"`). The tool sets `evidence.mode:'child'` and reports
  the spawned `mcpInstanceId`s so the caller knows processes were created.
- Adding/removing a server is a **file** operation (`~/.zcode/cli/config.json`); the tool refuses to
  edit it unless `ZCODE_MCP_ALLOW_MCP_CONFIG_EDIT=1`, always writes a timestamped backup first
  (`config.json.bak-<ts>`, the same convention ZCode itself uses), and reports
  `warn(impact:'advisory', detail:'restart required')`.
- **Rating A.**

### 3.10 `zcode_automation`
```ts
action:
 | { action: 'list' }
 | { action: 'create', prompt: string, cron_expr?: string, relative_delay_minutes?: int,
     interval_unit?: 'minute'|'hourly'|'daily'|'weekly'|'monthly'|'yearly', interval?: int<=200,
     title?: string, model?: string, provider?: string, mode?: Mode, thought_level?: string,
     target_task_id?: string, recurring?: boolean, max_runs?: int }
 | { action: 'update', automation_id: string, patch: {...} }
 | { action: 'delete', automation_id: string }
 | { action: 'check_binding', target_task_id: string }
```
- **Hard limit:** at most **20** automations retained; the agent raises
  `AutomationCreateLimitError` (`[<code>] At most 20 automations may be retained.`). Passed through
  verbatim.
- `recurring:false` without `max_runs` means one-shot. Validation of `cron_expr` vs
  `interval_unit`/`interval` follows the platform rules (`interval` 1–200).
- **Read-back:** `create`/`update` return the automation; `list` is authoritative.
- **Rating A.**

### 3.11 `zcode_usage`
```ts
action: { action: 'stats', range: 'all'|'7d'|'30d' }   // requested range is REQUIRED
```
Returns the verbatim analytics object (`summary` + `heatmap`). Read-only. **Rating A.**

### 3.12 `zcode_approval`
```ts
action:
 | { action: 'list',    session_id?: string }
 | { action: 'respond', request_id: string, decision: 'allow'|'deny'|'escalate'|'modify',
     reason?: string, modified_input?: unknown,
     persist_rule?: { behavior: 'allow'|'deny'|'ask',
                      rules: {tool_name: string, rule_content?: string}[] } }
 | { action: 'policy' }   // current policy, effective allowlist, counters
```
- **Why it exists:** owning the runtime means the MCP receives `interaction/requestPermission`
  requests; unanswered they block turns. With `ZCODE_MCP_APPROVAL=ask` the request is parked and
  listed here.
- **Read-back:** after `respond`, the MCP confirms the agent accepted the response (the request id
  leaves the pending set) and returns the resulting session state.
- **Safety default:** `deny`. `persist_rule` writes a durable permission rule into the agent — this
  is the one call that changes *future* authority, so it requires
  `ZCODE_MCP_ALLOW_PERSIST_RULES=1`.
- **Failure modes:** unknown/expired `request_id` (the agent may have cancelled); response send
  failure (`"ZCode agent stdio transport is closed"`). **Rating B.**

### 3.13 `zcode_headless`
```ts
action: { action: 'prompt', text: string, workspace: string, output: 'json'|'text'|'stream-json',
          mode?: Mode, resume?: string, continue?: boolean, target?: string,
          attach?: string[], allowed_tools?: string[], disallowed_tools?: string[],
          settings?: string, timeout_ms?: int }
```
- Runs `zcode --prompt <text> --json --cwd <workspace> [--resume …]` as a bounded child process;
  captures stdout/stderr; returns parsed JSON when `--json` produces it.
- **Why it exists:** the definitive fallback. It needs no protocol implementation and survives
  protocol changes entirely.
- ⚠ **CONFIRMED parser quirk:** `--settings` and `--max-turns` appear in `zcode --help` but are
  **rejected** by the actual option parser with `Unknown option '--settings'`. `--prompt`, `-p`,
  `--json`, `--cwd` are accepted. This tool therefore **only emits flags verified to parse** and
  records the raw command line in `run.command`; unverified flags are omitted rather than guessed.
- Requires a model provider to be configured (see §1.1); otherwise ZCode returns
  `Error: Model config is missing.` which is passed through verbatim with
  `warn(impact:'unreliable', code:'provider_not_configured')`.
- **Rating A.**

### 3.14 `zcode_protocol` (escape hatch, disabled by default)
```ts
action:
 | { action: 'methods', filter?: string }        // baked-in catalog, annotated read_only/mutating
 | { action: 'call', method: string, params?: Record<string, unknown>,
     workspace?: string, session_id?: string, timeout_ms?: int }
```
- Disabled unless `ZCODE_MCP_DISABLE_PROTOCOL` is unset/`0` **and** the method matches
  `ZCODE_MCP_PROTOCOL_ALLOW`. Default allow: `session/*`, `workspace/readState`, `v4/commands/query`,
  `mcp/list`, `usage/stats`, `plugins/list`, `automation/list` — i.e. read-only paths.
- Mutating methods additionally require `ZCODE_MCP_PROTOCOL_ALLOW_MUTATIONS=1`.
- Always reports `impact:'unreliable'` in warnings: "raw protocol call — no semantic validation was
  applied". **Rating C.**

---

## 4. Environment contract (`src/schema/env.ts`)

```ts
const EnvSchema = z.object({
  ZCODE_MCP_CLI:          z.string().optional(),   // default: discovery
  ZCODE_MCP_NODE:         z.string().optional(),   // default: process.execPath
  ZCODE_MCP_WORKSPACE:    z.string().optional(),   // default workspace when a call omits it
  ZCODE_MCP_SETTINGS:     z.string().optional(),   // provider config passed to --settings (if it parses)
  ZCODE_MCP_WORK_DIR:     z.string().default(join(root,'work')),
  ZCODE_MCP_DB:           z.string().default(join(root,'data','audit.db')),
  ZCODE_MCP_TIMEOUT_MS:   z.coerce.number().int().min(1000).max(3_600_000).default(180_000),
  ZCODE_MCP_STARTUP_MS:   z.coerce.number().int().min(1000).max(600_000).default(30_000),
  ZCODE_MCP_CHILD_IDLE_MS:z.coerce.number().int().min(0).default(900_000),
  ZCODE_MCP_MAX_CHILDREN: z.coerce.number().int().min(1).max(8).default(2),
  ZCODE_MCP_EVENT_BUFFER: z.coerce.number().int().min(100).max(20_000).default(2000),
  ZCODE_MCP_APPROVAL:     z.enum(['deny','allow','ask']).default('deny'),
  ZCODE_MCP_APPROVAL_ALLOWLIST: z.string().optional(),   // path to JSON rules
  ZCODE_MCP_DEFAULT_MODE: z.enum(['plan','build','edit','yolo']).default('edit'),
  ZCODE_MCP_TOOL_BUDGET:  z.coerce.number().int().default(88),
  ZCODE_MCP_KEEP_WIRE:    z.coerce.number().int().min(0).default(200),
  ZCODE_MCP_DISABLE_PROTOCOL: z.string().optional(),      // kill switch
  ZCODE_MCP_PROTOCOL_ALLOW:   z.string().optional(),
  ZCODE_MCP_PROTOCOL_ALLOW_MUTATIONS: z.string().optional(),
  ZCODE_MCP_ALLOW_PROVIDER_EDIT:      z.string().optional(),
  ZCODE_MCP_ALLOW_PLUGIN_INSTALL:     z.string().optional(),
  ZCODE_MCP_ALLOW_MCP_CONFIG_EDIT:    z.string().optional(),
  ZCODE_MCP_ALLOW_PERSIST_RULES:      z.string().optional(),
  ZCODE_MCP_REDACT:       z.string().default('1'),        // never disable in shared use
});
```

### 4.1 Runtime discovery (mirrors ZCode's own order — do not invent)
```
1. ZCODE_MCP_CLI                       (explicit wins)
2. <install>/resources/glm/zcode.cjs   ← E:\zcode\resources\glm\zcode.cjs  (native-binary first via GLM_BINARY_PATH)
3. $GLM_BINARY_PATH                    (ZCode's own override var)
4. ~/.zcode/server/agents/glm/zcode.cjs
5. <install>/resources/glm/zcode-agent(.exe)
6. last resort: bundled-resources search paths
```
Discovery result is recorded in every envelope (`runtime.version`) and in the audit row, and is
re-verified by `zcode doctor` through `zcode_status probe`. If discovery fails, every tool fails
fast with `ZCODE_MCP_CLI` guidance — never a silent empty result.

Node resolution: `ZCODE_MCP_NODE` → `process.execPath` → `node` on PATH. The runtime is a Node
CommonJS bundle, so it must be launched as `node <zcode.cjs>`, **not** executed directly
(CONFIRMED: direct spawn fails with `EFTYPE`).

---

## 5. Provenance and observability

`data/audit.db` (better-sqlite3), matching the sibling convention:

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
  run_id TEXT NOT NULL, kind TEXT NOT NULL,      -- 'wire'|'stdout'|'stderr'|'settings'|'attachment'|'report'
  path TEXT NOT NULL, bytes INTEGER, sha256 TEXT,
  PRIMARY KEY (run_id, kind, path)
);
CREATE TABLE protocol_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL,
  seq INTEGER NOT NULL, direction TEXT NOT NULL,   -- 'out'|'in'|'notification'|'request'
  method TEXT, request_id TEXT, ok INTEGER, error_code INTEGER,
  ms INTEGER, bytes INTEGER
);
```
`work/wire/<runId>.ndjson` holds the exact redacted wire traffic. Because every agent turn is itself
logged by ZCode as structured JSONL (`~/.zcode/cli/log/zcode-<date>.jsonl`,
`~/.zcode/cli/rollout/model-io-<sessionId>.jsonl`), the MCP's audit rows and ZCode's own logs share
`sessionId`/`turnId` and can be joined — a genuinely end-to-end trace.

---

## 6. Error model

| Class | Source | Envelope |
|---|---|---|
| `ZcodeProtocolError{code,message,data}` | agent `-32600…-32700` | `ok:false`, `errors:[message]`, `code` preserved in `result.error_code` |
| `ZcodeMethodNotFound` | `-32601` | `ok:false`, `warn(impact:'degraded')` if the method was derived from the catalog, else `'unreliable'` |
| `ZcodeInvalidParams` | `-32602` | `ok:false`, `errors:[path-qualified message]` — **treated as schema drift and surfaced loudly** |
| `ZcodeSessionUnavailable` | `-32004` | `ok:false`, `errors:['session unavailable']` |
| `ZcodeSpawnError` / `ZcodeStartupTimeout` | transport | `ok:false`, `diagnostics.stderr_tail` populated |
| `ZcodeTransportClosed` | `"ZCode agent stdio transport is closed"` | `ok:false`, child marked dead, respawn on next call |
| `ZcodeCommandNoop` | `status:'noop'` | `ok:false`, `result.reason_code` verbatim — **noop is not success** |
| `ZcodeStaleLog` | `proto.staleLogEpoch`/`proto.staleRevision` | retried once, then `ok:false`, `impact:'degraded'` |
| `ZcodeToolBudgetExceeded` | computed | `ok:true` + `warn(impact:'degraded', code:'tool_budget')` |
| `ZcodeRefused` | policy guards | `ok:false`, `reasonCode:'mcp.<guard>.disabled'` |

`ZCODE_MCP_REDACT=1` (default) scrubs `apiKey`, `authorization`, `*token*`, `*secret*`, `*password*`
from every wire line, log line and result before it is written or returned.

---

## 7. Why not an extension/plugin instead?

Evaluated and rejected as the primary design (see `ZCODE_ARCHITECTURE.md` §10):

| | Plugin | This MCP |
|---|---|---|
| Reaches agent sessions/tools | ✔ | ✔ |
| Reaches desktop/host state (tasks, workspaces, credentials) | ✔ | ✘ (Tier A) |
| Installable by a non-ZCode client | ✘ | ✔ |
| Independent version/release cycle | ✘ | ✔ |
| Tool-budget cost | same | same |
| Coupling to plugin-format churn | high | low |

A plugin is the right vehicle **only** if the goal is to add tools *to ZCode's own agent*. Here the
goal is to control ZCode *from outside* — so an out-of-process MCP speaking ZCode Protocol is the
narrower, more stable boundary. A plugin bridge can be added later without changing this design.

---

## 8. Explicit non-goals

1. **No UI automation.** No clicks, keystrokes, screenshots or window scraping.
2. **No editor-document API.** It does not exist in ZCode; file mutation goes through agent tools.
3. **No direct SQLite writes.** `db.sqlite` and `tasks-index.sqlite` are read-only, and read from
   copies.
4. **No `credentials.json` writes.** Use `login`/`logout`.
5. **No auto-approval.** Default policy is `deny`.
6. **No unbounded raw-protocol passthrough by default.**
7. **No hidden success.** Every mutation is read back or explicitly degraded.
