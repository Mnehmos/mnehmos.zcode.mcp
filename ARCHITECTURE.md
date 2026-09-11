# Architecture

The shape of a call, and why each layer exists. This document describes **`mnehmos.zcode.mcp`**;
for ZCode's own architecture see `ZCODE_ARCHITECTURE.md`.

## The shape of a call

```
MCP client
   │  tools/call { tool, action, ...args }
   ▼
src/index.ts                  schemaFor(tool) → zod discriminated union
   │                          (an invalid action never reaches a child process)
   ▼
src/schema/tools.ts           the whole argument contract, one union per tool
   │
   ▼
src/zcode/actions/*.ts        one dispatcher per tool
   │                          each builds ZCode Protocol params for its action
   ▼
src/zcode/logtokens.ts        for anything touching a conversation:
   │                          obtain logEpoch + revision, retry once on stale
   ▼
src/zcode/protocol.ts         request / notify / respond, id allocation, timeouts, abort
   │
   ▼
src/zcode/registry.ts         one runtime per workspaceKey; lazy spawn, idle evict, child cap
   │
   ▼
src/zcode/transport.ts        spawn `node <zcode.cjs> app-server --stdio --cwd <ws>`
   │                          NDJSON codec; 1 MiB pre-send check; stderr kept separate;
   │                          owned-process-group kill on every exit path
   ▼
  ┌──────────────────────────────────────────────────────────────┐
  │ ZCode agent runtime (v0.16.5) — an external process, not a lib │
  └──────────────────────────────────────────────────────────────┘
   ▲
   │  server→client requests: interaction/requestPermission, requestUserInput,
   │  requestProviderRuntimeHeaders, requestOfficialMcpAuthHeaders,
   │  session/requestRuntimePreferences, interaction/browser*
   │
src/zcode/policy.ts           answers every one of them, default-deny,
   │                          or parks them for zcode_approval
   ▼
src/zcode/events.ts           session/event notifications → bounded ring, eventId dedupe, seq order
   │                          waitForTerminalTurn(sessionId, turnId) ← the honesty gate
   ▼
src/envelope.ts               { ok, tool, action, mode, runtime, evidence, diagnostics, result, run }
   │                          warnings[].impact ∈ advisory | degraded | unreliable
   ▼
src/storage/db.ts             one row per call + one hashed row per artifact
work/wire/<runId>.ndjson      the exact bytes in and out, redacted
```

## Layer responsibilities

| Layer | Job | Must not |
|---|---|---|
| `schema/` | validate arguments before any side effect | know the wire format |
| `zcode/actions/` | translate a semantic action into protocol calls and a read-back | touch the transport directly |
| `zcode/logtokens.ts` | own the optimistic-concurrency protocol for conversation reads and CAS writes | cache row ids across an epoch change |
| `zcode/protocol.ts` | request/response correlation, ids, timeouts | know what any method means |
| `zcode/registry.ts` | process lifecycle, keyed by ZCode's own `workspaceKey` | invent a key |
| `zcode/transport.ts` | bytes, framing, process hygiene | interpret messages |
| `zcode/policy.ts` | the authority boundary | auto-allow |
| `zcode/events.ts` | notification buffering and terminal-turn detection | claim completion it did not observe |
| `envelope.ts` | one response shape; the read-back rule | let a mutating action pass without evidence |
| `storage/` | provenance | be a source of truth for ZCode state |

**The inversion that matters**: `zcode/` is the *only* place that knows ZCode exists. Nothing above it
mentions a method name, and nothing below it decides what a method means. That is what lets the typed
surface change without touching the transport, and the transport change without touching a tool.

## Why own a runtime instead of attaching to the running app

```
                    rating  reachable today   reaches desktop state
own a runtime  A           yes                no   ← the only local option
attach (WS)    —           IMPOSSIBLE         —    no local listener exists
remote server  B           yes, but remote    yes  different product surface
```

