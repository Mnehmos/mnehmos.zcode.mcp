# Changelog

All notable changes to this project. Format follows Keep a Changelog.

## [Unreleased]

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

### Notes

- No file outside this repository was modified during the audit. Two harmless `--prompt` attempts both
  failed before any model call, so no API spend was incurred.
- The MCP server itself is **not implemented**. `specs/001-zcode-control/tasks.md` is the build order.
