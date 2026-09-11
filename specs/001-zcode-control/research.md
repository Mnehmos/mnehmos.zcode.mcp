# Research: ZCode Programmatic Control Surface

**Phase 0 output** for `specs/001-zcode-control`. This is the condensed decision record.
The full evidence archive is the ten `ZCODE_*.md` files at the repository root; each finding below
cites the archive section that proves it.

Evidence labels: **CONFIRMED** (directly demonstrated) / **STRONGLY INFERRED** / **HYPOTHESIS**.

---

## R1 — What is ZCode, structurally?

**Decision**: Treat ZCode as three tiers: an Electron shell, a host/broker, and a separate headless
agent runtime. Target the runtime.

**Evidence**: `ZCODE_ARCHITECTURE.md` §2–5. CONFIRMED: `app.asar/package.json` internal packages
`@zcode/{desktop,client,rpc,server,services,shared,ui}`; runtime bundle
`resources/glm/zcode.cjs` self-reporting `zcode 0.16.5`; `~/.zcode/cli/` vs `~/.zcode/v2/` split.

**Alternatives rejected**:
- *Target the Electron renderer's IPC* — 129 `zcode:*` channels exist but are in-process only
  (CONFIRMED: no ZCode process listens on any TCP port). Rating E.
- *Target the host RPC* — semantically the richest (workspaces, tasks, permission decisions) but the
  transport is an Electron `MessagePort` obtained over `zcode:service-port`. Not reachable from an
  unrelated process except through the Web Remote Control subsystem, whose binding is unknown.
- *Drive the UI* — prohibited by Constitution Article I and brittle by construction.

## R2 — Is there a stable, external, semantic interface?

**Decision**: Yes. `zcode app-server --stdio` is the control plane.

**Evidence**: `ZCODE_RE_FINDINGS.md` §2. CONFIRMED by live execution:
`node zcode.cjs app-server --stdio` accepts `{"id":1,"method":"bogus/method","params":{}}` on stdin
and returns `{"error":{"code":-32601,"message":"Method not found: bogus/method"},"id":1}` on stdout
~1.1 s after launch. `zcode --help` documents the subcommand verbatim as
*"app-server  Run the ZCode Protocol stdio app server"*.

**Alternatives rejected**: reading the agent's SQLite directly (live WAL database, private
migrations — Rating F); the permission broker socket (Windows named-pipe namespace is hard-restricted
to `zcode-cua-helper` — Rating C).

## R3 — Protocol shape and version

**Decision**: Implement the JSON-RPC-2.0-shaped envelope without the `jsonrpc` field, with string
request ids, and assert the protocol identity at first contact.

**Evidence**: `ZCODE_API_CATALOG.md` §1.1. CONFIRMED literals
`Rje = "ZCode Protocol"`, `Pje = 1`; error codes `-32700` parse, `-32600` invalid message,
`-32601` method not found, `-32602` invalid params, `-32603` handler error, `-32004 sessionUnavailable`;
default request timeout 180 000 ms; two transports (`stdio`, `websocket`).

**Consequence for implementation**: the envelope is simple enough to hand-roll; no RPC library is
needed, which keeps the dependency surface at four packages.

## R4 — Provider bootstrap (the gating unknown)

**Decision**: Generate a minimal model config for the child and inject the API key through the child's
**environment**, never writing a secret to disk.

**Evidence**: `ZCODE_UNKNOWNS.md` U-3 (resolved statically). CONFIRMED from `zcode.cjs`:
the model config lives at the top-level `model` key, with sources resolved **project-first then
user** (`~/.zcode/cli/config.json` by default); shape is
`{model:{main:{provider,model,kind,baseURL,apiKey?,apiKeyRequired?,headers?,providerOptions?}, lite?, available?[]}}`;
`kind ∈ {anthropic, openai, openai-compatible}` and `openai-compatible` requires `baseURL`.
API key resolution order is `OPENAI_API_KEY` → `ANTHROPIC_API_KEY` → `<PROVIDERNAME>_API_KEY` →
`<PROVIDER>_API_KEY` → `ZCODE_API_KEY`.