The audit settled this decisively. **The desktop opens no local HTTP or WebSocket listener at all.**
Web Remote Control is a pure *outbound* `ws` client to `wss://zcode.z.ai/ws`; the phone or browser
talks to that relay, and the desktop↔host `MessagePort` is tunnelled through it in **binary**
`rpc-frame` fragments — a different protocol from ZCode Protocol v4. The only listeners in the entire
application are a loopback media-preview proxy (host only, remote sessions only), a UNIX-domain
socket for the CUA permission broker, an E2E-only mock gateway, and a dev-only Chromium debug port.
See `.re/findings_ADDENDUM.md` §A16.

So attaching to the local desktop would mean impersonating a paired device against Z.ai's cloud
relay — out of scope and inappropriate. There *is* a genuine network-reachable ZCode Protocol surface
(`wss://<base>/ws/host` with bearer auth and a capability handshake, advertised by a remote workspace
server), but it is a different product surface, not local control, and is explicitly not v1.

**The conclusion is stronger than a preference: stdio to an owned runtime is the only clean boundary,
and it is proven.**

## The four mechanisms that keep the server honest

1. **Read-back.** Every mutating action re-reads the affected state and reports that. A mismatch is a
   failure, not a warning.
2. **Terminal-turn gating.** `zcode_chat` sets `ok:true` only after observing a terminal
   `turn.completed` / `turn.failed` for the turn it submitted. `status:"accepted"` alone yields
   `warnings:[{code:'no_terminal_event', impact:'degraded'}]`. `noop` is a failure.
3. **Warning impact tags.** `advisory` (proceed), `degraded` (usable but incomplete), `unreliable`
   (do not act). A caller can route on `warnings[].impact` without reading prose.
4. **Policy.** Default-deny approvals, four opt-in guard flags, and an escape hatch that is off by
   default and always marked `unreliable`.

## Protocol facts this architecture is built around

| Fact | Where it bites |
|---|---|
| `v4/command` returns **admission** | the chat tool's entire success rule |
| 17 of 30 v4 command types require `baseRevision` + `baseLogEpoch` | every mutating v4 call is a CAS, hence `logtokens.ts` |
| `v4/commands/query` statuses are `accepted\|rejected\|stale\|duplicate\|noop\|failed`, plus `"unknown"` | the chat tool must distinguish `stale` (wrong tokens) from `duplicate` (idempotency working) |
| Envelope has **no `jsonrpc` field**; ids may be string|number; server→client ids are `server-<n>` | the codec is hand-rolled, so no RPC library dependency |
| 1 MiB inline frame; larger logical frames are fragmented (crc32, ≤16 MiB) | the 1 MiB refusal is a simplicity choice, and its message must say so |
| `--stdio` is a declared no-op; logs go to stderr | never merge stderr into the protocol stream |
| ZCode has no editor document service | `zcode_files` declares non-capabilities instead of faking them |

## Concurrency model

- One runtime per `workspaceKey`, lazily spawned, reused across calls, idle-evicted, capped.
- Requests are correlated by a monotonic id; the runtime itself serialises request handling
  (`session/stop` excepted, which is why cancellation is responsive).
- Notifications are buffered per session in a bounded ring and de-duplicated by `eventId`, ordered by
  `seq`. The host coalesces streaming deltas (~1500 ms) before they reach us, so batched deltas are
  expected.
- Conversation reads and mutating v4 commands share one read-modify-write helper rather than each
  handling staleness separately.

## Failure containment

| Failure | Containment |
|---|---|
| Runtime will not start | fail the call with discovery guidance; no partial state |
| Runtime dies mid-call | transport close is detected, pending requests rejected, child marked dead, next call respawns |
| Runtime hangs | per-request timeout, then the process group is killed |
| Server shuts down | every owned child's process group is killed and verified; the integration suite asserts zero orphans |
| An approval arrives with no policy | default deny; the denial is visible in `zcode_approval list` |
| A payload is too large | refused before send with guidance to the attachment path |
| The protocol drifts | `-32602` is surfaced as `unreliable`, not swallowed; the catalog is re-checked at first contact |
| A hazard is known | disclosed in the tool description, not just the docs |

## Relationship to the reverse-engineering documents

`ZCODE_*.md` is evidence about ZCode. This file and `specs/001-zcode-control/` are design for our
server. When ZCode changes, the audit is re-run (`.re/asar.py`, `.re/probe.js`, `tools/zcode_methods.py`)
and this architecture is updated only where the evidence requires it.
