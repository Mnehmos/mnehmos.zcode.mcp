---
description: "Task list for ZCode Programmatic Control Surface"
---

# Tasks: ZCode Programmatic Control Surface

**Input**: Design documents from `/specs/001-zcode-control/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/`

**Tests**: Included. Constitution Article VIII makes unit tests and an opt-in integration suite part of
"done"; unlike the optional-tests default, tests here are required.

**Organization**: Grouped by user story so each is independently implementable, testable and
deliverable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: `US1`…`US5`
- Every task names its exact file path

## Path Conventions

Single project: `src/`, `test/`, `tools/`, `data/`, `work/` at the repository root (per `plan.md`).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: a repository that builds, lints and smoke-tests before any ZCode knowledge is encoded.

- [ ] T001 Create the directory tree from `plan.md` → `src/{schema,zcode/actions,storage}`, `test/`, `tools/`, `data/`, `work/`
- [ ] T002 Write `package.json` (name `mnehmos.zcode.mcp`, `type: module`, `bin.mnehmos-zcode-mcp`, deps `@modelcontextprotocol/sdk`, `zod`, `zod-to-json-schema`, `better-sqlite3`; scripts `build`, `typecheck`, `start`, `test`, `test:only`, `test:it`, `methods`, `smoke`)
- [ ] T003 [P] Write `tsconfig.json` and `tsconfig.test.json` (ES2022, NodeNext, strict)
- [ ] T004 [P] Write `jest.config.js` (ts-jest ESM preset, `testPathIgnorePatterns` for integration unless `ZCODE_MCP_IT=1`)
- [ ] T005 [P] Write `.gitignore` covering `node_modules/`, `dist/`, `work/`, `data/audit.db*`, `*.log`
- [ ] T006 [P] Write `LICENSE` (MIT) and a stub `README.md`
- [ ] T007 Write `src/index.ts` skeleton: MCP `Server` + `StdioServerTransport`, empty `ListTools`/`CallTool` handlers, and a `--self-test` branch that prints what it checked and exits
- [ ] T008 [P] Write `test/setup.ts` with fixtures for a fake runtime bundle path

**Checkpoint**: `npm run build && npm run smoke` exits 0 with no ZCode code yet.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: everything US1–US5 depend on. **No user story work begins until this phase is complete.**

**⚠️ CRITICAL**: this phase is where the project's risk lives. T015 is the riskiest task in the plan.

### Contracts and configuration

- [ ] T009 Implement `src/schema/env.ts` — the zod environment contract from `plan.md` §4, including all four opt-in guard flags and the verified-flag table constant for headless mode
- [ ] T010 [P] Write `test/env.test.ts` — defaults, guard-flag parsing, discovery order precedence, missing-workspace failure
- [ ] T011 Implement `src/zcode/catalog.ts` — load `data/zcode_protocol_methods.json`, expose `isMutating(method)`, `isReadOnly(method)`, `matchesAllowlist(method, globs)`, and the protocol identity assertion helper
- [ ] T012 [P] Write `tools/zcode_methods.py` — extract the 66 method names and their `read_only`/`mutating` classification from the installed bundle, writing `data/zcode_protocol_methods.json`
- [ ] T013 [P] Generate `data/zcode_protocol_methods.json` by running T012 against `resources/glm/zcode.cjs`
- [ ] T014 [P] Write `test/catalog.test.ts` — the catalog parses, has the expected namespaces, classifies known read-only vs mutating methods, and a simulated live-version mismatch produces a degraded warning rather than silence

### The transport (highest risk)

- [ ] T015 Implement `src/zcode/transport.ts` — spawn `node <bundle> app-server --stdio --cwd <workspace>` with piped stdio; NDJSON codec (write `JSON.stringify(msg) + "\n"`, split stdout on `\n`); classify each inbound line as response / error-response / server-request / notification; enforce the 1 MiB frame limit **before** write; capture stderr separately; kill the owned process group on every exit path
- [ ] T016 [P] Write `test/transport.test.ts` — NDJSON split across chunk boundaries, multiple frames in one chunk, a frame over 1 MiB is refused without writing, an unparseable line is reported not thrown, and a server-request is classified distinctly from a notification
- [ ] T017 Implement `src/zcode/protocol.ts` — id allocation (monotonic, stringified on send), pending map, per-request timeout (default 180 s), `AbortSignal` support, error mapping to the classes in `contracts/_envelope.md`
- [ ] T018 [P] Write `test/protocol.test.ts` — id allocation, timeout raises the timeout error and clears pending, abort rejects with an abort error, `-32601`/`-32602`/`-32603`/`-32004` map to the documented errors, and a closed transport surfaces `ZCode agent stdio transport is closed`
- [ ] T019 Implement `src/zcode/registry.ts` — `Map<workspaceKey, Runtime>`; lazy spawn; startup grace (`ZCODE_MCP_STARTUP_MS`); idle eviction (`ZCODE_MCP_CHILD_IDLE_MS`); child cap (`ZCODE_MCP_MAX_CHILDREN`); dead-child respawn; graceful shutdown that reaps all children
- [ ] T020 [P] Write `test/registry.test.ts` — reuse for the same key, separate children for different keys, cap enforced, idle eviction closes the child, a dead child is respawned on next use

