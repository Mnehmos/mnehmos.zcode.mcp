# Changelog

All notable changes to this project. Format follows Keep a Changelog.

## [0.3.0] - 2026-09-11

**All 15 tools implemented.** A probe matrix that calls every tool through the MCP protocol returns
16 successes out of 18 calls, and the two failures are declared capability limitations rather than
bugs.

### Added

- **`zcode_conversation`** — rows, messages, events, plans, usage. The row is the addressable unit;
  `rows` reports the runtime's own `atLogEpoch` / `atSeq` / `hasMore` verbatim, so a caller can
  thread the tokens through without guessing.
- **`zcode_files`** — attachment read/write, and `rewind_apply` implemented as a **fork** (the safe
  form: it keeps the pre-rewind state reachable).
- **`zcode_settings`** — `read_state`, file reads with mandatory redaction, `set_desktop` as an
  additive patch with a timestamped backup, and provider actions behind their own opt-in.
- **`zcode_protocol`** — the escape hatch. Off by default, allowlisted to read-only paths, with
  mutating methods behind a second flag. Every result carries `raw_protocol: unreliable`.
- **`zcode_headless`** — one-shot CLI runs, emitting **only** flags verified to parse.

### Two declared capability limitations

`zcode_automation`, and `zcode_files changes` / `rewind_preview`, resolve to methods that exist in the
protocol but need a host tier an owned runtime does not have:

| method | what happens | why |
|---|---|---|
| `automation/*` | `-32601 Method not found` | scheduling appears to be host-side |
| `v4/conversation/fileChanges` | `baseRevision` unobtainable | every derivable revision is rejected with `proto.staleRevision`, while `baseLogEpoch` IS obtainable and accepted |

Both are reported with `impact: unreliable` and a named reason. **A retry loop that can never succeed
is worse than a named gap** — it looks like flakiness and hides a real boundary.

### Fixed - four defects the tool matrix caught

- `zcode_headless` was a separate process that did not inherit `ZCODE_MCP_*`, so it failed with
  "Model config is missing" even though the server was fully configured. It now bootstraps the CLI's
  own provider environment exactly as a spawned runtime does.
- Conversation row ids are **numbers**. The schema declared a string, and `fileChanges` rejects `"1"`.
- `target` also needs `entityId`, now resolved from a `rowsRange` call: one read yielding both the
  target and the tokens, rather than leaking the internal row shape into the tool contract.
- Read-only actions were warning about read-back, the wrong signal for something with nothing to
  verify. `Outcome.readOnly()` marks it not-applicable silently.

### Tests

177 across 10 suites. New assertions pin what would silently rot: that `buildHeadlessArgs` **never**
emits the four flags the CLI advertises but its parser rejects; that the protocol allowlist cannot
let a wildcard escape its namespace; and that `redactDeep` does not mutate its input.

## [0.2.0] - 2026-09-11

**The first release that can actually drive ZCode.** A real agent turn runs end to end through an
MCP tool call.

### Added — the server works

- **`zcode_status`** — `probe` / `workspace` / `sessions` / `runtimes` / `doctor` / `runs`.
  `probe` is the diagnostic entry point: runtime identity, protocol version and session count in
  one round trip, no turn started.
- **`zcode_session`** — list / get / create / resume / close / fork / compact / set_model /
  set_mode / set_thought_level / goal / subagents / usage. Every mutating action re-reads the
  session and compares the field it changed; a mismatch FAILS the call.
- **`zcode_chat`** — send / steer / stop / cancel_background / wait. Create-and-send in one
  command, subscribe before waiting, and a terminal-event gate on success.
- **`zcode_models`** — the model/provider decision surface: a filterable catalogue of 10 providers
  and 130 models with context windows, modalities and reasoning levels, annotated with whether this
  server holds a credential for each. Deliberately unranked — choosing is the caller's job.
- **`zcode_approval`** — policy / list / respond, with deny-by-default and a separately gated path
  for durable permission rules.

### Added — infrastructure

- `.env` workflow with `.env.example`: provider credentials resolved from the environment,
  loaded explicitly via `npm run start:env` (never auto-read).
- **Credential isolation**: a spawned runtime inherits everything *except* credential-shaped
  variables, then receives back only the single resolved key. With several providers in one `.env`,
  the runtime previously received all of them.
- `tools/scan_secrets.py`, now the **first gate**: it collects the machine's real secrets and
  searches every git object and commit message for them.
- The addendum grew to 21 sections, including A13–A21: the credential-cipher weakness, the
  environment-only provider bootstrap, the Web Remote Control negative result, and the two
  ordering mistakes this milestone turned on.

### Verified

