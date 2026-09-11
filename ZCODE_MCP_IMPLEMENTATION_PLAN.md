# ZCODE_MCP_IMPLEMENTATION_PLAN.md

Ordered plan from the smallest proof of control to the full `mnehmos.zcode.mcp` server.
Each step is independently verifiable and ends with a gate.

Conventions inherited from `mnehmos.unreal.mcp` (see `AGENTS.md`): TypeScript ESM, `src/{schema,engine,storage}`,
zod contracts, jest unit tests + opt-in integration tests, SQLite provenance, a single
`resultEnvelope`, and the rule *a tool must never report success for something that did not happen*.

---

## Step 0 — Scaffold (½ day)

```
mnehmos.zcode.mcp/
├─ package.json                 name mnehmos.zcode.mcp, bin mnehmos-zcode-mcp, type module
├─ tsconfig.json / tsconfig.test.json
├─ jest.config.js
├─ AGENTS.md  ARCHITECTURE.md  README.md  CHANGELOG.md  HANDOFF.md  LICENSE
├─ src/
│  ├─ index.ts                  MCP server, StdioServerTransport, --self-test
│  ├─ envelope.ts               the shared response envelope
│  ├─ schema/env.ts             environment contract + runtime discovery
│  ├─ schema/tools.ts           zod discriminated unions for all 14 tools
│  ├─ zcode/transport.ts        spawn + NDJSON codec + frame limit + wire log
│  ├─ zcode/protocol.ts         request/notify/respond, timeouts, id allocation
│  ├─ zcode/registry.ts         per-workspaceKey child registry, idle evict, reap
│  ├─ zcode/policy.ts           approval policy + interaction/* responders
│  ├─ zcode/actions/*.ts        one dispatcher per tool
│  ├─ zcode/catalog.ts          baked-in protocol method catalog + read/write flag
│  └─ storage/db.ts             better-sqlite3 provenance
├─ tools/zcode_methods.py       regenerates data/zcode_protocol_methods.json from the bundle
├─ data/zcode_protocol_methods.json
├─ test/*.test.ts
└─ work/                        gitignored: wire/, stdout/, stderr/, reports/
```

`package.json` deps: `@modelcontextprotocol/sdk`, `zod`, `zod-to-json-schema`, `better-sqlite3`.
Scripts: `build`, `typecheck`, `start`, `test`, `test:only`, `test:it`, `methods`, `smoke`
(`node dist/index.js --self-test`).

**Gate:** `npm run build && npm run smoke` prints the discovered runtime path and exits 0.

---

## Step 1 — Prove the transport (1 day) ★ the critical step

Goal: **one NDJSON request, one response, one audit row.** Nothing else.

1. `zcode/transport.ts`: spawn
   `node <zcode.cjs> app-server --stdio --cwd <workspace>` with `stdio:['pipe','pipe','pipe']`.
   - write `` `${JSON.stringify(msg)}\n` ``
   - split stdout on `\n`, `JSON.parse` each non-empty line
   - classify: has `id`+`result` → response; has `id`+`error` → error; has `id`+`method` → server
     request; has `method` only → notification
   - enforce the 1 MiB frame limit **before** write
   - capture stderr separately (do not merge)
   - on exit, kill the owned process group