**Alternatives rejected**:
- *Reuse the desktop's provider registry from `~/.zcode/v2/config.json`* — it contains **plaintext**
  API keys (CONFIRMED, values redacted throughout this repo). Copying them into work-tree files would
  spread secrets and violate Article IV.
- *Reuse the OAuth token from `~/.zcode/v2/credentials.json`* — reading its values is prohibited by
  Article IV, and its protection status is still unknown (U-4).
- *Require the user to hand-edit `~/.zcode/cli/config.json`* — kept as the documented manual fallback
  if generated-config delivery proves unreliable, since it needs no code from us.

**Residual risk**: *how* to deliver the generated config is not settled (`--settings` was rejected by
the option parser in one probe run — see R9). Three candidates, to be settled by experiment:
project-level config in `<workspace>/.zcode/`, `HOME`/`USERPROFILE` redirection to a per-child dir, or
a re-test of `--settings` with different argument ordering.

## R5 — Which protocol methods are in scope

**Decision**: Depend on a fixed, enumerated set of methods; keep the rest behind a gated escape hatch.

**Evidence**: `ZCODE_COMMAND_CATALOG.md` §1 — the complete 66-arm dispatch switch, with handler
function names recovered from the runtime's own error stack traces
(`zcode.cjs:3123:78786 dispatchRequest`, `zcode.cjs:3121:123197 queryCommands`).

**Load-bearing methods**: `session/{create,list,read,resume,close,fork,compact,subagents,setModel,
setMode,setThoughtLevel,goal,usage,messages,events,subscribe,stop,cancelBackgroundTask}`,
`workspace/{readState,setDefault*,updateInteractionPreferences,updateModelIoPreferences,
upsertModelProvider,removeModelProvider,updateProviderRegistry,hooks/trustGrant}`,
`v4/command`, `v4/commands/query`, `v4/conversation/{rowsRange,plans,fileChanges,fileRewindPreview,
usage,subscribe,unsubscribe,resync}`, `v4/attachment/{begin,chunk,commit,read,abort,previewSource}`,
`v4/usage/stats`, `interaction/{requestPermission,requestUserInput,requestProviderRuntimeHeaders,
requestOfficialMcpAuthHeaders,browserList,browserExecute}`, `session/requestRuntimePreferences`,
`mcp/list`, `plugins/*`, `automation/*`, `usage/stats`, `skills/referenceCatalog`.

## R6 — Chat: what "success" means

**Decision**: `v4/command` returns **admission**. A chat tool must observe a terminal turn event.

**Evidence**: `ZCODE_COMMAND_CATALOG.md` §1.3. CONFIRMED result shape
`{status:"accepted"|"noop"|"failed", result?, reasonCode?, message?}` with reason codes
`fault.command.notImplemented`, `fault.command.executionFailed`, `proto.payloadTooLarge`; the queue
item model `gP` (`kind ∈ {sendText,sendGoalCommand,compact}`, `delivery.requested ∈
{auto,startNow,queue,guide}`, `dispatch.state ∈ {admitted,queued,reserved,promoting,drained}`,
`steer.state ∈ {notRequested,submitting,steering,guided,fellBack}`); admission is size-checked
against `logicalFrameAssemblyMaxBytes` (16 MiB). `idempotencyTablePerSession: 512` and
`commandPendingTtlMs: 24 h` mean a stable command id makes retries safe.

**Design consequence**: the chat contract carries an explicit `idempotency_key` argument and a
`collect` mode; `accepted` without a terminal event is reported `degraded`, and `noop` is reported as
failure. This is the sharpest expression of Constitution Article II.

## R7 — Approvals: we are the only client, so we must answer

**Decision**: Own a default-deny policy module and an approval tool that can park and resolve
requests.