### Envelope, provenance, redaction

- [ ] T021 Implement `src/envelope.ts` — the `RunOutcome` record and the shared envelope from `contracts/_envelope.md`, with `warnings[].impact` routing and the rule that `ok:true` past a mutating action requires a read-back or an explicit degraded/unreliable warning
- [ ] T022 [P] Write `test/envelope.test.ts` — shape stability, impact routing, error-mapping table, and that a mutating action with no read-back and no warning is rejected by the builder
- [ ] T023 Implement `src/storage/db.ts` — `better-sqlite3` open/migrate against the DDL in `data-model.md` §B3, `recordRun`, `recordArtifact`, `recordProtocolCall`, `recentRuns`
- [ ] T024 [P] Write `test/db.test.ts` — migrations are idempotent, one row per call, artifacts recorded with bytes and sha256, index-backed queries work
- [ ] T025 Implement the redactor (in `src/envelope.ts` or a small `src/zcode/redact.ts`) — `apiKey`, `authorization`, `*token*`, `*secret*`, `*password*` → `[REDACTED]`, applied to wire lines, results and audit rows
- [ ] T026 [P] Write `test/redact.test.ts` — synthetic secrets injected into a wire line, a result object and an audit row are all scrubbed; nested objects and arrays covered; `ZCODE_MCP_REDACT=0` relaxes wire scrubbing but never the settings-tool redaction

### Provider bootstrap

- [ ] T027 Implement `src/zcode/settings.ts` — materialise the child model config (shape from `ZCODE_UNKNOWNS.md` U-3) and deliver it by the first working mechanism, in this order: project-level config in `<workspace>/.zcode/`, `HOME`/`USERPROFILE` redirection to a per-child dir, `--settings` (re-test with alternate argument ordering). Inject the API key through the child **environment** (`ZCODE_API_KEY` / `ANTHROPIC_API_KEY` / `<PROVIDER>_API_KEY`) and never write it to the file
- [ ] T028 [P] Write `test/settings.test.ts` — generated config matches the documented schema; `openai-compatible` without `baseURL` is rejected; the API key is **absent** from the generated file when an env var supplies it; the chosen delivery mechanism is recorded
- [ ] T029 Implement `src/zcode/logtokens.ts` — obtain `logEpoch`/`revision`, issue the request, retry **once** on `proto.staleLogEpoch`/`proto.staleRevision`, then report degraded with both token sets
- [ ] T030 [P] Write `test/logtokens.test.ts` — success path echoes tokens; one stale marker triggers exactly one retry; a second stale marker yields `ok:false` with `stale_after_retry` degraded

### Policy (must exist before any turn can run)

- [ ] T031 Implement `src/zcode/policy.ts` — modes `deny`(default)/`allow`/`ask`/allowlist-file; a pending-request store; responders for `session/requestRuntimePreferences`, `interaction/requestProviderRuntimeHeaders`, `interaction/browserList`, `interaction/browserExecute`, `interaction/requestOfficialMcpAuthHeaders`; wired into the transport's server-request path
- [ ] T032 [P] Write `test/policy.test.ts` — default is deny; allowlist matching on `toolName` and `toolName(ruleContent)`; `ask` parks and lists; each always-answered request kind returns its canned response; a parked request is never left unanswered silently

### Events

- [ ] T033 Implement `src/zcode/events.ts` — subscribe to `session/event` notifications, bounded ring buffer per session (`ZCODE_MCP_EVENT_BUFFER`), de-duplication by `eventId`, ordering by `seq`, plus `waitForTerminalTurn(sessionId, turnId, timeoutMs)`
- [ ] T034 [P] Write `test/events.test.ts` — buffer bound enforced; duplicate `eventId` delivered once; out-of-order `seq` handled; `waitForTerminalTurn` resolves on `turn.completed` and rejects on `turn.failed`, and times out cleanly

