# mnehmos.zcode.mcp Constitution

<!-- Spec Kit constitution. Ratified 2026-09-11. Every /speckit.plan must pass a Constitution Check
     against these articles before Phase 0 research and again after Phase 1 design. -->

## Core Principles

### I. Semantic Control Only (NON-NEGOTIABLE)

The server controls ZCode through **declared interfaces**, never by imitation.

- Every tool MUST resolve to a named ZCode Protocol method, a declared CLI flag, or a documented
  file format. If a capability has no declared interface, the tool MUST NOT exist.
- Mouse/keyboard/screenshot automation, minified-identifier references, and direct writes to live
  SQLite databases are prohibited.
- Where only UI automation exists (e.g. there is no editor-document API in ZCode), the absence MUST
  be documented as a non-capability and the nearest semantic substitute offered instead.
- The raw protocol passthrough (`zcode_protocol`) is an **explicit escape hatch**: disabled by
  default, allowlisted, and kill-switchable via `ZCODE_MCP_DISABLE_PROTOCOL`.

*Rationale: a UI-driven binding breaks on cosmetic change; a protocol-driven binding breaks only on
protocol change, which is versioned and observable.*

### II. No Success Without Read-Back (NON-NEGOTIABLE)

A tool MUST NOT report success for something that did not happen.

- Every **mutating** action MUST re-read the affected state (`session/read`, `session/list`,
  `workspace/readState`, `plugins/list`, `automation/list`) and report the read-back, not the
  request.
- If the read-back disagrees with the request, the result is a failure.
- If read-back is impossible, the envelope MUST carry
  `evidence.warnings[] = { impact: 'degraded' | 'unreliable' }`.
- `v4/command` returns **admission**, not completion. A chat tool MUST observe a terminal
  `turn.completed` / `turn.failed` event before claiming success. Acceptance alone is `degraded`.
- `status: "noop"` is **not** success.

*Rationale: ZCode's own protocol distinguishes accepted from completed; conflating them would make
the MCP lie about the most consequential operation it performs.*

### III. Schemas Are Contracts

- Every tool argument is validated by a zod discriminated union **before** any process is spawned.
  An invalid action costs zero child processes.
- The protocol version (`"ZCode Protocol"` v1) and the method catalog are checked against the live
  runtime at first contact. A mismatch degrades loudly; it never passes silently.
- Tool argument vocabularies are **closed**: enums, bounded integers, bounded arrays. No free-form
  code, no unbounded strings where an enum will do.
- Envelope keys are the stable contract and MUST NOT be renamed without updating tests and the
  README.

### IV. Secret Handling

- API keys MUST be supplied through the child process **environment**
  (`ZCODE_API_KEY` / `ANTHROPIC_API_KEY` / `<PROVIDER>_API_KEY`), never written to a generated file
  when an environment variable will do.
- `ZCODE_MCP_REDACT=1` is the default and MUST scrub `apiKey`, `authorization`, `*token*`,
  `*secret*`, `*password*` from every wire log, result and audit row.
- `~/.zcode/v2/credentials.json` is **never** read for values, never written, and never relocated.
  Authentication is performed by ZCode's own `login` flow. This holds **even though the cipher is
  weak**: the audit found the AES-256-GCM key falls back to a value derived from the machine's own
  identity rather than from a user secret, so it is reproducible by anyone holding a copy of the file.
  Technical feasibility is not authorization; that finding is reported to the user, not exploited by
  this server.
- Known plaintext-credential locations (`~/.zcode/v2/config.json:provider.*.options.apiKey`) MUST be
  returned redacted by any settings tool.
- Irreversible or authority-expanding operations are gated by explicit opt-in environment variables
  (`ZCODE_MCP_ALLOW_PROVIDER_EDIT`, `ZCODE_MCP_ALLOW_PLUGIN_INSTALL`,
  `ZCODE_MCP_ALLOW_MCP_CONFIG_EDIT`, `ZCODE_MCP_ALLOW_PERSIST_RULES`).