```
npm run scan:secrets     CLEAN
npm run typecheck        clean
npm test                 159/159  across 9 suites
npm run smoke            PASS
ZCODE_MCP_IT=1 npm test  7/7      against the real runtime
```

A real turn, through the tool:

```
zcode_chat send { text: "Reply with exactly the token M4-FINAL…" }
  ok = true            took 12.6s
  turn  = {outcome: completed, result_type: success, tool_calls: {total: 0}}
  text  = "M4-FINAL"
```

### Two mistakes worth recording

1. **The wrong create path.** `session/create` followed by a separate `sendText` is not how the
   platform creates a session. It writes the record and admits the first input as ONE command.
   Splitting them admitted input into a session with no database row → foreign-key failure. The row
   only appears when the session is first used, by design (`ensureSessionPersisted`, called from
   turn-start paths only).
2. **No subscription, so no events.** A turn can start *and complete* while the client sees nothing.
   Two hours went into believing a turn had failed when it had succeeded nine seconds in.

### Fixed

- A real API key had been committed inside a test fixture, because it looked synthetic. Removed and
  rotated; the scanner exists so the check is mechanical rather than a judgement call.
- Workspace keys are canonicalised: the same directory arriving with forward slashes and backslashes
  produced a false mismatch warning.
- `recentRuns` ordered by a millisecond timestamp, so two calls in the same millisecond came back
  arbitrarily; also never selected the `warnings` column it was writing.
- The redactor's key matcher was a substring regex, which missed `zcodejwttoken` while matching
  `sessionId` — both directions wrong.

### Still not implemented

Ten of fifteen tools refuse clearly by name: `zcode_conversation`, `zcode_files`, `zcode_command`,
`zcode_settings`, `zcode_plugins`, `zcode_mcp`, `zcode_automation`, `zcode_usage`,
`zcode_headless`, `zcode_protocol`.

## [0.1.0] - 2026-09-11

### Added — reverse-engineering audit

A complete architecture reconstruction of **ZCode Desktop 3.11.2** (agent runtime **0.16.5**),
produced by ASAR extraction, static bundle analysis, live process inspection, JSONL log analysis, and
live NDJSON protocol probing.

- `ZCODE_ARCHITECTURE.md` — the three-tier reconstruction (Electron shell / host broker / headless
  agent runtime), processes, end-to-end flows, and the architectural boundaries actually observed.
- `ZCODE_COMPONENT_MAP.md` — every process, service, module and dependency, with a process diagram and
  the full filesystem layout.
- `ZCODE_API_CATALOG.md` — 66 agent-protocol methods with handler names, 129 shell IPC channels, the
  host RPC namespace, the v4 subscription gateway, the permission-broker NDJSON protocol, 31 Z.ai
  control-plane endpoints, and the environment-variable interface.
- `ZCODE_COMMAND_CATALOG.md` — all six command/event registries, 25 session-event types, the 30+ agent
  tool registry, the bilingual bot command language, and per-command MCP suitability ratings.
- `ZCODE_UI_MAP.md` — UI surfaces mapped to internal actions, plus the confirmed absence of an editor
  document API.
- `ZCODE_STATE_MODEL.md` — the split state model (agent / desktop / renderer), every entity, the
  persistence map, and safe-write rules.
- `ZCODE_AGENT_ARCHITECTURE.md` — model providers, revision-ordered registry sync, the turn lifecycle
  with real trace samples, tool invocation, the three permission systems, subagents, and MCP pooling.
- `ZCODE_CONTROL_SURFACES.md` — every surface ranked A–F, plus a control-surface matrix covering ~60
  operations.
- `ZCODE_RE_FINDINGS.md` — the evidence log, with CONFIRMED / STRONGLY INFERRED / HYPOTHESIS labels and
  a record of every action taken against the live system.
- `ZCODE_UNKNOWNS.md` — open questions, each with the experiment that would settle it.
- `ZCODE_MCP_SPEC.md`, `ZCODE_MCP_IMPLEMENTATION_PLAN.md` — the initial design and build order.
- `.re/findings_cli_bundle.md` — a 55 KB byte-offset-indexed deep report on the CLI bundle.
- `.re/findings_ADDENDUM.md` — **corrections from a second pass**, authoritative over the documents
  above where they conflict.

### Added — specification (Spec Kit)

- `.specify/memory/constitution.md` — eight articles, with "semantic control only", "no success without
  read-back", "schemas are contracts" and "secret handling" non-negotiable.
- `specs/001-zcode-control/spec.md` — five prioritized user stories, 45 functional requirements, 12
  measurable success criteria.
- `specs/001-zcode-control/plan.md` — technical context, a Constitution Check that passes with no
  violations, and the project structure.
- `specs/001-zcode-control/research.md` — 13 decisions, each with the evidence and the alternatives
  rejected.