### First tool surface

- [ ] T035 Implement `src/schema/tools.ts` — the zod discriminated union for **all 14 tools** (argument contracts only; dispatchers arrive per story), built from `contracts/`
- [ ] T036 [P] Write `test/schema.test.ts` — a minimal valid call for every action of every tool; every action present in the tool's description; budget-check test asserting the tool count
- [ ] T037 Wire `src/index.ts` to `tools.ts` — `ListTools` from zod-to-json-schema, `CallTool` validating then dispatching, with unknown action and invalid params handled before any process work

**Checkpoint**: ⚠️ **T015 and T027 must be proven against the real installation before any user story
proceeds.** Run the `quickstart.md` §2 probe and the §3 provider check manually. If T015 or T027 fails,
stop and resolve it — nothing downstream can be validated without them.

---

## Phase 3: User Story 1 — Ask ZCode's agent to do work and get the result (P1) 🎯 MVP

**Goal**: one tool call goes from prompt to completed turn with the answer text and a tool summary.

**Independent Test**: `quickstart.md` §5 Step 3 — a read-only turn on a scratch directory returns
`ok:true`, `turn.outcome === "completed"`, non-empty text, and exactly one audit row.

### Tests for User Story 1

> Write these first; they must fail before T041–T046 exist.

- [ ] T038 [P] [US1] `test/chat.contract.test.ts` — every row of the success-rule table in `contracts/zcode_chat.md` is asserted: completed → ok; failed → not ok; `noop` → **not ok**; `accepted` + timeout → ok **degraded**; `wait:false` → ok **degraded**; turn mismatch → not ok
- [ ] T039 [P] [US1] `test/chat.idempotency.test.ts` — the same `idempotency_key` produces the same command id and is reported as an idempotent replay; a different key produces a different id
- [ ] T040 [P] [US1] `test/integration.test.ts` (opt-in) — real runtime: a read-only turn reaches a terminal state with non-empty text; one audit row exists; **no orphan `app-server` processes remain after the suite**

### Implementation for User Story 1

- [ ] T041 [US1] Implement `src/zcode/actions/chat.ts` action `send` — build the `v4/command` envelope `{commandId, sessionId, type:'sendText', payload:{text, attachments, delivery, toolDisallowlist}}`; derive `commandId` from `(sessionId, hash(text), idempotency_key)`; subscribe **before** sending so no early events are lost
- [ ] T042 [US1] Add `collect:'final'` assembly — accumulate assistant text from `part.*` events for the turn, summarise tool calls from `tool.updated`, and read usage from the session projection
- [ ] T043 [US1] Add the terminal-observation rule — `waitForTerminalTurn` gates `ok`; the degraded paths from T038 are implemented exactly as specified (this is Constitution Article II in code)
- [ ] T044 [US1] Implement `src/zcode/attachments.ts` — `begin`/`chunk` (≤512 KiB)/`commit` upload with the size and chunk-count guards, used by `send` when an attachment is a local path
- [ ] T045 [US1] Implement actions `stop`, `cancel_background`, `steer`, `wait`
- [ ] T046 [US1] Wire `src/zcode/policy.ts` into the live path and assert that a denied tool appears in `result.turn.tool_calls.denied`

### Tools for User Story 1

- [ ] T047 [US1] Implement `src/zcode/actions/session.ts` actions `create`, `list`, `get` — the minimum needed to obtain a `sessionId`, each with the read-back required by `contracts/zcode_session.md`
- [ ] T048 [US1] Implement `src/zcode/actions/status.ts` action `probe` — the diagnostic entry point (version, doctor, protocol identity, session count)
- [ ] T049 [US1] Implement `src/zcode/actions/approval.ts` — `policy`, `list`, `respond`, so a turn can never deadlock on an unanswered request

**Checkpoint**: US1 is fully functional and independently demonstrable. This is the MVP.

---

## Phase 4: User Story 2 — Inspect what ZCode is doing without disturbing it (P2)

**Goal**: complete, safe read model over ZCode.

**Independent Test**: `quickstart.md` §5 Step 2 — sessions, usage and server config all return real
data, and no turn ran.

### Tests for User Story 2

- [ ] T050 [P] [US2] `test/readonly.test.ts` — every read tool action is asserted to start no turn and mutate nothing (asserted by absence of `turn.started` in the event buffer and unchanged file hashes)
- [ ] T051 [P] [US2] `test/integration.test.ts` (opt-in) — `session/list`, `workspace/readState`, `usage/stats` against the real runtime