2. `zcode/protocol.ts`: id counter (`String(n++)`), pending map, per-request timeout
   (default 180 000 ms, matching ZCode's own), `AbortSignal` support.
3. `zcode/registry.ts`: `Map<workspaceKey, Child>` with lazy spawn, `startupMs` grace, idle eviction,
   `maxChildren`.
4. `zcode_status` action `runtimes` and `probe`, plus `zcode_protocol` action `call` restricted to
   `session/list`.

**Verification (already prototyped in `.re/probe.js` — reuse it):**
```
call session/list → expect {sessions:[…]}
call bogus/method → expect {-32601,"Method not found: bogus/method"}
```
**Gate:** an integration test (`ZCODE_MCP_IT=1`) spawns the real runtime, issues `session/list`,
asserts a non-empty `sessions` array, and asserts `proto.frameTooLarge`-style refusal for a >1 MiB
payload **without** spawning.

> This is the whole project's risk. Everything after it is ordinary TypeScript.

---

## Step 2 — Provider bootstrap (1 day) ★ second-critical step

**RESOLVED during reconnaissance** — see `ZCODE_UNKNOWNS.md` U-3.

The agent reads its model config from `config.model`, with sources resolved as
**project first (`sources.project.hasModel`), then user (`sources.user`)**, at
`~/.zcode/cli/config.json` by default. Required shape:

```jsonc
{
  "model": {
    "main":      { "provider": "<id>", "model": "<modelId>",
                   "kind": "anthropic" | "openai" | "openai-compatible",
                   "baseURL": "https://…", "apiKeyRequired": true,
                   "apiKey": "<optional — prefer env>",
                   "headers": {}, "providerOptions": {} },
    "lite":      { /* optional, same shape */ },
    "available": [ /* optional, same shape */ ]
  },
  "network": { "caCertFile": "…", "httpProxy": "…", "noProxy": "…" }   // optional
}
```

**API key resolution order** (`apiKeyEnvCandidates` → `resolveApiKeyFromEnv`):
`OPENAI_API_KEY` (openai kinds) → `ANTHROPIC_API_KEY` (anthropic kinds) →
`<PROVIDERNAME>_API_KEY` → `<PROVIDER>_API_KEY` → `<PROVIDER-without-default-prefix>_API_KEY` →
**`ZCODE_API_KEY`** (always). Normalisation: uppercase, non-alphanumerics → `_`, trim `_`.

Implementation:
1. `schema/env.ts` gains `ZCODE_MCP_MODEL`, `ZCODE_MCP_PROVIDER`, `ZCODE_MCP_BASE_URL`,
   `ZCODE_MCP_MODEL_CONFIG` (path to a ready-made config), and passes
   `ZCODE_API_KEY` / `ANTHROPIC_API_KEY` straight through to the child env.
2. On first spawn the MCP materialises a **generated settings file** in `work/settings/<hash>.json`
   containing only the `model` block, and passes it via the CLI's config discovery — **not**
   `--settings`, which does not parse. The reliable route is to point the child's config discovery
   at our file; verify which of these works in this order:
   a. a project-level config in `<workspace>/.zcode/config.json` (project source is consulted first);
   b. `HOME`/`USERPROFILE` redirection to a per-child dir containing `.zcode/cli/config.json`;
   c. `--settings <path>` — **re-test first**; it was rejected in one probe run and may be
      position-sensitive.
   **Whichever is used, record it in `run.settings` and in the audit row.**
3. Never write the API key into the generated file when an env var can supply it. Default to env.
4. `ZCODE_MCP_REDACT=1` scrubs keys from wire logs and results.

**Gate:** `zcode_status probe` returns a **non-empty** `modelCatalog.available` and
`settings.model.current.modelId !== "missing-model"`.

---

## Step 3 — Read-only tool surface (2 days)

Implement, in this order (each is one dispatcher + one schema case + one unit test):

| Tool | Actions | Protocol |
|---|---|---|
| `zcode_status` | `runtimes`, `workspace`, `sessions`, `probe`, `doctor`, `runs` | `session/list`, `workspace/readState` |
| `zcode_session` | `list`, `get`, `subagents`, `usage` (read-only subset first) | `session/list`, `session/read`, `session/subagents`, `session/usage` |
| `zcode_usage` | `stats` | `usage/stats` |
| `zcode_mcp` | `list`, `servers`, `status` | `mcp/list` |
| `zcode_plugins` | `list`, `overview`, `describe` | `plugins/list`, `overview`, `describe` |
| `zcode_automation` | `list` | `automation/list` |
| `zcode_conversation` | `rows`, `messages`, `events`, `plans` | `session/messages`, `session/events`, `v4/conversation/*` |
| `zcode_protocol` | `methods`, `call` (read-only allowlist) | catalog + raw |

Notes:
- `mcp/list` **starts MCP servers**; label it and report spawned `mcpInstanceId`s.
- `plugins/list` / `mcp/list` require a `workspace`; the schema makes it required for those actions.
- Implement the `logEpoch`/`revision` read-modify-write once, in a helper every conversation action
  shares (`withLogTokens`), including the single retry on `proto.staleLogEpoch` /
  `proto.staleRevision`.
- Every result stores a `work/reports/<runId>.json` and an audit row.

**Gate:** `zcode_status probe`, `zcode_session list`, `zcode_usage stats`, `zcode_mcp list` all
return real data with `ok:true` and non-empty `result`; a schema case exists for every action.

---

## Step 4 — The chat path (2–3 days) ★ the highest-value tool

1. `zcode/events.ts`: subscribe to `session/event` notifications via `session/subscribe`; keep a
   bounded ring buffer per session (`ZCODE_MCP_EVENT_BUFFER`, default 2000) and index by
   `(eventId, seq, type, turnId)`. De-duplicate by `eventId` — the host re-sends on replay.
2. `zcode_chat` action `send`:
   - build `v4/command` envelope
     `{commandId, sessionId, type:'sendText', payload:{text, attachments, delivery, toolDisallowlist}}`
   - `commandId` must be **stable across retries** (the agent keys idempotency on it) — derive it
     from `(sessionId, hash(text), caller-supplied idempotency key)` and expose an
     `idempotency_key` argument.
   - upload local attachments through `v4/attachment/begin|chunk|commit`, then reference their `ref`s.
3. `wait` semantics — **the read-back that matters**:
   - hold until a terminal `turn.completed` / `turn.failed` event for that turn, or
     `until:'idle'` on the projection, or timeout.
   - `collect:'final'` assembles the assistant text from `part.*` events for the turn.
   - if only `status:"accepted"` was observed, return **`ok:true` with
     `warn(impact:'degraded', code:'no_terminal_event')`** — never claim completion.
   - `status:'noop'` / `'failed'` → `ok:false` with the reason code verbatim.
4. `stop`, `cancel_background`, `steer`.
5. `zcode/policy.ts` must be live before any turn runs, or `interaction/requestPermission` will
   deadlock the turn. With `ZCODE_MCP_APPROVAL=deny` (default), denied tools surface as
   `tool.updated status:"denied"` — assert that path in a test.

**Gate:** an integration test runs a real turn with `--mode edit` and a read-only tool
(`tool_allowlist:['Read']`), asserts `ok:true`, `result.text` non-empty, `result.turn.outcome ===
'completed'`, and exactly one audit row. A second test asserts that a `Write` attempt under
`ZCODE_MCP_APPROVAL=deny` returns `ok:false` with a denial reason and **does not** modify the file
(verify by hashing the file before/after).

---

## Step 5 — Mutations with read-back (2 days)

| Tool | Actions | Read-back |
|---|---|---|
| `zcode_session` | `create`, `resume`, `close`, `fork`, `compact`, `set_model`, `set_mode`, `set_thought_level`, `goal` | `session/read` — assert the observed value equals the requested value, else `ok:false` |
| `zcode_settings` | `set_default_*`, `update_interaction_prefs`, `update_model_io_prefs`, `hook_trust_grant` | `workspace/readState` |
| `zcode_settings` | `get`, `set_desktop` | re-read the file; `warn(impact:'advisory', detail:'restart required')` |
| `zcode_automation` | `create`, `update`, `delete`, `check_binding` | `automation/list` |
| `zcode_plugins` | `set_enabled`, `configure`, `reset_config`, `validate` | `plugins/list` / `describe` |
| `zcode_approval` | `respond` | the request id must leave the pending set |
| `zcode_files` | `changes`, `rewind_preview`, `read_attachment`, `put_attachment` | — (reads) |

Guards to implement now (refuse with `reasonCode:'mcp.<guard>.disabled'`):
`ZCODE_MCP_ALLOW_PROVIDER_EDIT`, `ZCODE_MCP_ALLOW_PLUGIN_INSTALL`,
`ZCODE_MCP_ALLOW_MCP_CONFIG_EDIT`, `ZCODE_MCP_ALLOW_PERSIST_RULES`.

Also implement the **tool-budget warning**: after any enablement change, count plugins/MCP tools and
emit `warn(impact:'degraded', code:'tool_budget')` past `ZCODE_MCP_TOOL_BUDGET` (default 88).

**Gate:** every mutating action has a test that (a) performs the mutation, (b) re-reads, (c) fails if
the read-back disagrees. No action returns `ok:true` without a read-back or an explicit degraded warn.

---

## Step 6 — Fallback and hardening (1–2 days)

1. `zcode_headless`: run `zcode --prompt … --json --cwd …`. **Only emit flags verified to parse.**
   Complete the flag matrix experiment (`ZCODE_UNKNOWNS.md` U-13) first and encode the result as a
   constant table with a test; never guess a flag.
2. `zcode_protocol` hardening: allowlist enforcement, mutation gate, method catalog regeneration via
   `tools/zcode_methods.py`, and a startup check that the live protocol name/version match the
   catalog (mismatch → `warn(impact:'degraded')`, not silence).
3. Redaction sweep: a test that feeds a fake `apiKey`/`token` through transport, wire log, envelope
   and audit row and asserts `[REDACTED]` everywhere.
4. Process hygiene: idle eviction test, child-reap test (no orphan processes after `SIGTERM`),
   `maxChildren` enforcement test.
5. `--self-test` covering: runtime discovery, `session/list`, catalog load, DB open, redaction.

**Gate:** `npm run typecheck && npm test && npm run smoke` all green; `ZCODE_MCP_IT=1` integration
suite green; no orphan `node` processes after the suite.

---

## Step 7 — ~~Optional Tier B (attach to the running desktop)~~ ⛔ **CANCELLED**

The audit resolved this to a decisive negative (`.re/findings_ADDENDUM.md` §A16): **the desktop opens no
local HTTP or WebSocket listener.** Web Remote Control is a pure *outbound* `ws` client to
`wss://zcode.z.ai/ws`; the phone/browser talks to that relay, and the desktop↔host `MessagePort` is
tunnelled through it in binary `rpc-frame` fragments.

Attaching to the local desktop would require impersonating a paired device against Z.ai's cloud
relay — out of scope and inappropriate.

A genuine network-reachable ZCode Protocol surface does exist, but for **remote ZCode servers**, not
the local app: `GET /api/server-info` (advertising `capabilities.websocketRpc: true`),
`POST /api/rpc-host-capability`, and `wss://<base>/ws/host?token=…` with `Authorization: Bearer` and
`x-zcode-rpc-host-capability`. **This is postponed indefinitely** — it is a different product surface
requiring a server deployment and a token, and it is not local control.

**Net effect on the plan: one fewer step, and no transport abstraction needed for tier switching.**
The layered design already isolates the wire format behind `src/zcode/transport.ts`, so if the remote
server surface ever becomes interesting, it is an additive change rather than a restructuring.

---

## Milestones

| M | Deliverable | Proof |
|---|---|---|
| M0 | scaffold | `npm run smoke` exits 0 |
| M1 | **transport proven** | `session/list` real data over stdio |
| M2 | **provider proven** | `modelCatalog.available` non-empty |
| M3 | read-only tools | 8 tools returning real data |
| M4 | chat works end-to-end | one real turn, `ok:true`, one audit row |
| M5 | mutations with read-back | every mutation read-back-tested |
| M6 | hardened + fallback | redaction, reaping, budget, flag table tested |
| M7 | optional desktop attach | pending U-1 |

## Sequencing risk

| Risk | Mitigation |
|---|---|
| Provider bootstrap fails (M2) | `zcode_headless` still works if the user configures `~/.zcode/cli/config.json` once by hand; document that as the manual fallback |
| `v4/command` payload schema unknown (U-5) | probe `-32602` paths to enumerate required fields before writing the schema; keep `zcode_command execute` available as the raw path |
| Protocol drift across ZCode versions | catalog regeneration + `protocol.version` check + loud `-32602` handling; never silently swallow |
| Approval deadlock | policy module ships in the same step as chat (Step 4), with a default-deny test |
| Orphaned child processes | owned-process-group kill on every exit path, asserted by test |
| Tool-budget rejection by GLM | 14 tools, budget warning, and a documented "trimmed profile" note |
| Accidentally leaking the user's API key | env-first key injection; redaction test in CI |

## Effort

Steps 0–6: **~9–12 focused days** for one engineer. Step 7 is additional and gated.
The critical path is Steps 1 and 2 — everything else is conventional MCP plumbing.