- `specs/001-zcode-control/data-model.md` — external entities (owned by ZCode) and internal entities
  (owned by this server), plus the state transitions that matter.
- `specs/001-zcode-control/contracts/` — the shared envelope and one contract per tool (15 files),
  each naming its underlying protocol method, failure modes, permission implications and read-back.
- `specs/001-zcode-control/quickstart.md` — clone to first successful call, with ordered checkpoints
  that double as the acceptance test.
- `specs/001-zcode-control/tasks.md` — 85 tasks in 8 phases, grouped by user story, with the critical
  path and stop conditions identified.

### Changed (corrections made during the audit)

- `--stdio` is a **declared no-op**; framing is unconditional and `app-server` sends logs to stderr.
- The accepted CLI flag set is exactly **21 flags** plus a `--disallowed-tools` pre-pass;
  `--settings`, `--max-turns`, `--allowed-tools`, `--permission-mode` and `--allow-main-worktree-yolo`
  are advertised but not parsed.
- Headless output is controlled by `--output-format text|json|stream-json`; `stream-json` terminates
  with a `{"type":"result", …}` line.
- The v4 wire version is **3**, not 1, and `v4/command` has **30** command types, 17 of which require
  compare-and-swap tokens.
- `v4/commands/query` returns five statuses (`accepted`/`rejected`/`stale`/`duplicate`/`noop`/`failed`)
  plus a bare `"unknown"`, and accepts up to 64 entries.
- There is **no WebSocket server** in `zcode.cjs`; the `websocketRpc` descriptor is client-side.
- Logical frames over 1 MiB are **fragmented** (crc32, ≤1024 fragments, ≤16 MiB), so the MCP's 1 MiB
  refusal is a design choice rather than a protocol ceiling.
- The agent's model config lives under the top-level `model` key, is resolved project-first, and its
  API key may come entirely from the environment.

### Security

- Documented that `~/.zcode/v2/config.json` stores provider API keys in **plaintext**. Every observed
  value was redacted from every artifact in this repository, and the constitution requires the
  settings tool to redact them in its output.
- Documented the permission broker's peer-credential checks and the Windows named-pipe namespace
  restriction that prevents it being repurposed as a general control channel.

### Added — implementation (milestone M1)

The transport is proven against the real ZCode runtime, not asserted.

- `src/schema/env.ts` — environment contract, runtime discovery (including fixed drive roots,
  because a ZCode install is commonly a directory at a drive root), the four opt-in guard flags,
  and the table of CLI flags **verified to parse**.
- `src/schema/tools.ts` — all **14** tool/action contracts as zod discriminated unions. Tool
  descriptions carry the known hazards, because a hazard disclosed only in the README is
  invisible to the model calling the server.
- `src/zcode/redact.ts` — secret scrubbing by key name *and* by value shape.
- `src/zcode/transport.ts` — the stdio transport: NDJSON codec, 1 MiB pre-send frame refusal,
  stderr kept separate (the runtime logs there), owned-process-group kill verified on exit.
- `src/index.ts` — MCP server skeleton plus a `--self-test` that exercises the control plane
  and asserts it cleaned up.

**Verified**
```
npm run typecheck                                    clean
jest test/transport.test.ts                          14/14
node dist/index.js --self-test                       PASS   runtime found, 23 sessions
ZCODE_MCP_IT=1 jest test/integration.test.ts          5/5   against the real runtime
```
The integration suite proves: discovery, `session/list` returning 23 real sessions, `-32601` for
an unknown method, refusal of an oversized frame before writing, and **no orphan process after
dispose** (pid confirmed gone via `tasklist`). No model turn is run, so proving M1 costs nothing.

**Not yet implemented:** `protocol.ts`, `registry.ts`, the response envelope, the audit database,
the approval policy, event buffering, and every tool dispatcher. Tools that are declared but have
no dispatcher refuse clearly rather than pretend.

**Two deliberate deviations from the plan**
1. `node:sqlite` replaces `better-sqlite3` — the same API the runtime itself uses, and it removes
   the only native build dependency on Windows.
2. 14 tools with action unions rather than one tool per operation, because the provider rejects
   requests above roughly 89–94 registered tools with `[1210] Invalid API parameter`.

### Notes

- No file outside this repository was modified during the audit. Two harmless `--prompt` attempts both
  failed before any model call, so no API spend was incurred.
- The MCP server is **partially implemented**: the control plane is proven (M1). The tool
  dispatchers are not. `specs/001-zcode-control/tasks.md` is the build order, and T027 (provider
  bootstrap) gates every path that costs money.
- Branch model is gitflow: `main` is release-only, `develop` integrates, `feature/*` carries one
  task cluster each. See `AGENTS.md`.