### Implementation for User Story 2

- [ ] T052 [P] [US2] `src/zcode/actions/status.ts` — actions `runtimes`, `workspace`, `sessions`, `doctor`, `runs`
- [ ] T053 [P] [US2] `src/zcode/actions/session.ts` — read actions `list` (filters/limits), `get`, `subagents`, `usage`
- [ ] T054 [P] [US2] `src/zcode/actions/usage.ts` — `stats` with the mandatory `range`
- [ ] T055 [P] [US2] `src/zcode/actions/mcp.ts` — actions `list`, `status`, `servers`, including the documented start side effect and the `started[]` reporting
- [ ] T056 [P] [US2] `src/zcode/actions/plugins.ts` — read actions `list`, `overview`, `describe`, `validate`
- [ ] T057 [P] [US2] `src/zcode/actions/automation.ts` — action `list`
- [ ] T058 [US2] `src/zcode/actions/conversation.ts` — actions `rows`, `messages`, `events`, `plans`, all routed through `logtokens.ts`
- [ ] T059 [US2] `src/zcode/actions/protocol.ts` — actions `methods` and `call` with the allowlist and mutation gate enforced

**Checkpoint**: the whole read model is available and provably inert.

---

## Phase 5: User Story 3 — Configure the agent's model, mode and behaviour (P3)

**Goal**: change configuration safely, with read-back and explicit opt-ins.

**Independent Test**: set a mode, read it back, see it change; attempt a provider edit without the
opt-in and assert refusal.

### Tests for User Story 3

- [ ] T060 [P] [US3] `test/settings.readback.test.ts` — every mutating settings action re-reads and fails on mismatch; every protocol-vs-file backend is correctly labelled in `evidence.payload_source`
- [ ] T061 [P] [US3] `test/guards.test.ts` — all four opt-in guard flags refuse with the documented `reasonCode` when unset, and permit when set

### Implementation for User Story 3

- [ ] T062 [P] [US3] `src/zcode/actions/settings.ts` — protocol actions `read_state`, `set_default_model`, `set_default_mode`, `set_default_thought_level`, `update_interaction_prefs`, `update_model_io_prefs`, `hook_trust_grant`
- [ ] T063 [US3] `src/zcode/actions/settings.ts` — file actions `get` (redacted), `set_desktop` (additive patch, backup, re-read, restart warning)
- [ ] T064 [US3] `src/zcode/actions/settings.ts` — guarded provider actions `upsert_provider`, `remove_provider`, `update_provider_registry`
- [ ] T065 [P] [US3] `src/zcode/actions/session.ts` — mutating actions `resume`, `close`, `fork`, `compact`, `set_model`, `set_mode`, `set_thought_level`, `goal`, each with its read-back
- [ ] T066 [US3] `src/zcode/actions/automation.ts` — `create`, `update`, `delete`, `check_binding`, including the 20-cap passthrough and the unattended-authority warning in the tool description

**Checkpoint**: configuration is safe, reversible and honest about when it takes effect.

---

## Phase 6: User Story 4 — Inspect and manage the extension surface (P3)

**Goal**: plugin and MCP server management with the tool-budget hazard surfaced.

**Independent Test**: list plugins and assert known plugins appear with components; enable one and
assert the read-back plus the budget warning.

### Tests for User Story 4

- [ ] T067 [P] [US4] `test/budget.test.ts` — the registered-tool count is computed and the warning fires past `ZCODE_MCP_TOOL_BUDGET`
- [ ] T068 [P] [US4] `test/mcpconfig.test.ts` — the config writer backs up, patches only `mcp.servers.<name>`, preserves `plugins`, and re-reads

### Implementation for User Story 4

- [ ] T069 [P] [US4] `src/zcode/actions/plugins.ts` — mutating actions `set_enabled`, `configure`, `reset_config` with read-back and the budget warning
- [ ] T070 [P] [US4] `src/zcode/actions/plugins.ts` — guarded actions `install`, `update`, `uninstall`, `marketplace`, `cancel_operation`, with progress reporting from `plugins/operationProgress`
- [ ] T071 [US4] `src/zcode/actions/mcp.ts` — guarded `add_server`, `remove_server`

**Checkpoint**: the extension surface is manageable with every hazard disclosed.

---

## Phase 7: User Story 5 — Inspect conversation history and file changes (P3)

**Goal**: review what a past turn did.

**Independent Test**: read rows for an existing session and assert real content; request file changes
for a mutating turn and assert a non-empty change set; request a rewind preview and assert no file
changed.