**Evidence**: `ZCODE_RE_FINDINGS.md` §2.9 (live capture of a server→client request
`{"id":"server-1","method":"interaction/requestOfficialMcpAuthHeaders",…}`) and
`ZCODE_AGENT_ARCHITECTURE.md` §4.2/§4.5. CONFIRMED decision enum
`allow|deny|escalate|modify`, rule behavior `allow|deny|ask`, and that a decision may carry
`permissionUpdates:[{type:"addRules",behavior,rules:[{toolName,ruleContent?}]}]` — i.e. a decision can
persist authority. The host dedupes pending requests by `(workspace,session,requestId)` and fires
`permission.request` only once per key.

**Alternatives rejected**: auto-allow (violates Article V and defeats an intentional security
boundary); never answering (deadlocks the turn — the failure mode that would make the MCP look broken).

## R8 — File mutation belongs to the agent, not to us

**Decision**: Declare "read/write a file as the editor sees it" a **non-capability**. Route mutation
through the agent's own `Write`/`Edit`/`ApplyPatch` tools; expose only file-change and rewind records.

**Evidence**: `ZCODE_UI_MAP.md` §7. CONFIRMED: no protocol method exists for active editor, selection
or document text; the nearest model is the conversation row's file-change record
(`v4/conversation/fileChanges`, `fileRewindPreview`), versioned by `logEpoch` + `revision`, with
`checkpoint.created` / `rewind.triggered` events. File-changing tools trigger part-streaming previews
for `Write`/`Edit` specifically (`resolveZCodeToolProjectionMetadata`).

**Rationale**: only the agent's path produces checkpoints and participates in rewind. A direct
filesystem write from this server would bypass the safety net and be unreviewable.

## R9 — CLI flag reality differs from `--help`

**Decision**: Emit only parser-verified flags; keep the verified set as data with a test.

**Evidence**: `ZCODE_RE_FINDINGS.md` §2.12. CONFIRMED: `--settings` and `--max-turns` appear in
`zcode --help` but are rejected with `Unknown option '--settings'`; `--prompt`, `-p`, `--json`,
`--cwd`, `--help`, `-v` are accepted.

**Open**: the complete accepted-flag set (U-13) — a cheap flag-matrix experiment. Until it runs, the
headless tool emits the verified subset and records the exact command line in `run.command`.

## R10 — Tool budget is a real operational ceiling

**Decision**: 14 tools; warn past a configurable budget.

**Evidence**: the user's own `~/.zcode/cli/mcp-profile.cmd` documents that GLM rejects requests above a
ceiling between **89 and 94** registered tools with `[1210] Invalid API parameter`, and that the full
plugin profile registers ~116 tools versus ~63 trimmed. Live `mcp/list` showed comfyui 4 + remcp 28 +
aseprite 5 + blender 10 + unreal 12 = 59 tools before plugins.

**Consequence**: every tool carries multiple actions rather than one tool per operation, and
`zcode_plugins` computes and warns about the resulting registered-tool count.

## R11 — Concurrency, staleness and identity

**Decision**: Key everything on ZCode's `workspaceKey`; treat conversation reads as
snapshot-plus-token; never cache row identifiers across a `logEpoch` change.

**Evidence**: `ZCODE_STATE_MODEL.md` §1.1, §4. CONFIRMED `buildWorkspaceRef` emits
`{workspacePath, workspaceIdentity?, remoteSessionId?, workspaceKey}` and observed `workspaceKey`
equals the path for local workspaces; staleness markers `proto.staleLogEpoch` and `proto.staleRevision`;
subscription ownership error `fault.subscription.notOwned`; host-side monotonic `seq` assignment with
`eventId` de-duplication and `eventRetentionPerSession: 2000`.

**Residual risk**: whether `workspaceKey` can differ from the literal path (U-8) — relevant because the
runtime registry is keyed on it. Mitigation: obtain the key from ZCode (session list / state read) and
never compute it.

## R12 — Provenance surface for free

