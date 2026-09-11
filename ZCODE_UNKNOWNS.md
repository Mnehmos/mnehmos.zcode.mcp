# ZCODE_UNKNOWNS.md

> **⚠ Read `.re/findings_ADDENDUM.md` first.** A second deep static pass over the CLI bundle, and two
> further deep-dives, superseded most of the entries below. **U-1, U-2, U-3, U-4, U-8, U-11, U-12 and
> U-13 are RESOLVED**; **U-5 is largely resolved**. Notably **U-1 resolved to a decisive negative** —
> the desktop opens no local listener, so "attach to the running desktop" is not buildable at all.
> The entries below are retained for the reasoning trail; the addendum is authoritative.

Remaining unanswered questions, each with the exact experiment that would resolve it.
Ordered by how much the answer changes `mnehmos.zcode.mcp`.

---

## U-1 — Web Remote Control: binding, routes, auth, pairing ⬤ HIGH

**Question.** What does `zcode:start-web-remote-control` actually create? Which address/port does it
bind (fixed? ephemeral? loopback only? TLS?), what are the HTTP/WS routes, how does pairing work,
where is the credential stored, and what is the wire schema of the remote transport?

**Why it matters.** It is the only path to **Tier B** (desktop-owned state: tasks, open workspaces,
the live provider registry, and the ability to answer permission prompts for the *user's* window).
It also determines whether an external MCP can attach to an already-running ZCode instead of owning
its own runtime.

**What is already known (CONFIRMED).**
- IPC channels: `start/stop/get-status/reset-pairing-web-remote-control`,
  `web-remote-control-status-changed`, `sync-web-remote-control-{workspaces,tasks}`,
  `web-remote-control-reconnect-workspace`.
- The host accepts `clientMode: "desktop-continuous" | "web-remote-replayable"` on
  `attach-service-port`. `replayable` implies resumable-from-`seq` delivery, which only makes sense
  over a network transport.
- A remote server descriptor exists advertising `protocolVersion: 1`, `authRequired`,
  `workspaces[]`, `capabilities: {desktopContinuous, websocketRpc}`.
- **No ZCode process currently listens on any TCP port** on this machine → the feature is off by
  default, or binds only while running.

**Experiment.**
1. Static: grep `out/main/chunk-WR3FEWGO.js` and `out/chunk-*` for the handler registered on
   `StartWebRemoteControl`; trace to `createServer` / `WebSocketServer` / `hono` and read the
   route table, bind address expression and port selection.
2. Dynamic (safe, opt-in): with the user's consent, invoke `zcode:get-web-remote-control-status`,
   then `start`, then enumerate listeners owned by the Electron PID
   (`Get-NetTCPConnection -State Listen`), then `stop`. Compare the status object before/after.
3. If a port is found: connect with a WS client to the advertised path, send a
   `v4/controller/subscribe` and observe the handshake/auth rejection shape.

---

## U-2 — `--json` output shape for `zcode --prompt` ⬤ HIGH

**Question.** What exactly does `zcode --prompt "<text>" --json` print on stdout?
(`--json` is documented as "Print machine-readable JSON where supported".)

**Why it matters.** `zcode_headless` is the fallback control path and the lowest-coupling
integration. Its output schema determines whether it can substitute for the protocol entirely.

**What is already known (CONFIRMED).** `--prompt`, `-p`, `--json`, `--cwd` parse. `--settings` and
`--max-turns` are advertised but rejected. Running without a configured provider returns
`Error: Model config is missing.`

**Experiment.** Configure a provider (see U-3), then run
`node zcode.cjs --prompt "Reply with exactly PROBE-OK" --json --cwd <tmp>` and capture stdout with
`--verbose`; record whether it is a single JSON object, NDJSON stream, or JSON-in-text. Then repeat
with `--resume <sessionId>` to see whether the session id is emitted.

---

## U-3 — agent model-config schema ✅ **RESOLVED** (statically, no execution)

**Question.** What shape does the agent's own config need?

**Answer (CONFIRMED from `zcode.cjs` static analysis).** The config lives under the top-level key
**`model`**. Resolution (`function P5`):

```js
function P5(e = {}) {
  let t = e.modelConfig ? void 0 : ns({ env: e.env });
  let r = e.modelConfig ?? t?.config.model;
  if (!r) throw eMe(t?.sources.user.path);        // "Model config is missing…"
  …
}
```
Config **sources are ordered project-first, then user**
(`function zun`: `e.sources.project.loaded && e.sources.project.hasModel && e.sources.project.path`
→ else `e.sources.user`). The user path defaults to `~/.zcode/cli/config.json` (`function eMe`:
`let t = e ?? "~/.zcode/cli/config.json"`).

Required shape (`modelTargets` = `[main, lite?, ...available]`, `targetToProviderConfig`):

```jsonc
{
  "model": {
    "main":      { "provider": "<providerId>", "model": "<modelId>",
                   "kind": "anthropic" | "openai" | "openai-compatible",
                   "baseURL": "https://…", "apiKey": "…", "apiKeyRequired": true,
                   "headers": {}, "providerOptions": {}, "providerName": "…", "includeUsage": true },
    "lite":      { /* optional, same shape */ },
    "available": [ /* optional, same shape */ ]
  },
  "modelCatalog": { /* optional */ },
  "network": { "caCertFile": "…", "httpProxy": "…", "noProxy": "…" }   // optional
}
```
`kind` is inferred when absent (`inferProviderKind`): provider `"anthropic"` with no `baseURL` →
`anthropic`; `"openai"` with no `baseURL` → `openai`; otherwise `openai-compatible`.
`openai-compatible` **requires** `baseURL` (`Model provider <id> is missing baseURL`).

**API key resolution order** (`apiKeyEnvCandidates` → `resolveApiKeyFromEnv`) — **a key can come
entirely from the environment, so no secret need ever be written to disk**:
```
OPENAI_API_KEY            (when kind resolves to openai)
ANTHROPIC_API_KEY         (when kind resolves to anthropic)
<PROVIDERNAME>_API_KEY    →  <PROVIDER>_API_KEY  →  <PROVIDER without "default[-_]">_API_KEY
ZCODE_API_KEY             (always added, last)
```
Normalisation: uppercase, runs of non-alphanumerics → `_`, leading/trailing `_` stripped.
Further fallbacks inside `targetToProviderConfig`: `baseURL` and `apiKey` may be inherited from an
existing provider entry (`r?.baseURL`, `r?.apiKey`).

Also recovered: model error codes (`model_config_missing`, `provider_not_found`,
`provider_not_configured`, `model_not_found`, `invalid_model_ref`, `model_request_failed`,
`model_request_cancelled`, `model_request_timeout`, `model_rate_limited`, `model_context_exceeded`),
transport kinds (`http`, `sse`, `websocket`), and failure kinds (`rate_limited`, `provider_overloaded`,
`server_error`, `network_error`, `timeout`, `stream_idle_timeout`, `stale_connection`, `auth_refresh`,
`reasoning_signature_repair`, `offpeak_queued`, `auth_failed`, `cancelled`, `context_exceeded`,
`invalid_request`, `provider_not_configured`, `proxy_error`, `tls_error`, `unknown`).

**Remaining sub-question (still open, LOW):** which *delivery* mechanism is most robust for the
generated config — a project-level config in `<workspace>/.zcode/`, `HOME` redirection to a per-child
config dir, or `--settings` (which failed one probe run). See U-13. The schema itself is no longer a
risk.

---

## U-4 — Desktop credential protection ⬤ MEDIUM

**Question.** Are `~/.zcode/v2/credentials.json` values plaintext, or protected with Electron
`safeStorage` (DPAPI)? Is `zcodejwttoken` a JWT usable directly as a bearer token?

**Why it matters.** If the OAuth token is directly usable, the MCP could reuse the user's existing
Z.ai subscription instead of requiring a separate API key — a much better UX. If it is DPAPI-wrapped,
it is not portable to an out-of-process MCP, and the MCP must ask the user for a key.

**What is already known (CONFIRMED).** The key names exist. `provider.builtin:zai-coding-plan` and
`builtin:zai-start-plan` hold **plaintext** API keys in `config.json` (one is a JWT-shaped string
with `user_id` and `token_version` claims). `node-forge` is a dependency. `--no-browser` exists for
OAuth.

**Experiment.** Statically: grep for `safeStorage`, `encryptString`, `decryptString`,
`DPAPI`, `keytar` in the main/host bundles. Then check whether the file's string values look like
base64 blobs (encrypted) or plaintext (JWT/`sk-…`). Do **not** print values.

---

## U-5 — `v4/command` envelope schema beyond `sendText` ⬤ MEDIUM

**Question.** What are the full `payload` schemas for `type: "createSession"`, `"sendGoalCommand"`,
and `"compact"`? What is required in `commandId` (format, uniqueness scope, idempotency window)?
What is the exact `ack` object merged into the result?

**Why it matters.** `zcode_chat` and `zcode_command execute` depend on getting the envelope exactly
right. `idempotencyTablePerSession: 512` and `commandPendingTtlMs: 24 h` say retries are safe if the
id is stable — but only if the MCP forms ids correctly.

**What is already known (CONFIRMED).** `buildConversationCommandEnvelope` wraps
`{type:"sendText", payload:{...}}` and normalises `toolDisallowlist` when `automationId` is present.
Queue item `kind ∈ {sendText, sendGoalCommand, compact}`. `Iv.sendText` is the zod schema name.

**Experiment.** Static: locate `Iv=` in `zcode.cjs` and dump every member schema; locate `YLr`/`QLr`
for `v4/commands/query`. Dynamic: send `v4/command` with a deliberately empty envelope and read the
`-32602` path list, which enumerates required fields in order.

---

## U-6 — Full turn phase list ⬤ MEDIUM

**Question.** What is the complete set of `context.phase` values in
`turn.phase.started`/`turn.phase.completed`?

**Why it matters.** Phase events are the best progress signal for a long turn; `zcode_chat wait`
can report which phase is in progress instead of a bare "running".

**What is already known (CONFIRMED).** `context_initialization`, `session_start_hooks`.

**Experiment.** `grep -o 'phase:"[a-z_]*"' ~/.zcode/cli/log/*.jsonl | sort -u` across all log days,
cross-checked against a string scan of `zcode.cjs` for the phase enum.

---

## U-7 — MCP `protocolEra` values ⬤ LOW-MEDIUM

**Question.** `protocolEra: "legacy"` was observed for every connected server. What are the other
values, and what changes between eras?

**Why it matters.** If ZCode negotiates a newer MCP era with more capable semantics, an MCP server
targeting it could expose richer status. It also hints the MCP client implementation is
version-aware in a way our `zcode_mcp status` tool should surface rather than flatten.

**Experiment.** Static: grep `protocolEra` in `zcode.cjs` and read the surrounding enum and the
version-negotiation probe (the failing HTTP server reported
`"Version negotiation probe timed out after 5000ms"`, so a probe with a timeout exists).

---

## U-8 — `workspaceKey` derivation and `workspaceIdentity` semantics ⬤ MEDIUM

**Question.** Is `workspaceKey` always the literal path? When does it differ from `workspacePath`,
and what produces `workspaceIdentity` and `remoteSessionId`?

**Why it matters.** `workspaceKey` is the join key for every call, subscription route and event map.
The MCP caches runtimes by it. If it can differ from the path (case normalization, symlinks, remote
prefixes), a naive path→key mapping will spawn duplicate runtimes or address the wrong workspace.

**What is already known (CONFIRMED).** Observed `workspaceKey === workspacePath` for local
workspaces (`F:\Github`, `F:\ComfyUI`, `C:\Users\mnehm\.zcode\workspace\default`).
`buildWorkspaceRef` emits `{workspacePath, workspaceIdentity?, remoteSessionId?, workspaceKey}`.
Remote forms exist: `remote:ssh:<…>`, `remote:wsl:<…>` (`H8`/`K8`, used by
`supportsLegacyRemoteTaskAllowlist`).

**Experiment.** Static: find the `workspaceKey` computation function (grep `",workspaceKey:"` and
the `ie(...)` helper used throughout) and read the normalisation (case folding, trailing separators,
UNC handling). Dynamic: create two sessions for the same folder with different casing and compare
keys via `session/list`.

---

## U-9 — Whether a second client can share a live agent runtime ⬤ MEDIUM

**Question.** Can two clients attach to the same agent runtime, or is one transport one client?

**Why it matters.** If a runtime can be shared, an MCP could attach to the **desktop's own agent**
and observe the user's real session (read-only monitoring) instead of running a parallel one.

**What is already known (CONFIRMED).** The host dedupes pending permission requests by
`(workspace, session, requestId)` and *only fires `permission.request` once* when the key already
exists — implying a single owner per request, not shared fan-out. `fault.subscription.notOwned`
shows explicit single-ownership semantics for subscriptions.

**Experiment.** Spawn one `app-server`, then a second `app-server` in the same cwd, and issue
`session/list` from both — compare whether they see each other's sessions and whether SQLite
contention appears. Then attempt `session/create` with a **pre-existing** `sessionId` from the
second process and observe whether it resumes or errors.

---

## U-10 — Whether write-back of interaction preferences is bidirectional ⬤ LOW

**Question.** When the MCP pushes `workspace/updateInteractionPreferences`, does anything flow back
to the desktop's `setting.json`, or is the desktop the only writer?

**Why it matters.** `zcode_settings set_desktop` is file-based and needs a restart; if there is a
protocol path that reaches desktop settings it would be strictly better.

**Experiment.** Record `setting.json` mtime/hash, call `workspace/updateInteractionPreferences`
from a standalone runtime, and re-hash. Then grep the host for a handler that writes the desktop
settings file in response to a protocol message.

---

## U-11 — Desktop local storage / IndexedDB keys ⬤ LOW

**Question.** Which keys does the renderer persist in Chromium Local Storage / IndexedDB /
Session Storage?

**Why it matters.** Could reveal UI state that is otherwise unreachable (panel layout, drafts,
scroll positions) — relevant only if a future goal is UI state mirroring. Not needed for v0.1.

**Experiment.** Extract key names by scanning the renderer bundle for `localStorage.`,
`sessionStorage.`, `indexedDB.open(` literals, rather than parsing LevelDB.

---

## U-12 — `zcode-scheduler` process topology ⬤ LOW

**Question.** Is `out/scheduler/index.js` a separate OS process, a worker thread, or a module
loaded by the host?

**Why it matters.** It owns automations and `tasks-index.sqlite`. If it is a separate process, an
MCP wanting to observe scheduled runs must read the DB; if it is in-process, the host RPC would do.

**Experiment.** Grep the main bundle for how the scheduler entry is launched (`utilityProcess.fork`,
`new Worker`, `child_process.fork`, `import(...)`), and check whether any live PID's module graph
includes it (compare command lines and `--type=utility` args).

---

## U-13 — Which `--prompt` flags actually parse ⬤ LOW-MEDIUM

**Question.** `--settings` and `--max-turns` are rejected despite appearing in `--help`. Which other
documented flags are actually implemented?

**Why it matters.** `zcode_headless` must not emit flags that fail. Mis-emitting turns a working
call into a usage error.

**What is already known (CONFIRMED).** Accepted: `--prompt`, `-p`, `--json`, `--cwd`, `--help`,
`-v/--version`. Rejected: `--settings`, `--max-turns`.

**Experiment.** A flag matrix — for each documented flag, run
`node zcode.cjs <flag> <value> --help` and check for `Unknown option`. Safe (no model call) and
cheap. **This experiment was started and interrupted; it should be completed.** Until then the MCP
emits only the verified subset and records `run.command`.

---

## Summary table

| ID | Question | Status / Impact |
|---|---|---|
| U-1 | Web Remote Control binding/auth/routes | ✅ **RESOLVED — and it kills Tier B.** The desktop runs **no** listener; it is an outbound `ws` client to `wss://zcode.z.ai/ws`, with the app talking to that relay. See addendum §A16 |
| U-2 | `--json` output shape | ✅ **RESOLVED** — `--output-format text\|json\|stream-json`; `stream-json` ends with a `{"type":"result",…}` line |
| U-3 | agent config `model` schema | ✅ **RESOLVED** — static, no execution needed |
| U-4 | credential protection | ✅ **RESOLVED** — `credentials.json` is AES-256-GCM **but the key falls back to a value derived from the machine's own identity**; provider keys in `config.json` are plaintext. See addendum §A13 |
| U-5 | full `v4/command` payload schemas | **MOSTLY RESOLVED** — 30 command types enumerated, CAS tokens identified |
| U-6 | complete turn phase list | open — log grep |
| U-7 | `protocolEra` values | open — static grep |
| U-8 | `workspaceKey` derivation | ✅ **RESOLVED** — `workspaceIdentity?.trim() \|\| workspacePath` |
| U-9 | multi-client attach | open — two-process probe |
| U-10 | prefs write-back | open — probe |
| U-11 | renderer storage keys | ✅ **RESOLVED** — ~25 localStorage keys enumerated (addendum §A15) |
| U-12 | scheduler topology | ✅ **RESOLVED** — `tasks-index.sqlite` owned by the desktop host; automations mutated only by the `Cron*` agent tools |
| U-13 | real `--prompt` flag set | ✅ **RESOLVED** — exactly 21 flags accepted by `util.parseArgs` (strict); 5 advertised flags are not parsed |
| U-14 | `hooks trust` family and hidden subcommands | **new, un-analysed** — `hooks trust status\|review\|grant\|revoke`, `__internal-search`, `__zcode-plugin-host` |

**Newly opened by the addendum** (`findings_ADDENDUM.md` §A12): the `hooks trust` subcommand family
(`status|review|grant|revoke`) and the hidden `__internal-search` / `__zcode-plugin-host` subcommands
are un-analysed surfaces worth a follow-up pass.