### V. Deny By Default

- The approval policy defaults to `deny`. A tool call that would need human approval in the desktop
  does not silently gain it here.
- Owning an agent runtime means the server receives `interaction/requestPermission`. It MUST answer
  every `interaction/*` request (or park it visibly) so a turn can never deadlock.
- Persisting a durable permission rule is the single most authority-expanding action available and
  therefore requires its own opt-in flag.

### VI. Bounded Resources

- Every spawned process has a documented timeout, an owned process group, and a hard kill on every
  exit path. No orphan processes.
- Child runtimes are capped (`ZCODE_MCP_MAX_CHILDREN`) and idle-evicted.
- Event buffers, wire-log retention, and attachment sizes are all bounded by configuration with
  documented defaults.
- The 1 MiB protocol frame limit is enforced **before** send; larger payloads are routed through the
  attachment channel.

### VII. The Repo Is The Memory

- Every call writes an audit row, and every artifact (wire log, stdout, stderr, report, generated
  settings) lands on disk under `work/` with its bytes and a hash.
- `AGENTS.md`, `ARCHITECTURE.md` and `HANDOFF.md` are updated in the same commit as any change that
  alters how the next agent should work.
- Reverse-engineering findings carry explicit evidence labels
  (**CONFIRMED** / **STRONGLY INFERRED** / **HYPOTHESIS**) and are never upgraded without new
  evidence.

### VIII. Tests Are Reflexes

- Unit tests cover the NDJSON codec, the schema union for every action, the redaction sweep, the
  policy decisions, and the log-token retry.
- Integration tests (opt-in via `ZCODE_MCP_IT=1`) spawn the real runtime and prove: `session/list`
  returns real data; a real turn completes; a denied write does not modify the file (verified by
  hash); no orphan processes remain.
- The flag table for `zcode_headless` is data, and a test asserts it contains only flags verified to
  parse.

## Additional Constraints

### Technology

TypeScript ESM on Node 22; `@modelcontextprotocol/sdk` for MCP; `zod` + `zod-to-json-schema` for
contracts; `better-sqlite3` for provenance; `jest` + `ts-jest` for tests. No additional runtime
dependencies without a documented reason.

### Compatibility Surface

Only these ZCode surfaces may be depended upon:
`ZCode Protocol` methods and envelopes; the `zcode` CLI's documented subcommands and
parser-verified flags; `~/.zcode/cli/config.json`; `~/.zcode/v2/setting.json`; log and rollout JSONL
as read-only observability. Minified identifiers, private SQLite columns, and IPC channel names are
**not** a dependency surface.

### Operational Honesty

Tool descriptions and `README.md` MUST state, per tool, whether it is read-only or mutating, and
which ZCode capability it depends on. Known hazards are documented in the tool description itself —
notably that `mcp/list` starts MCP servers, that desktop settings need a restart, and that
enabling plugins consumes the model's tool budget.

## Development Workflow

```
/speckit.specify  → spec.md   (user stories, FRs, success criteria — no implementation detail)
/speckit.clarify  → resolve [NEEDS CLARIFICATION] markers
/speckit.plan     → plan.md + research.md + data-model.md + contracts/ + quickstart.md
/speckit.tasks    → tasks.md
/speckit.analyze  → cross-check spec ↔ plan ↔ tasks before implementing
/speckit.implement
```

Gates, all of which must pass before anything is called done:

```sh
npm run typecheck
npm test
npm run smoke                     # node dist/index.js --self-test
ZCODE_MCP_IT=1 npm run test:it    # real runtime; asserts no orphan processes
```

## Governance

This constitution supersedes other practices for this repository. Amendments require a documented
rationale and a plan update. Any `/speckit.plan` that violates an article must record the violation
in `plan.md` → Complexity Tracking with the simpler alternative that was rejected and why.

Version: 1.0.0 | Ratified: 2026-09-11 | Last amended: 2026-09-11