**Decision**: Join our audit rows to ZCode's own structured logs by `sessionId`/`turnId`.

**Evidence**: `ZCODE_RE_FINDINGS.md` §7. CONFIRMED daily JSONL
`~/.zcode/cli/log/zcode-YYYY-MM-DD.jsonl` (~25 MB/day) with
`{timestamp,level,event,module,message,traceId,spanId,parentSpanId,sessionId,turnId,toolCallId,
durationMs,status,context{}}`, plus `~/.zcode/cli/rollout/model-io-<sessionId>.jsonl` holding full
model I/O. Observed real turn trace: `turnNumber 87`, `iteration 9`, `messageCount 174`, one `Bash`
call at `durationMs 85855`.

## R13 — There is exactly one local control boundary ✅ RESOLVED (was: "desktop tier deferred")

**Decision**: Ship Tier A (own a runtime) only — and this is now forced, not chosen.

**Evidence**: `ZCODE_UNKNOWNS.md` U-1, resolved to a decisive negative, plus
`.re/findings_ADDENDUM.md` §A16. **CONFIRMED**: the desktop opens **no** local HTTP or WebSocket
listener. Web Remote Control is a pure *outbound* `ws` client to `wss://zcode.z.ai/ws`; the phone or
browser talks to that relay, and the desktop↔host `MessagePort` is tunnelled through it in **binary**
`rpc-frame` fragments — a different protocol from ZCode Protocol v4. The only listeners in the whole
application are:

| # | Bind | Purpose | Usable? |
|---|---|---|---|
| 1 | `127.0.0.1:0` (host only) | remote media-preview proxy, `/__zcode_media/` | no — registered only for remote + `desktop-continuous` attachments |
| 2 | UNIX domain socket | CUA permission broker RPC | no — POSIX-only, single-purpose, guarded |
| 3 | `127.0.0.1:45197` | off-peak mock gateway, E2E only | no |
| 4 | `127.0.0.1:9229` | Chromium CDP, dev builds only | no |

**Alternatives rejected**:
- *Attach to the local desktop* — no listener exists; the only path is impersonating a paired device
  against Z.ai's cloud relay. Out of scope and inappropriate.
- *Attach to a remote ZCode server* — there IS a genuine network-reachable ZCode Protocol surface
  (`GET /api/server-info` advertising `capabilities.websocketRpc: true`, `POST /api/rpc-host-capability`,
  and `wss://<base>/ws/host?token=…` with `Authorization: Bearer` + `x-zcode-rpc-host-capability`).
  But it requires operating a ZCode server component and holding a token: a different product surface,
  not local control. Recorded as a possible future tier, explicitly not v1.

**Consequence**: the design is *simpler* than planned. There is one boundary — stdio to an owned agent
runtime — and it is proven. No transport abstraction is needed for tier switching, and the roadmap has
no deferred desktop-attach step.

**Rationale**: Tier A is available today and provable; Tier B reaches user-visible desktop state,
which is where mistakes are most costly. Ordering Tier A first also produces the read-back and
policy machinery Tier B will need.

---

## Unresolved items carried into the plan

| ID | Item | Blocks | Handling |
|---|---|---|---|
| U-1 | Web Remote Control binding/auth/routes | Tier B only | out of scope for v1 |
| U-2 | `--json` output shape for headless mode | `zcode_headless` result parsing | parse defensively; fall back to raw stdout in the envelope |
| U-5 | full `v4/command` payload schemas for `createSession`/`sendGoalCommand` | `zcode_command execute` | probe `-32602` paths to enumerate required fields before finalising the schema |
| U-8 | `workspaceKey` derivation rules | runtime registry correctness | obtain the key from ZCode, never compute it |
| U-13 | complete set of parser-accepted CLI flags | `zcode_headless` | emit verified subset only; assert as data in tests |

Everything else in `ZCODE_UNKNOWNS.md` is either resolved (U-3) or outside v1 scope.