### Tests for User Story 5

- [ ] T072 [P] [US5] `test/rewind.test.ts` — `rewind_preview` mutates nothing (file hashes unchanged); `rewind_apply` without `confirm:true` is refused
- [ ] T073 [P] [US5] `test/integration.test.ts` (opt-in) — file changes for a turn that wrote a file are non-empty

### Implementation for User Story 5

- [ ] T074 [US5] `src/zcode/actions/files.ts` — actions `changes`, `rewind_preview` (both routed through `logtokens.ts`)
- [ ] T075 [US5] `src/zcode/actions/files.ts` — actions `read_attachment`, `put_attachment` with the size and media guards
- [ ] T076 [US5] `src/zcode/actions/files.ts` — `rewind_apply` with `confirm:true` and a disk read-back of the restored files

**Checkpoint**: history and file changes are reviewable; the one destructive action is explicitly gated.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [ ] T077 `src/zcode/actions/command.ts` — actions `catalog`, `query`, `execute` with the admission-only honesty rule
- [ ] T078 `src/zcode/actions/headless.ts` — `prompt`, emitting **only** verified flags, returning `stdout_raw` always, and warning on unverified arguments
- [ ] T079 Complete the flag-matrix experiment (`ZCODE_UNKNOWNS.md` U-13) and update the verified-flag table plus its test
- [ ] T080 [P] Resolve `ZCODE_UNKNOWNS.md` U-5 by probing `-32602` paths for the remaining `v4/command` payload types, and tighten `src/schema/tools.ts` accordingly
- [ ] T081 [P] Write `AGENTS.md`, `ARCHITECTURE.md`, `HANDOFF.md` and the real `README.md` with the per-tool read-only/mutating table (Constitution Article VII)
- [ ] T082 [P] Write `CHANGELOG.md`
- [ ] T083 Add `--self-test` coverage: runtime discovery, `session/list`, catalog load, DB open, redaction
- [ ] T084 Full gate run: `npm run typecheck && npm test && npm run smoke`, then `ZCODE_MCP_IT=1 npm test`, then assert zero orphan processes
- [ ] T085 [P] Verify `quickstart.md` end-to-end on a clean checkout and fix any step that does not work as written

---

## Dependencies

```
T015 (transport) ─┬─▶ T017 (protocol) ─▶ T019 (registry) ─┬─▶ T027 (provider) ─▶ US1
                  │                                        │
T031 (policy)  ───┴────────────────────────────────────────┘
T035/T037 (schemas + wiring) ─▶ every tool action
US1 ─▶ US2 ─▶ US3 ─▶ US4 ─▶ US5        (each is independently demonstrable)
```

- **T015 and T027 are the critical path.** Both must be proven against the real installation before
  any user story is called done.
- T031 (policy) must exist before any turn runs, or turns deadlock — it is Phase 2, not Phase 3.
- US2 has no dependency on US1 beyond the shared foundation, so it may be developed in parallel by a
  second engineer.

## Parallel execution

- Phase 2: T010, T012, T016, T018, T020, T022, T024, T026, T028, T030, T032, T034, T036 are all `[P]`
  (test files, no shared writes).
- Phase 4 (US2): T052–T059 are seven separate action modules — fully parallel.
- Phase 5 (US3): T062, T065, T066 are parallel; T063/T064 extend a file T062 creates.
- Phases 6 and 7 are largely parallel once T035/T037 exist.

## Implementation strategy

1. **MVP first**: Phase 1 → Phase 2 → Phase 3. Ship a server that can run one non-mutating turn and
   honestly report its outcome. That single capability is the whole thesis of the project.
2. **Then read broadly**: Phase 4 makes the server useful for monitoring and is the safest increment.
3. **Then mutate carefully**: Phases 5–7, each mutation with its read-back and its guard.
4. **Polish last**: Phase 8, including the two open experiments (U-13, U-5) which are cheap and can be
   slotted anywhere.

**Stop conditions** (do not proceed past these without resolving):
- T015 fails → the transport assumption is wrong; re-read `ZCODE_RE_FINDINGS.md` §2 before building
  anything else.
- T027 fails by all three delivery mechanisms → fall back to documenting the manual
  `~/.zcode/cli/config.json` edit (`quickstart.md` §3) and continue; the design does not depend on
  automated bootstrap.
- Any mutating action cannot be given a read-back → do not ship it; move it behind `zcode_protocol`
  where it is explicitly marked `unreliable`.
