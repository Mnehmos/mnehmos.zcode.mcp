# Implementation Plan: ZCode Programmatic Control Surface

**Branch**: `001-zcode-control` | **Date**: 2026-09-11 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-zcode-control/spec.md`

**Note**: Filled in by `/speckit.plan`; the execution workflow is described in the planning command.

## Summary

Build `mnehmos.zcode.mcp`: an MCP server that controls ZCode by **owning a ZCode agent runtime
process per workspace and speaking ZCode Protocol v1 over NDJSON on stdin/stdout**. The server
exposes 14 tools with discriminated-union actions, validates every argument with zod before spawning
anything, answers the runtime's own approval requests under a default-deny policy, and reports every
mutation by reading the resulting state back from ZCode rather than trusting the request.

The protocol has 66 methods; the schedule in `tasks.md` is ordered so that a caller can complete a
real agent turn (the P1 journey) before any convenience tool exists.

## Technical Context

**Language/Version**: TypeScript 5.8 targeting ES2022, Node 22 (ESM, `"type": "module"`)

**Primary Dependencies**: `@modelcontextprotocol/sdk` (server + stdio transport), `zod` (contracts),
`zod-to-json-schema` (tool input schemas), `better-sqlite3` (provenance). Zero further runtime
dependencies; the ZCode runtime itself is an external process, not a package dependency.

**Storage**: SQLite at `data/audit.db` via `better-sqlite3` — three tables (`runs`, `artifacts`,
`protocol_calls`). Bounded on-disk artifacts under `work/` (`wire/`, `stdout/`, `stderr/`,
`settings/`, `reports/`).

**Testing**: `jest` 29 with `ts-jest`; ESM via `--experimental-vm-modules`. Unit tests are the
default; integration tests that spawn the real ZCode runtime are opt-in behind `ZCODE_MCP_IT=1`.

**Target Platform**: Windows x64 first (developer workstation), POSIX-compatible by construction —
the only platform-specific behaviour is process-group termination and Node bundle path resolution.

**Project Type**: Single project — one MCP server process, no frontend, no service split.

**Performance Goals**: First protocol response within ~5 s of a cold spawn (measured baseline: the
runtime answers its first request ~1.1 s after launch; the remainder is discovery and settings
materialisation). Steady-state tool overhead under 50 ms excluding ZCode's own work. No busy polling:
everything is request/response plus bounded event buffering.

**Constraints**: 1 MiB protocol frame limit enforced before send; ≤2 concurrent runtimes by default;
per-request timeout 180 s default with a 30 s cold-start grace; event buffer 2000 notifications per
session; tool count must stay well inside the model provider's accepted budget (~89–94 registered
tools total across all servers, per the user's own `mcp-profile.cmd`).

**Scale/Scope**: 14 MCP tools; ~45 tool actions; 66 protocol methods behind them; 3 SQLite tables;
1 external dependency process per workspace. Roughly 9–12 focused engineering days to M6.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Article | Gate | Status |
|---|---|---|
| I. Semantic Control Only | Every tool maps to a ZCode Protocol method, a parser-verified CLI flag, or a documented config file. No UI automation, no minified identifiers, no live-DB writes. The raw passthrough is disabled by default and kill-switchable. | **PASS** — see `contracts/`; each contract names its protocol method |
| II. No Success Without Read-Back | Every mutating action re-reads and fails on contradiction; chat requires a terminal turn event; `noop` is not success. | **PASS** — encoded as FR-012/FR-043 and as a per-tool `read_back` field in the contracts |
| III. Schemas Are Contracts | zod discriminated unions validated before spawn; closed vocabularies; protocol version checked at first contact; loud on drift. | **PASS** — one schema module, one test file per tool |
| IV. Secret Handling | Key supplied via child environment; redaction on by default; credential store untouched; four opt-in guard flags. | **PASS** |
| V. Deny By Default | Approval policy defaults to deny; every `interaction/*` request is answered or visibly parked; durable rules need opt-in. | **PASS** |
| VI. Bounded Resources | Timeouts, owned process groups, hard kill on all exit paths, child cap, idle eviction, bounded buffers, pre-send frame check. | **PASS** |
| VII. The Repo Is The Memory | Audit row per call plus hashed artifacts; findings labelled with evidence strength; three living docs updated in the same commit. | **PASS** |
| VIII. Tests Are Reflexes | Unit tests for codec, schemas, redaction, policy, log-token retry; opt-in integration proving real turn, denial-without-side-effect by file hash, and zero orphans; flag table asserted as data. | **PASS** |

No violations. Complexity Tracking is therefore empty.

**Post-Phase-1 re-check**: still passing. The one design decision that could have violated Article I
was resolving the "editor document API" gap; the plan instead declares it a **non-capability** and
routes file mutation through the agent's own tools (`contracts/zcode_files.md`, Non-capabilities).
The one that could have violated Article IV was provider provisioning; resolved by the discovered
environment-variable key path (`ZCODE_API_KEY` / `ANTHROPIC_API_KEY` / `<PROVIDER>_API_KEY`), so no
secret is written to disk.

## Project Structure

### Documentation (this feature)

```text
specs/001-zcode-control/
├── plan.md              # This file (/speckit.plan output)
├── spec.md              # Feature specification (/speckit.specify output)
├── research.md          # Phase 0 output — condensed findings + pointers to the RE archive
├── data-model.md        # Phase 1 output — entities, identities, version tokens
├── quickstart.md        # Phase 1 output — clone → first successful call
├── contracts/           # Phase 1 output — one contract per tool
│   ├── _envelope.md
│   ├── zcode_status.md
│   ├── zcode_session.md
│   ├── zcode_chat.md
│   ├── zcode_conversation.md
│   ├── zcode_files.md
│   ├── zcode_command.md
│   ├── zcode_settings.md
│   ├── zcode_plugins.md
│   ├── zcode_mcp.md
│   ├── zcode_automation.md
│   ├── zcode_usage.md
│   ├── zcode_approval.md
│   ├── zcode_headless.md
│   └── zcode_protocol.md
└── tasks.md             # Phase 2 output (/speckit.tasks output)
```

The reverse-engineering archive sits at the repository root (`ZCODE_*.md`) because it is evidence
about ZCode, not about this feature, and is referenced by `research.md`.

### Source Code (repository root)

```text
src/
├── index.ts                     MCP server entry; ListTools/CallTool wiring; --self-test
├── envelope.ts                  the shared response envelope + warning impact tags
├── schema/
│   ├── env.ts                   environment contract; runtime discovery; guard flags
│   ├── tools.ts                 the zod discriminated union per tool (the whole argument contract)
│   └── protocol.ts              zod schemas for protocol params/results we depend on
├── zcode/
│   ├── transport.ts             spawn; NDJSON codec; frame limit; wire log; process-group kill
│   ├── protocol.ts              request/notify/respond; id allocation; timeouts; abort
│   ├── registry.ts              workspace-keyed runtime registry; idle eviction; child cap
│   ├── policy.ts                approval policy; answers interaction/* and session runtime prefs
│   ├── events.ts                notification subscription; bounded ring buffer; seq/eventId dedupe
│   ├── logtokens.ts             logEpoch/revision read-modify-write with single retry
│   ├── attachments.ts           begin/chunk/commit upload; read; size guards
│   ├── settings.ts              generates the child model config; env-first key injection
│   ├── catalog.ts               baked-in protocol method catalog + read/mutating classification
│   └── actions/                 one dispatcher per tool
│       ├── status.ts  session.ts  chat.ts  conversation.ts  files.ts  command.ts
│       └── settings.ts plugins.ts mcp.ts automation.ts usage.ts approval.ts
│           headless.ts protocol.ts
└── storage/
    └── db.ts                    better-sqlite3 provenance

test/
├── setup.ts
├── env.test.ts                  discovery order, guard-flag parsing, defaults
├── schema.test.ts               minimal valid call for every action of every tool
├── transport.test.ts            NDJSON split/join, frame-limit refusal, classification
├── protocol.test.ts             id allocation, timeout, abort, error mapping
├── events.test.ts               ring buffer bound, eventId dedupe, seq ordering
├── logtokens.test.ts            single retry on stale markers, then degraded
├── policy.test.ts               default-deny, allowlist, park-and-list, preference answers
├── envelope.test.ts             shape stability, warning impact routing
├── redact.test.ts               synthetic secrets never survive to wire/log/result/db
├── catalog.test.ts              catalog parses; live-version mismatch degrades
├── headless.test.ts             flag table contains only verified flags
└── integration.test.ts          opt-in (ZCODE_MCP_IT=1): real runtime, real turn,
                                 denial-without-side-effect, zero orphans

tools/
└── zcode_methods.py             regenerates data/zcode_protocol_methods.json from the bundle

data/
├── audit.db                     provenance (gitignored)
└── zcode_protocol_methods.json  the baked-in protocol method catalog

work/                            gitignored: wire/, stdout/, stderr/, settings/, reports/
```

**Structure Decision**: Single project. The MCP server is one process with one responsibility; there
is no frontend and no service boundary to justify a multi-project layout. The internal split follows
the sibling convention (`src/schema` for contracts, `src/<domain>` for the adapter, `src/storage` for
provenance) with `zcode/` playing the role `engine/` plays in the Unreal server: all knowledge of the
external system lives behind it, and nothing above it knows the wire format.

## Phase plan

| Phase | Output | Exit gate |
|---|---|---|
| 0 | `research.md` — consolidated findings, all `[NEEDS CLARIFICATION]` resolved or recorded in `ZCODE_UNKNOWNS.md` | every assumption in `spec.md` has an evidence label |
| 1 | `data-model.md`, `contracts/`, `quickstart.md` | every tool action has a named underlying protocol method or a declared non-capability |
| 2 | `tasks.md` | tasks grouped by user story; P1 story independently deliverable |
| 3 | implementation | `npm run typecheck && npm test && npm run smoke`, then `ZCODE_MCP_IT=1` green with zero orphans |

## Complexity Tracking

> No Constitution Check violations. This section is intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| _(none)_ | | |
