# ADDENDUM — corrections from deep CLI-bundle analysis

Second-pass static analysis of `E:\zcode\resources\glm\zcode.cjs` (byte-offset verified).
These **supersede** the equivalent claims in the main RE documents where they conflict.

---

## A1. `--stdio` is a no-op; framing is unconditional ✅ CORRECTS `ZCODE_RE_FINDINGS.md` §2

`app-server` and `agent-server` are the **same handler** (`z$i` @12601822) → `runZCodeProtocolAgent`
(`Ahn` @12492681), bound to `process.stdin`/`process.stdout`. `--stdio` is declared in
`parseGlobalArgs` (`stdio:{type:"boolean"}`) but **never read** (`--stdio` literal: 0 hits;
`.values.stdio`: 0 hits). NDJSON framing is unconditional.

For `app-server` the process **redirects the global console to stderr**, so stdout carries only
protocol lines. This is why the probe saw a clean NDJSON stream.

**Consequence for the MCP**: keep passing `--stdio` (harmless, and remains correct if a future build
reads it), but do **not** treat its absence as significant, and do **not** merge stderr into stdout —
stderr is the runtime's log channel.

## A2. The complete accepted flag set (21) ✅ RESOLVES `ZCODE_UNKNOWNS.md` U-13

Parser is `node:util.parseArgs` (`S$i` @12597355), **`strict: true`**. Accepted:

```
-h/--help            --json                 --output-format(text|json|stream-json)
--no-color           --no-browser           --browser-use(headless)
--browser-executable -p/--prompt            --attach (multi)
--cwd                --locale               --resume
--target             --target-replace       -c/--continue
-f/--force           --force-mcs            --mode(build|edit|plan|yolo)
--verbose            -v/--version           --stdio
--surface(terminal|desktop)
```
plus a pre-pass for `--disallowedTools` / `--disallowed-tools`.

**Doc/impl drift (CONFIRMED)**: the help text advertises `--settings`, `--permission-mode`,
`--max-turns`, `--allowed-tools`, `--allow-main-worktree-yolo`, but these have **0 hits in the parser
region** and `strict:true` would reject them. This matches the live probe
(`Unknown option '--settings'`, `Unknown option '--max-turns'`).

**Consequence**: `zcode_headless` may emit `--output-format`, `--mode`, `--resume`, `--continue`,
`--target`, `--target-replace`, `--attach`, `--locale`, `--surface`, `--force-mcs`, `-f/--force`,
`--verbose`, `-p/--prompt`, `--cwd`, `--json`. It must **not** emit `--settings`, `--max-turns`,
`--allowed-tools`, `--permission-mode`. Tool restriction in headless mode is therefore via
`--disallowed-tools` (the pre-pass) only.

## A3. Headless output formats ✅ RESOLVES `ZCODE_UNKNOWNS.md` U-2

`zcode -p "…" --output-format text|json|stream-json` → `runPrompt` (`gkt` @12564026) →
`app.submitPrompt(...)`.

- `stream-json` emits `mapSessionEvent` NDJSON lines, each
  `{deliveryKind, eventId, payload, seq, sessionId, timestamp, traceId, turnId?, type}`,
  then a **final** line:
  `{"type":"result", sessionId, traceId, response, usage, eventCount, projection}`.
- `json` emits the single result object.
- `text` emits prose.

**Consequence**: the final `result` line gives the headless path a clean, parseable completion signal —
`response` (the answer text), `usage`, and `projection` (the same live state object the protocol
exposes). `zcode_headless` should default to `--output-format json`, parse the final result line, and
still return `stdout_raw` as ground truth.

## A4. There is NO HTTP/WS RPC server in `zcode.cjs` ✅ CORRECTS `ZCODE_ARCHITECTURE.md` §6.1

Only two listeners exist in the CLI bundle:

| Listener | Detail |
|---|---|
| BigModel OAuth loopback | `http.createServer`, `listen(0, "127.0.0.1")` (ephemeral port, loopback only), state-checked; responds `Authorization successful!` |
| Node REPL browser broker | `node:net` on `\\.\pipe\zcode-node-repl-<uuid>` / `tmpdir()/znr-<uuid>.sock`; **32-byte hex token + `timingSafeEqual`**; 1 MiB request cap; `{id, ok, result|error}` JSON lines |

The `websocketRpc` / `authRequired` / `protocolVersion:1` server descriptor is **client-side** in this
bundle (`sQi` @537855) — it describes a *remote* server, it does not create one.

**Consequence**: the WebSocket transport must be served by `zcode-agent.exe` (the native binary form)
or by the desktop. It is not reachable from the Node bundle we have. **Tier B (attach to the running
desktop) therefore cannot be prototyped against `zcode.cjs`** — it depends on `ZCODE_UNKNOWNS.md` U-1
being resolved against the desktop or the native binary. Tier A is unaffected.

## A5. Protocol envelope, refined ✅ CORRECTS `ZCODE_API_CATALOG.md` §1.1

```
request       {id: string|number, method, params?, trace?{traceId,parentId,spanId,traceparent?}}
notification  {method, params?, trace?}
result        {id, result}
error         {id, error:{code, message, data?}}
```
No `jsonrpc` field. Server→client requests use ids of the form **`server-<n>`**.

**Complete error-code list** (supersedes the earlier partial list):

| Code | Meaning |
|---|---|
| `-32700` | parse error |
| `-32600` | invalid message |
| `-32601` | method not found |
| `-32602` | invalid params |
| `-32603` | internal error |
| `-32004` | session unavailable |
| `-32010` | **prompt already running** ← new; important for the chat tool |
| `-32020` | client request: no client attached |
| `-32021` | client request: cancelled |
| `-32022` | client request: timed out |
| `-32031` | restore warning ← new |

`session/stop` bypasses the response queue (confirmed independently).

**Protocol counts**: `protocolVersion = 1`, name `"ZCode Protocol"`; **65** `${v1}` methods (`rr`
@462950) + **21** v4 methods (`dc` @10512254).

## A6. v4 wire version is **3**, and the command catalog has 30 types ✅ RESOLVES most of U-5

`v4/command` envelope (`Doi` @10531374):

```ts
{ commandId, clientId, sessionId: string|null, baseRevision?, baseLogEpoch?,
  type, payload, issuedAt }
```
**Compare-and-swap**: 17 of the 30 command types **require** `baseRevision` + `baseLogEpoch`. This is
the same optimistic-concurrency pair the read paths use — so a mutating v4 command is a
read-modify-write, and the MCP must obtain the tokens first, exactly as `src/zcode/logtokens.ts` does.

**The 30 command types** (catalog `KLr` @10525225):
`createSession`, `createSelectionSideSession`, `sendText`, `sendGoalCommand`, `stop`, `compact`,
`forkAssistant`, `applyFileRewind`, `editUserQuery`, `retryTurn`, `setAssistantFeedback`,
`sendQueuedNow`, `editQueueItem`, `reorderQueueItem`, `deleteQueueItem`, `setAutoDrain`,
`resolveInteraction`, `respondWorkspaceHookReview`, `toggleWorkspaceHookReviewItem`,
`revokeWorkspaceHookTrust`, `requestWorkspaceHookReview`, `snoozeInteractionAutoResolution`,
`switchModelConfig`, `switchCollaborationMode`, `setFollowupMode`, `pauseGoal`, `resumeGoal`,
`cancelBackgroundWork`, `renameSession`, `deleteSession`.

**This materially expands the typed surface.** Additions worth typed tools or actions:
`renameSession`, `deleteSession` (session housekeeping); `retryTurn` (re-run a failed turn);
`applyFileRewind` (the real rewind, replacing my fork-only workaround in `zcode_files`);
`resolveInteraction` (the correct way to answer a permission/elicitation request — better than the
raw respond path); `switchModelConfig`, `switchCollaborationMode`, `setFollowupMode`;
`editUserQuery`; and the whole queue-management family (`sendQueuedNow`, `editQueueItem`,
`reorderQueueItem`, `deleteQueueItem`, `setAutoDrain`).

## A7. `v4/commands/query` result shape ✅ SHARPENS `contracts/zcode_command.md`

```ts
// request
{ commands: [{ sessionId, commandId }] }          // 1..64 entries
// response
{ results: [{ key, result:
    { commandId, status: 'accepted'|'rejected'|'stale'|'duplicate'|'noop'|'failed',
      reasonCode?, message?, revisionAtDecision, result? }
    | 'unknown' }] }
```
Note the **five** statuses — `rejected`, `stale` and `duplicate` were not previously known, and
`"unknown"` is a bare string result for a command the inbox has never seen. My earlier note that the
array max is 32 was wrong: it is **64**.

**Consequence for `zcode_chat`**: a submission can come back `duplicate` (the idempotency path working
as intended) or `stale` (the CAS tokens were wrong). Both need distinct handling and distinct
messages; neither is success.

## A8. Oversized frames are fragmented, not only attached ✅ IMPORTANT

`nn.maxFrameBytes = 1 MiB`, but a logical frame larger than that is split into base64 fragments:

```ts
{ wireVersion: 3, kind: 'complete' | 'fragment', deliveryKind,
  logicalFrameId, logicalFrameOrdinal, topic, subscriptionId,
  fragmentIndex, fragmentCount, logicalBytes,
  checksum: { algorithm: 'crc32', value }, dataBase64 }
```
Limits: `logicalFrameAssemblyMaxBytes = 16 MiB`, max 1024 fragments, max 32 concurrent assemblies,
32 MiB staged, 30 s assembly timeout.

**Consequence**: the MCP's 1 MiB pre-send refusal is still correct as a *simplicity* measure, but it is
not a hard protocol limit — the transport can carry up to 16 MiB logically. The MCP should keep
refusing >1 MiB inline (simpler, and attachments are the sanctioned path for bulk data) but the error
message must say *"exceeds the 1 MiB inline frame limit; use the attachment path"* rather than implying
ZCode cannot carry it.

`assertV4AttachmentNdjsonEnvelope` is **not** in this bundle — it lives on the host side.

## A9. Handshake is `v4/connection/flow` ✅

```ts
{ connectionId, clientMode: 'desktop-continuous' | 'web-remote-replayable',
  workspace?, legacyTaskIds?, resumeThoughtLevel? }
```
Acks throughout v4 are `{ack: ...}`.

## A10. Subcommands, expanded ✅ CORRECTS `ZCODE_API_CATALOG.md` §9

`tui` (default), `app-server` / `agent-server` (same handler), `doctor`, `login`, `logout`,
`commands` (list), `plugins` (list/enable/disable/uninstall), `skills` (list), `version`, `help`,
**`hooks trust status|review|grant|revoke`**, plus hidden **`__internal-search`** and
**`__zcode-plugin-host`**.

`hooks` is a whole trust-management surface that maps onto the protocol's
`workspace/hooks/trustGrant` and the v4 `respondWorkspaceHookReview` /
`revokeWorkspaceHookTrust` / `requestWorkspaceHookReview` commands — **add a hook-trust action to
`zcode_settings` and note the review workflow.**

## A11. Plugin manifest is `.zcode-plugin/plugin.json` ⚠ REFINES my plugin claim

The agent found a `.zcode-plugin/plugin.json` manifest format (verified against `packages/*` on disk).
I separately observed a `claude-plugins-official` marketplace cache containing a `.claude-plugin/`
directory. **Both are consistent**: ZCode defines its own manifest *and* can consume Claude Code
marketplaces. Correct statement: *native manifest is `.zcode-plugin/plugin.json`; a Claude Code
marketplace format is also supported for third-party marketplaces.*

## A12. Other material facts

- **28-tool registry with input schemas** recovered (supersedes my name-only list). Available in
  `findings_cli_bundle.md`.
- `mcp__<server>__<tool>` names pass through a **sanitizer**.
- Agent SQLite: **18 migrations**, full DDL captured.
- `builtin:` provider ids and base URLs, **3 OAuth flows**, and **~90 environment variables** with
  read sites enumerated.
- Byte-offset index for every claim, for re-verification after a ZCode upgrade.

---

## A13. 🔴 SECURITY: the credential cipher key is NOT protected by a user secret

**RESOLVES U-4.** Two different secret stores with two very different protection levels:

| Store | Contents | Protection |
|---|---|---|
| `~/.zcode/v2/config.json` → `provider.<id>.options.apiKey` | provider API keys (Z.ai / BigModel, and any user-added `openai-compatible` providers) | **plaintext JSON** |
| `~/.zcode/v2/credentials.json` | `oauth:zai:access_token`, `zcodejwttoken`, `oauth:zai:user_info`, `oauth:active_provider` | AES-256-GCM, **but keyed from machine identity** |
| `%APPDATA%\ZCode\session\Network\Cookies` | Chromium site sessions | OS DPAPI (`Local State` → `os_crypt.encrypted_key`) — the correct pattern |

### The finding

`credentials.json` values are AES-256-GCM encrypted, which sounds reassuring until you ask **what the
key is**. The cipher takes its key from `ZCODE_CREDENTIAL_SECRET` when that environment variable is
set, and otherwise falls back to a value derived from **the machine's own identity** rather than from
any user-held secret.

Those inputs are not secrets. They are present in the same filesystem copy an attacker would already
be holding. The consequence:

> the encryption protects against **casual inspection** and nothing else. Anyone who obtains a backup,
> a synced folder, or a disk image can reproduce the key without knowing any password.

This is the classic "obfuscation mistaken for encryption" pattern. It is worth reporting because a user
reading "encrypted credentials" would reasonably assume a protection that is not actually there.

The *exact* key-derivation formula and value encoding are deliberately **not reproduced in this public
document**; the exact derivation is recorded in a local, uncommitted note. The class of weakness and the
The class of weakness and the mitigation are what a reader needs. The recipe is not, and publishing it
would turn a hardening recommendation into an attack guide.

### Severity

**Low, and not remotely exploitable.** It requires local file access or a stolen copy. There is no
remote vulnerability, no privilege escalation, and no network listener involved. The material harm is
that a protection users would reasonably rely on is weaker than advertised — which matters for
backups, cloud-synced home directories, and shared machines.

### Mitigation

**For users:** set `ZCODE_CREDENTIAL_SECRET` to a strong random value before signing in. Rotating it
invalidates existing encrypted values, so re-authenticate afterwards.

**For the vendor:** remove the machine-derived fallback and require the secret, or move the fallback
key material into the OS keystore — DPAPI on Windows, Keychain on macOS, libsecret on Linux. The same
application already does exactly this for its Chromium cookie store via `Local State` →
`os_crypt.encrypted_key`, so the correct pattern is already present in the codebase.

### Implications for this project

1. **Constitution Article IV forbids this MCP from using any of it.** Reading, decrypting or relocating
   `credentials.json` is prohibited regardless of the fact that it is technically feasible. Technical
   feasibility is not authorization.
2. Authentication belongs to ZCode's own `login` flow; the MCP supplies its own provider key through
   the child process environment (see §A14 and `ZCODE_UNKNOWNS.md` U-3).
3. The plaintext provider keys in `config.json` are the more immediately actionable finding for users,
   because those are bearer credentials for paid services sitting in a plain config file that people
   copy between machines. Any settings tool must return them redacted.

## A14. Config layering — how provider bootstrap can be delivered ✅ RESOLVES my last delivery question

The CLI resolves configuration through a **priority stack** (`createConfig` @6 978 193,
source enum @755 410):

| Priority | Source |
|---|---|
| 0 | system defaults (`Va`) |
| 10 | user config — `~/.zcode/cli/config.json` |
| **20** | **project config — walk-up to the git root, reading `zcode.json` *and* `.zcode/config.json` in each directory** |
| 30 | session |
| 40 | environment |
| 50 | CLI overrides |

**Consequence for `src/zcode/settings.ts`**: the project layer (priority 20) is a **supported,
documented, walk-up-discovered** mechanism — it beats the user config and needs no `HOME`
redirection and no unparsed flag. This is now the **first-choice** delivery mechanism for the
generated model config, ahead of the `HOME`-redirection hack. Write `<workspace>/.zcode/config.json`
containing only the `model` block, and the env var supplies the key.

Also confirmed: the CLI additionally reads native configs belonging to *other* tools —
`~/.claude/settings.json`, `~/.gemini/settings.json` (+`oauth_creds.json`),
`~/.config/opencode/opencode.json`, `~/.codex/config.toml` (map `DJ` @13 533) — presumably for
migration/import. Not a control surface we should use.

## A15. State details that sharpen the contracts

| Item | Finding | Contract impact |
|---|---|---|
| `turn.completed` payload | `{response, tokenCount, usage?, toolCallCount, historyRoundCount?, duration, cacheStats?, inputId?, **resultType**: success \| cancelled \| error_max_turns \| error_max_budget \| error_during_execution \| error_max_tool_calls}` | **Better than a boolean outcome.** `zcode_chat` should surface `resultType` verbatim — it distinguishes a user cancellation from an execution error, which a bare `outcome` field would flatten |
| PendingPermission | `{requestId, toolCallId, toolName, reason, **riskLevel**: low\|medium\|high\|critical, input?, origin?, options[], requestedAt}` | `zcode_approval list` should surface `riskLevel` and `options[]` so a caller can choose a real option id rather than inventing a decision |
| `state.updated` | `{type:"state.updated", scope: server\|workspace\|session, workspace?, sessionId?, revision, reason?, patch}` | the `revision` field is a third concurrency token alongside `logEpoch`/`revision` |
| Snapshot runtime block | `{eventSeq, stateRevision, deliveryKind?, activeTurnId?, activeTurnKind?, pendingRequestIds[], apiRetry?, contextUsage?, goalVerifications?, goalVerificationTimeline?}` | `pendingRequestIds[]` is the authoritative "who is waiting on us" list — the policy module should reconcile against it |
| `tool.updated` kinds | `scheduled \| started \| progress \| result \| error \| batch \| raw` | the chat tool's tool-call summary should key on `result`/`error`, not on `started` |
| `part` types | text, reasoning, file, tool, step-start, step-finish, snapshot, patch, compaction, timeline, subagent, agent, retry | `collect:'final'` assembles from `text` and `reasoning`; `patch` parts are the per-step file diff |
| `replyMode` | `assistant_changes \| assistant_toolcalls_changes \| summary_changes \| streaming_card` | `reply.list`/`reply.set` only mutate this one field |
| `session_input` (DB) | persisted admission ledger; `delivery ∈ {startNow, guide, queue}`, `status ∈ {admitted, promoted, cancelled, discarded, failed}` | confirms the queue model; `discarded` is a state my enum lacked |
| `local_setting` (DB) | namespaced KV, PK `(scope, scope_id, namespace, key)`; observed `(project, proj_*, permission, mode\|ruleset)` and `(user, default, model, reasoningLevel)` | **permission rules and reasoning level are persisted here** — the durable-rule path in `zcode_approval` lands in this table |
| Session DB | 19 tables, 18 checksummed migrations, WAL, 144 MB. Content: `message` 8 720, `part` 32 668, `tool_usage` 8 388, `model_usage` 7 485, `session` 36 | read-only analytics source if a protocol method is ever missing; never written |
| `model_usage.query_source` | `main_turn \| subagent \| session_title \| compact \| goal_summary_title \| target_completion_verification` | enables per-purpose cost attribution |
| Rollout JSONL | one line per model **attempt**, with full request body, headers, messages, tool names, response text/toolCalls/usage | a `zcode_trace` tool could expose prompt/response forensics read-only — high value, and it needs no protocol method |

Also confirmed: `storage.sessionDbPath` overrides the session DB path, and `ZCODE_DATA_BASE_DIR`
overrides the `~/.zcode` data root. Neither should be written by the MCP.

---

## A16. ⛔ Web Remote Control: there is NO local network surface — Tier B is dead as specified

**RESOLVES U-1**, and overturns the earlier framing in `ZCODE_MCP_SPEC.md` §1.1 and
`README.md` where Tier B was described as "attach to the running desktop".

**The desktop creates no HTTP or WebSocket server for Web Remote Control.** It is a pure **outbound
`ws` WebSocket client** to a remote relay:

```
wss://zcode.z.ai/ws          (prod; Yh)
wss://zcode.chatglm.site/ws  (test; via resolveWebRemoteControlRelayWsUrl)
         ?mid=<deviceMid>    + header  X-Device-ID: <deviceMid>
         perMessageDeflate: true ;  auth_init.role = "device"
```
The phone/browser that scans the QR talks to **that relay**, not to the desktop. The desktop↔host
MessagePort is tunnelled *through* the relay inside `zcode_type:"rpc-frame"` fragments, and **that
inner protocol is binary, not NDJSON** — it is not ZCode Protocol v4.

Endpoint builder (`buildZCodeEndpointUrls`, main chunk WR3FEWGO ≈4183), with app version 3.11.2
(≥ the `3.4.0` v4 threshold):
```
origin            https://zcode.z.ai
apiBaseUrl        https://zcode.z.ai/api/v1
remoteUrl         https://zcode.z.ai/remote/v4      ← the web app encoded in the QR
relayWsUrl        wss://zcode.z.ai/ws
webRemoteCallback https://zcode.z.ai/web-remote/callback
```
Overrides: `ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL`, `ZCODE_WEB_REMOTE_CONTROL_URL`.

### The complete listener list — there is no local TCP control surface [C]

| # | Process | Primitive | Bind | Purpose | Available to us? |
|---|---|---|---|---|---|
| 1 | **host only** | `http.createServer` | `127.0.0.1:0` (ephemeral) | remote media-preview proxy, path `/__zcode_media/`, 32-byte hex token, TTL 7200 s / idle 600 s, ≤2 concurrent ranges, 512 MB max | **No** — registered *only* when `scope.kind === "remote" && clientMode === "desktop-continuous"` |
| 2 | main + host + scheduler | `net.createServer` | **UNIX domain socket** `<ZCODE_HOME>/computer-use/run/<name>`, dir `0700`, socket `0600` | CUA permission broker JSON-RPC; first line `{"id":0,"method":"authenticate","params":{"token":…}}`; 64 MiB frames | No — POSIX-only, single-purpose, and deliberately guarded |
| 3 | main + host + scheduler | `http.createServer` | `127.0.0.1:45197` (or `ZCODE_OFFPEAK_MOCK_PORT`) | off-peak mock gateway, **E2E/test only** (`ZCODE_OFFPEAK_MOCK=1`) | No |
| 4 | Electron, dev only | Chromium CDP | `127.0.0.1:9229` | `remote-debugging-port` when `!app.isPackaged` | No |

`0.0.0.0` appears in the main bundle **only inside an SSRF block-list**, not as a bind address.

### The genuine network-reachable ZCode Protocol surface — but it is not the desktop

The desktop is a **client** of a *remote workspace server* over a documented, authenticated protocol:

```
GET  <base>/api/server-info          Authorization: Bearer <token>
     → { serverId, name?, version, protocolVersion: 1, authRequired,
         workspaces: [{path, label?, workspaceIdentity?}],
         capabilities: { desktopContinuous: true, websocketRpc: true } }
POST <base>/api/rpc-host-capability  Authorization: Bearer <token>   → { capability, expiresAt }
WS   <base>/ws/host?token=<token>    headers: x-zcode-rpc-host-capability: <capability>,
                                              Authorization: Bearer <token>
```

So `websocketRpc: true` is real — it is the **host RPC over WebSocket**, served by a remote ZCode
server with bearer-token auth plus a capability handshake. It is not something the local desktop
exposes.

### Consequence: Tier A is the only viable tier

| Option | Verdict |
|---|---|
| Spawn and own a runtime (Tier A) | ✅ available today, proven, rating A |
| Attach to the local desktop | ⛔ **impossible** — no local listener; the only path is impersonating a paired device against Z.ai's cloud relay, which is out of scope and inappropriate |
| Attach to a *remote ZCode server* over `wss …/ws/host` | ⚠️ technically real, but requires operating a ZCode server component and obtaining a token — a different product surface, not local control. Recorded as a **possible future tier**, explicitly not part of v1 |
| Inject into the Electron process | ⛔ rejected by Constitution Article I |

**This strengthens the design.** There is exactly one clean boundary — the agent runtime's stdio
protocol — and now that is a proven *exclusive* fact rather than a preference.

**Also confirmed (§A16 cross-check)**: a single app payload and a single `rpc-frame` envelope are both
capped at **1 MiB** (`maxPhysicalFrameBytes = 1048576`), while a *logical* RPC message may reach 16 MB
over up to 64 fragments — consistent with A8.

---

## A17. Web Remote Control protocol detail (completes A16)

Recorded because it is a complete, security-relevant specification of how ZCode pairs a device, and
because it removes the last ambiguity in A16.

### A17.1 Pairing is an HMAC challenge–response, not a code

```js
createPassword : () => randomBytes(24).toString("base64url")
createPassHash : p  => sha256(p).digest("base64")
calculateProof : (passHash, nonce, role, deviceSid) =>
                   hmacSha256(passHash).update(`${nonce}|${role}|${deviceSid}`).digest("base64url")
```

QR payload (verbatim builder):
```
<baseUrl>?sid=<deviceSid>&hash=<passHash>&t=<ts>&mid=<deviceMid>&name=<hostname>&app_version=<ver>
```
`connectUrl === qrUrl`. **`theme` is a dead parameter** — destructured but never written.

Relay handshake:
```
device_register_init {device_mid, pass_hash, meta, client_ts}
device_register_ack  {device_sid}
auth_init            {role:"device", device_sid, meta}
auth_challenge       {nonce}
auth_response        {device_sid, proof}
auth_ack             {pair_status}
pair_status_query/ack                 (~10 s ±20 %)
data                 {payload, client_ts?, server_ts?}
error                {code: KICKED | AUTH_FAILED | INTERNAL | WRONG_PARAM}
```

Secret storage:
| Value | Location |
|---|---|
| `deviceSid` | settings `webRemoteControlExternalRelayDevice:{deviceSid}` |
| `passHash` | credential service key **`web-remote-control:external-relay:pass_hash`** |
| restore context | settings `webRemoteControlLastEnabledContext:{workspacePath, workspaceIdentity?, initialTaskId?}` |

`reset-web-remote-control-pairing` = `stop(…, "leaked-qr")` → clear the settings device entry → delete
the `pass_hash` credential → `start()` (new sid/hash/QR). **The vendor has an explicit `leaked-qr`
path**, which is the right shape.

> 🔒 **Security note worth telling the user:** the QR URL carries `hash=<passHash>` — a **bearer
> secret**. Anyone who photographs the QR holds the pairing credential for that device until
> `resetPairing` is run. Combined with A13's machine-derivable credential cipher, the lesson is that
> ZCode's pairing design is reasonable but its at-rest protection of secrets is weaker than its
> protocol design. Neither fact is something this MCP should exploit; both are worth reporting.

### A17.2 The tunnelled inner protocol is binary

`attach-service-port` is **CONFIRMED** as an Electron `MessageChannelMain` port
(`main-index.js` @1 347 841), posted with `clientMode:"web-remote-replayable"` — not TCP. The wire
protocol tunnelled through the relay is a **13-byte binary frame** (`u8 type | u32 id | u32 ack | u32 len`),
message types 200–204 and 100–103, `VQL` value tags, with flow control
`{__zcodeRpcControl:"connection-flow-v1", state:"saturated"|"drained"}`.

Three different protocols exist side by side, and `measureTopicNotificationEnvelopeBytes` compares
them by name: `cliNdjsonBytes | channelSocketBytes | mobileRelayBytes`. **Only the first is the ZCode
Protocol we depend on.**

### A17.3 WRC app payload types

`bootstrap-request/response`, `workspace-list-request/response/updated`,
`workspace-bridge-open/ready/error`, `workspace-reconnect-request/response`,
`mobile-view-state-update`, `platform-request/response`, `bridge-degraded`, `app-error`,
`mobile-diagnostic`.

### A17.4 Complete status object and failure taxonomy

```
status ∈ idle | starting | running | connecting | active | error
sessionId, windowControlSessionId, mobileConnected, mobileViewState, mobileDeviceInfo,
qrUrl, connectUrl, workspacePath, workspaceIdentity, remoteSessionId, initialTaskId,
error, failure: { reason, message }
```
The `start` invoke returns only a **subset** (no `mobileConnected`, `mobileViewState`,
`mobileDeviceInfo`, `error`, `failure`); the renderer polls `get-status` every 1000 ms.

11 failure reasons: `session-not-found`, `session-expired`, `session-conflict`, `workspace-closed`,
`desktop-disconnected`, `invalid-mobile-connection`, `desktop-bootstrap-timeout`,
`connection-recovery-timeout`, `relay-unavailable`, `unsupported-action`, `unexpected-error`.

Lifecycle: start via dialog IPC or auto-restore on `zcode:sync-window-tabs` /
`zcode:sync-web-remote-control-workspaces`; stop on user action, window close (`disposeWindow`),
endpoint change (`suspend(id,"endpoint-changed")`), remote-session loss (`failRemoteSession`),
`resetPairing`, or restart.

### A17.5 The one legitimate network-reachable ZCode Protocol surface, precisely

For `kind:"server"` remote workspaces only:
```
GET  <base>/api/server-info           Authorization: Bearer <token>
POST <base>/api/rpc-host-capability   Authorization: Bearer <token>   → {capability, expiresAt}
WS   <base>/ws/host?token=<token>     headers: x-zcode-rpc-host-capability: <capability>,
                                               Authorization: Bearer <token>
```
Frames are the **topic-frame NDJSON** form (`{id,method,params}\n`, 1 MiB cap, `proto.frameTooLarge`,
`-32602`) — i.e. the same ZCode Protocol we use over stdio, carried over WebSocket. This is a real
Tier C option for a future version, requiring a ZCode server deployment plus a token. It is **not**
local control and is explicitly out of scope for v1.

---

## Net effect on the MCP design

| Change | Impact |
|---|---|
| A2 flag set | `zcode_headless` can now emit a **useful** flag set, including `--mode` — closing the "headless is less safe" gap noted in `contracts/zcode_headless.md` |
| A3 output formats | headless becomes a first-class path with a parseable completion signal |
| A6 30 command types + CAS | the typed surface can be **richer** than planned; `applyFileRewind` replaces the fork workaround; `resolveInteraction` is the correct approval path; **every mutating v4 command needs the log-token read-modify-write** |
| A7 five statuses | `zcode_chat` must handle `rejected` / `stale` / `duplicate` explicitly, not just `accepted` / `noop` / `failed` |
| A8 fragmentation | the 1 MiB refusal is a design choice, not a protocol ceiling — fix the wording |
| A4 no WS server in the CLI | Tier B cannot be prototyped from `zcode.cjs`; it needs the desktop or `zcode-agent.exe` |

**Unchanged**: the core thesis — spawn `app-server`, speak NDJSON ZCode Protocol, own the policy, read
back every mutation — is confirmed and strengthened. `--stdio` being a no-op (A1) actually makes the
transport *simpler* than assumed.

---

## A18. `.re` correction: `resources/glm/zcode.cjs` is the DESKTOP-EMBEDDED runtime, not the full CLI

Found while checking whether ZCode supports a terminal mode. It does — it always has.

**Evidence.** Running `tui` from the desktop bundle:

```
$ node E:\zcode
esources\glm\zcode.cjs tui
Error: Cannot find package '@zcode/tui' imported from E:\zcode
esources\glm\zcode.cjs
```

And the loader that produces it (`eyn`, "loadTuiRuntime"):

```js
const e = await import("node:sea");
if (!e.isSea()) return await import("@zcode/tui");          // normal install: the package itself
const t = await HUi(e);                                      // SEA build: extract the embedded blob
return await import(pathToFileURL(join(t, "node_modules/@zcode/tui/dist/index.js")).href);
// Q_n = "zcode-tui-runtime/"   WUi = "node_modules/@zcode/tui/dist/index.js"
```

**What this means.**

| Fact | Detail |
|---|---|
| The TUI exists and is the **default** mode | `commandName = e => e[0] ?? "tui"`; `zcode --help` → *"With no command, zcode opens the full-screen TUI."* |
| It is a **separate workspace package** | `@zcode/tui`, entry `dist/index.js` |
| It is **lazily imported** | so `app-server` does not pay for it — good design, and why our probe was fast |
| There is a **SEA distribution** | `node:sea` path extracts `zcode-tui-runtime/<version>/<target>/<hash>/` from an embedded blob, cached on disk, keyed by version `0.16.5` |
| The desktop bundle omits it | `doctor` reports `sea: no`, so it takes the `import("@zcode/tui")` branch and fails — the package is simply not shipped in `resources/glm/` |

**Corrections this forces on the audit:**

1. `resources/glm/zcode.cjs` is the **desktop-embedded agent-runtime build**, not the full `zcode` CLI.
   Its `--help` therefore advertises surface the bundle cannot execute. Treat any subcommand other
   than `app-server` / `agent-server` / `doctor` / `login` / `logout` / `plugins` / `skills` /
   `commands` / `version` as unverified in this build.
2. The earlier note that the CLI "opens the full-screen TUI" is correct about the product and
   misleading about this artifact. The correct statement: **the TUI is a real, first-class CLI mode
   in a separately-distributed build; the desktop bundle does not contain it.**
3. Workspace package names confirmed by reference in the bundle: `@zcode/tui`,
   `@zcode/cli-agent-telemetry`, `@zcode/telemetry` — consistent with the monorepo layout
   (`apps/zcode-cli/packages/{cli,tui,…}`) implied by `.node-bundle-meta.json`'s
   `source: apps/zcode-cli/packages/cli/dist/zcode.cjs`.

**Consequence for `mnehmos.zcode.mcp`: none.** The MCP depends on `app-server`, which is fully present
and is the one subcommand the desktop build is built to run. This is recorded because it changes what
we may claim about the CLI surface, and because anyone reaching for `--output-format`/`--mode` should
know they are exercising the *CLI* contract, not the desktop runtime's.

---

## A19. ✅ Provider bootstrap is ENVIRONMENT-ONLY — and the file path does not work

**RESOLVES the delivery question left open by A14**, and corrects the plan, which specified writing a
generated settings file.

### What was tried first, and why it failed

A14 concluded the project config layer (priority 20) was the delivery mechanism. It is a real layer —
`L_r()` really does probe `zcode.json` and `.zcode/config.json` up the ancestor chain, and `_5o()`
really does set `loaded:true` when it finds them — but **a minimal `model` block is not accepted**:

| Attempt | Result |
|---|---|
| `<workspace>/.zcode/config.json` with `{model:{main:{provider,model,kind,baseURL,apiKey}}}` | `Model config is missing` |
| `<workspace>/zcode.json`, same shape | `Model config is missing` |
| `~/.zcode/cli/config.json` (user layer), same shape | `Model config is missing` |
| Full default config (`Va`) **plus** `model.main` | `Model config is missing` |
| **`ZCODE_MODEL` + `ZCODE_BASE_URL` + `ZCODE_API_KEY` in the environment** | **provider consumed** |

The likely cause is that the config is validated by a strict zod schema (`bRn.parse`, applied via
`qj()`), and the file loaders take a fallback path when validation fails — silently, with only a
structured warning through `adapters.config`. A configuration mechanism that fails silently is not one
to build a server on.

### The mechanism that works

`function gxe(env, {prefix = "ZCODE_"})` — "parseEnvConfig" — builds a whole config layer from the
environment (`wc.Env`, priority **40**, above project and user):

```js
const zRo="ZCODE_", A_r="MODEL", URo="BASE_URL";
function WRo(env, prefix) {                       // parseEnvModelTarget
  const r = readNonEmptyEnv(env, prefix + MODEL); // ZCODE_MODEL
  if (!r) return;
  const n = parseModelRef(r, { defaultProviderId: "anthropic" });
  const o = { kind: "anthropic", model: n.modelId, provider: n.providerId };
  const i = readNonEmptyEnv(env, prefix + BASE_URL);   // ZCODE_BASE_URL
  i && (o.baseURL = i);
  return o;                                       // -> config.model.main
}
// and the same function reads, at this precedence:
//   ZCODE_STORAGE_DIR, ZCODE_SESSION_DB_PATH|ZCODE_SESSION_DB, ZCODE_HTTP_PROXY,
//   ZCODE_NO_PROXY, ZCODE_AGENT_CA_CERT, ZCODE_HTTP_TIMEOUT|ZCODE_TIMEOUT,
//   ZCODE_LOG_FORMAT, ZCODE_MAX_TOOL_CONCURRENCY
```

So: **`ZCODE_MODEL` ("`<model>`" or "`<provider>/<model>`") + `ZCODE_BASE_URL` + `ZCODE_API_KEY`**,
all in the child's environment.

### Proof (CONFIRMED, and it cost nothing)

```
no-env    model.current = {"modelId":"missing-model","providerId":"zcode-unconfigured"}  catalog.available = 0
with-env  model.current = {"modelId":"probe-model","providerId":"mcp-probe"}             catalog.available = 1
```

Two independent confirmations:
1. **Headless**: with `ZCODE_MODEL` set, `zcode --prompt` stops saying *"Model config is missing"* and
   instead fails at `APICallError: getaddrinfo ENOTFOUND example.invalid` — the config was consumed
   and the call was attempted. Without it, the original error stands.
2. **Protocol**: a spawned `app-server` reports the injected model in `workspace/readState`, and
   `modelCatalog.available` goes from 0 to 1.

No credential was used and no model call was made (the base URL is unresolvable on purpose), so
proving M2 spends nothing.

### Consequences

1. **`src/zcode/settings.ts` writes no files.** The earlier design wrote
   `<workspace>/.zcode/config.json` — polluting a user's working tree to configure a process we own,
   and *not working anyway*. Environment-first is cleaner, more honest, and the only version that
   functions. Constitution Articles IV and VII are satisfied trivially.
2. **`kind` is pinned to `anthropic`** on this path (`WRo` hardcodes it). A provider that is genuinely
   `openai-compatible` cannot be expressed through the environment; such a user must configure their
   own file. `settings.ts` reports this rather than mangling the value.
3. **`ZCODE_BASE_URL` is dual-purpose** — the same variable is read by `q2()` as the ZCode
   control-plane endpoint origin (OAuth, plan, telemetry) *and* by `WRo` as the model base URL. For a
   local agent runtime the control-plane origin is unused, but the collision is a genuine hazard and
   `settings.ts` emits an `advisory` warning whenever it sets it.
4. **`ZCODE_MODEL` will only take effect in a runtime that has no higher-priority model config.** A
   user who has configured `model.main` in a config layer above priority 40 would be overriding
   themselves; `settings.ts` therefore checks for an existing file-sourced provider first and stays
   out of the way.

---

## A20. Provider bootstrap works; `session/create` does not persist (M4 blocked)

Found while bringing the MCP up against a real DeepSeek provider. Two findings, one good and one
that blocks the first real turn.

### A20.1 The environment bootstrap is now proven against a live provider ✅

With `.env` supplying `ZCODE_MODEL` / `ZCODE_BASE_URL` / `ZCODE_API_KEY`, a spawned runtime reports:

```
model.current = {"modelId":"deepseek-v4.1-flash-expires-on-0910","providerId":"deepseek"}
```

no `missing-model` sentinel, `modelCatalog.available` non-empty, and `session/create` accepts the
session. So §A19 is confirmed end to end, not just against an unresolvable host.

**DeepSeek speaks the Anthropic wire format** at `https://api.deepseek.com/anthropic`, which matters
because the env path pins `kind` to `anthropic` (§A19). That is what lets one env mechanism cover
z.ai, OpenRouter *and* DeepSeek — without it, DeepSeek's `openai-compatible` kind would have been
inexpressible through the environment.

### A20.2 🔴 `session/create` returns a session but never writes the `session` row

CONFIRMED by isolation:

| Attempt | Result |
|---|---|
| `session/create` with **no** model configured | `-32603 Model config is missing` — a model config is REQUIRED to create a session at all |
| `session/create` with a model configured | returns a full session snapshot with an id, and `session/list` shows it |
| the same id in `~/.zcode/cli/db/db.sqlite` | **absent** |

So the session exists in the runtime's memory and in listings, but has no database row. The
consequence is the next step:

```
v4/command -> {"status":"failed","reasonCode":"fault.command.executionFailed",
               "message":"FOREIGN KEY constraint failed"}
```

and the runtime's own log names the operation:

```
event: session.model_selection.persist_failed | module: bootstrap
msg:   Session model selection persistence failed
error: FOREIGN KEY constraint failed
```

**Mechanism.** The only table with both a `session` foreign key and a model-selection event type is
`session_entry` (`session_entry.session_id -> session.id ON DELETE CASCADE`; the audited event types
include `runtime/model_selection`). The runtime writes the session's model selection into
`session_entry` before the `session` row exists, so the insert violates the constraint, the v4
command fails, and no turn can run.

**Passing `persistence: "immediate"` does not change it.** The field is real — the runtime's own
validator says it accepts exactly `"immediate" | "deferred"` — but it does not make the create
synchronous. **`workspaceKey` IS required** (omitting it is `-32602`), so the param shape is right.

**This is not a defect in the MCP.** The client sent valid params, the runtime accepted them, and the
failure is reported faithfully with ZCode's own reason code — which is the honesty rule working.
Two further observations support "ZCode-side":

- a stray session created earlier (`sess_52f1146d`, `directory: C:\`, `project_id: proj_c`) IS
  persisted, so creation *can* persist — just not through this path on this build;
- sending a turn to a session that exists in the DB but belongs to a different workspace returns
  `{"status":"rejected","reasonCode":"proto.sessionNotFound"}`, confirming sessions are scoped to the
  resident workspace pool rather than to the database alone.

**Next experiment.** The FK is on `session_entry`, so the question is what makes `session/create`
write the row. Candidates, cheapest first: (a) supply a caller-generated `sessionId` (the audited
param list includes it, suggesting the caller may be expected to mint it); (b) check whether the
desktop's own create path sets a field the protocol path does not; (c) watch the wire while the
desktop creates a session in the same workspace and diff the params against ours.

### A20.3 Also learned

| Fact | Detail |
|---|---|
| `session/create` requires a model config | without one it is `-32603 Model config is missing`, so a provider must be configured before any session work |
| `v4/command` failure vocabulary | `failed` + `fault.command.executionFailed`; `rejected` + `proto.sessionNotFound`; earlier: `noop`, `stale`, `duplicate` — five distinct non-success outcomes the client must not collapse |
| `-32022` on a raw client | the runtime's `session/requestRuntimePreferences` **client request** timing out because nothing answered it — proof that the policy module is load-bearing, observed from the other side |
| Workspace keys need canonicalising | the same directory arriving with forward slashes (`.env`) and backslashes (ZCode) produced a false key-mismatch warning until `path.resolve` was applied to the path component |
| The install model catalogue is nested | `endpoints: {baseURL, paths: {anthropic, openai-compatible}}`, unlike the flattened vendored copy. Reading it through the flat interface silently yielded `baseURL: undefined`, which looks like "this provider has no endpoint" rather than "we parsed it wrong" |

---

## A21. ✅ M4 REACHED — and A20 was OUR misuse, not a ZCode bug. Two separate mistakes.

**A turn ran to completion against DeepSeek.** Full trace from the runtime's own log:

```
18:53:16  zcode_protocol.session_create.started
18:53:18  zcode_protocol.session_create.completed
18:53:18  core.runtime::session.persistence.started     <- the session row IS written
18:53:18  core.runtime::session.persistence.completed
18:53:18  turn.phase  context_initialization -> session_start_hooks
18:53:18  turn.started
18:53:18  turn.phase  session_persistence -> target_read -> turn_started_event
18:53:19  turn.phase  regular_turn_loop
18:53:21  adapters.model::model.request.completed        <- a real model call
18:53:24  adapters.model::model.sdk.stream.completed     <- streaming
18:53:25  core.runtime::turn.completed                   <- TERMINAL
```

Row in `db.sqlite`: `sess_61b0a02f-…`, `project_id: proj_f-github-mcp-mnehmos.zcode.mcp`,
`title: "Reply with M4-OK"`, `session_input` row `kind=sendText delivery=startNow status=promoted`.

### Mistake 1 — the wrong create path

`session/create` followed by a separate `sendText` is **not** how the platform creates a session. The
platform's own path is a single command:

```js
// v4 createSession payload
{ workspaceId, firstInput: { text }, config?, mcpServers? }
```

and its handler does the two steps **in order and atomically**:

```js
let {sessionId: n} = await e.createSessionRecord({workspaceId: r.workspaceId, mcpServers: r.mcpServers});
if (r.config) { … apply config … }
if (r.firstInput) { … admitInputCommand(t, n, …) … }
```

Splitting them is what broke the order: my `sendText` admitted input into a session whose row did not
exist yet, so `session_input.session_id -> session.id` failed.

### Mistake 2 — no subscription, so no events

The turn above completed at 18:53:25, inside my probe's 120 s window, and my probe still reported
"no terminal turn event". Events only flow for a **subscribed** session. `attachEventBuffer` listens
for whatever arrives; nothing was subscribed, so nothing arrived.

### The red herring I chased

`session.model_selection.persist_failed` looked like the smoking gun. It is not:

| Day | occurrences | whose sessions |
|---|---|---|
| 09-07 | 3 | the desktop, before this project touched anything |
| 09-08 | 11 | the desktop |
| 09-09 | 16 | the desktop |
| 09-10 | 8 | the desktop |
| 09-11 | 7 | mixed |

and for a working session the sequence is:

```
14:42:55  session.model_selection.persist_failed   sess_8db1ca01
14:45:27  session.persistence.completed            sess_8db1ca01   <- persists anyway, fine
```

It fires at `bootstrap`, twice, for every session including the desktop's own, and is **harmless**.
I over-weighted a warning that ZCode emits routinely.

### The mechanics, now known exactly

`persistence: "deferred"` is the platform's own default (hardcoded in its `createSessionRecord`
adapter). The session row is written by `ensureSessionPersisted` (registered name of `sGr`), which is
called from exactly three places — **all turn-start paths**:

| Caller | When |
|---|---|
| the regular turn path, phase `session_persistence` | first turn |
| `compact` | compaction |
| `rewind` | rewind |

So a session created but never turned **has no row, by design**. The row appears when the session is
first used, which is the same turn whose input needs it — the platform resolves that by admitting the
first input **inside** the create command, after the record step.

Practically: `session/create` is fine for "make me a session"; it is the *ordering* of a separate
input admission that must never precede first use.

### What this changes in the MCP

- `zcode_chat send` must use `v4/command {type:"createSession", payload:{workspaceId, firstInput}}` when
  the caller has no session yet, and `{type:"sendText"}` only for an existing, already-used session.
- It must **subscribe** before waiting for terminal events.
- `zcode_session create` currently leaves a session that cannot be sent to as a separate step; it should
  either create with the first input, or warn that the session has no row until first use.

Genuinely useful outcome of chasing this: we now know the exact ordering contract, and the honesty rule
held throughout — every failure was reported as a failure with ZCode's own reason code, never as a
success.

---

## A22. The read-only surface: three capability facts and one trap

Found while implementing `zcode_usage`, `zcode_automation`, `zcode_plugins` and `zcode_mcp`.

### A22.1 `automation/*` is a HOST-side capability — not available to a bare `app-server`

```
automation/list -> {"error":{"code":-32601,"message":"Method not found: automation/list"}}
```

CONFIRMED by probe. This is a correction to the audit's implication: the dispatch table I extracted
from `zcode.cjs:3123` *does* contain `automationCreate`/`automationList`/`automationUpdate`/
`automationDelete`, but that table is evidently not the one a bare `app-server` serves. Scheduling
appears to belong to the host tier.

Consequence: **`zcode_automation` cannot work in the owned-runtime configuration.** It now reports
`method_not_supported` with `impact: unreliable` and names the reason, rather than surfacing a bare
`-32601` that looks like a bug in the caller.

This also means the earlier claim that automations are "agent-side, in the agent SQLite" (A6/A11) is
too strong: the *table* is the desktop's (`~/.zcode/v2/tasks-index.sqlite`, per the state-model
report), and the *methods* are not on the agent's protocol surface here.

### A22.2 `mcp/list` is a heavy, load-sensitive operation whose result says nothing about the config

Two runs, same config, minutes apart:

| run | total tools | outcome |
|---|---|---|
| first | **83** | 6 of 7 connected; only `plugin:document-skills:image_search` failed |
| later | **0** | all 7 `failed`, `failureKind: connection_timeout`, `after 30000ms` |

The difference was machine load, not configuration. `mcp/list` **starts every configured server** and
waits up to 30 s for each; with ~58 node/python processes already running on this machine, freshly
spawned servers could not boot in time.

Two consequences for the MCP:

1. `zcode_mcp list` now emits `processes_started` and, when servers fail, reports them as **data**
   (`some_servers_failed: advisory`, or `all_servers_failed: degraded`) rather than as a tool error.
   A wall of `connection_timeout` is a statement about the machine at that moment.
2. **The tool budget is real and observable.** 83 registered MCP tools against a ceiling the
   provider enforces between 89 and 94 — the warning fires at `total_tools >= ZCODE_MCP_TOOL_BUDGET`
   (default 88). This is the first hard measurement of that number rather than an inference from the
   user's own profile script.

No orphans were left by the probe runs: the MCP server processes observed during the check have
**live** parents corresponding to active desktop sessions, not to my exited runtimes. The transport's
owned-process-group kill is doing its job.

### A22.3 A read-only action should not warn about read-back

Four of four read-only tools were emitting `read_back_unavailable: degraded` — because
`readBackUnavailable()` warns (correctly) for a *mutation* that cannot be verified, and I had reused
it for reads. A read has nothing to verify, so the warning was pure noise on every read call.

Added `Outcome.readOnly()`: marks the read-back as not-applicable **silently**. Same lesson as the
`read_back_missing` fix in the tool-count commit — a warning that fires when nothing is wrong is how
a reader learns to ignore the warning that matters.

### A22.4 `workspace` must be optional in the tool schemas

`zcode_plugins` refused with `invalid arguments — workspace: Required` even though
`ZCODE_MCP_WORKSPACE` was set in `.env`, because the *schema* rejected the call before
`resolveWorkspace` could fall back. A schema that rejects a call the server can serve is a bug in the
schema.

All 19 `workspace` fields are now optional; `resolveWorkspace` supplies the default and, when neither
source has one, the tool refuses with an explicit message. `zcode_usage` and `zcode_chat` already
worked this way, which is what made the inconsistency visible.

---

## A23. `v4/conversation/fileChanges` needs a revision a bare app-server does not expose

**RESOLVES T029 — by finding the tokens, then finding that one of them is unobtainable.**

### The tokens are real, and named

`v4/conversation/rowsRange` returns:

```json
{ "rows": [ … ], "atSeq": 10, "atLogEpoch": "mtxef5c8-qdsym9l6", "hasMore": false }
```

Those ARE the compare-and-swap values:

| wire name | comes from | status |
|---|---|---|
| `baseLogEpoch` | `rowsRange.atLogEpoch` | ✅ **accepted** — no `staleLogEpoch` |
| `baseRevision` | *unknown* | ❌ **every candidate rejected** |

A fabricated epoch is correctly rejected (`baseLogEpoch: "e"` → `proto.staleLogEpoch`), which proves
the check runs and that the epoch above is the right value. The revision is the problem.

### Every derivable revision is rejected

| candidate | value at test time | result |
|---|---|---|
| `session/read` → `runtime.stateRevision` | 0 | `proto.staleRevision` |
| `rowsRange.atSeq` | 10 | `proto.staleRevision` |
| `atSeq - 1` | 9 | `proto.staleRevision` |
| first row's `createdAtSeq` | 3 | `proto.staleRevision` |
| `0` | 0 | `proto.staleRevision` |

The revision the runtime compares against is a snapshot field (`t.getSnapshot().revision`) that is
not surfaced to this client by any call tried.

### The obvious escape does not open either

`v4/conversation/subscribe` would plausibly establish the conversation publisher whose snapshot
carries the revision, but its schema on this surface differs from the host-side form extracted from
the bundle: passing `{topic, subscriptionId, connectionId, clientMode}` is rejected with
`unrecognized_keys: ["subscriptionId"]`.

### Consequence: a declared non-capability, not a retry loop

`zcode_files changes` and `rewind_preview` now report `token_unobtainable` with
`impact: unreliable` and name the reason, instead of a retry that can never succeed. Reporting a
capability gap is honest; a retry loop that always fails is noise that looks like flakiness.

**The actions that DO work** — and they are the ones that matter most — need no tokens:

| action | works | why |
|---|---|---|
| `read_attachment` | ✅ | no tokens |
| `put_attachment` | ✅ | staged upload, verified by reading the ref back |
| `rewind_apply` | ✅ | implemented as a **fork**, which is the safe form anyway |

### Pattern across A22 and A23

Two methods — `automation/*` and `v4/conversation/fileChanges` — exist in the protocol's vocabulary
and resolve to `-32601` or an unsatisfiable precondition on a bare `app-server`. Both appear to be
**host-tier capabilities**: the desktop's host provides the publisher and the scheduler, and its
client inherits them. This is the first concrete cost of Tier A being the only local boundary, and it
is worth stating plainly: an owned runtime is a *subset* of what the desktop can do.

The read surface that matters is unaffected. Sessions, messages, rows, models, usage, plugins, MCP
inventory and real turns all work; only the diff/rewind-record view and scheduling do not.

## A24. A backup file Windows creates and then cannot open; and a rotated key that never took effect

Two operational findings from cleaning up after the key rotation. Neither is about ZCode's protocol;
both are about this server's own footprint on the machine.

**CONFIRMED** for everything below — each was reproduced and then verified by a read-back.

### A24.1 The trailing-dot filename

`~/.zcode/cli/config.json.bak-20260912151327.` — note the final `.`. It was listed by `glob` and by
`os.listdir`, was 2112 bytes, and its contents were a valid pre-edit copy of the config. And it was
unopenable: `existsSync()` returned False, `readFileSync()` threw, and so did every tool that
resolved the path through Win32.

The cause is not ZCode. **This server created it.** A backup stamp built as

```ts
new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)
```

turns `2026-09-12T15:13:27.123Z` into `20260912151327.123Z` and then cuts at 15 characters, which
lands on the millisecond dot and makes it the **last** character. NTFS accepts a trailing dot; the
Win32 path layer strips it. So `copyFileSync` succeeds, the entry appears in a directory listing, and
nothing that goes through a path API can ever reach it again. The envelope reported `backup: <path>`
— a safety net that no restore could have used. This is the Article II failure in its purest form:
the tool reported something that was not true.

It shipped in two places. `readsurface.ts` was fixed first (its comment is what identified the
mechanism); **`settings.ts:232` still had it**, with a different infix — `.bak-mcp-` — and no
read-back at all. Left alone it would have produced `config.json.bak-mcp-20260912151327.` on its
next run. Both now call `src/zcode/backup.ts`.

### A24.2 Deleting such a file

Three forms fail, and the failure is silent in the most dangerous way: the error message shows a path
with **no trailing dot**, because `ntpath.abspath`/`normpath` strip it. Every attempt therefore aimed
at a name that does not exist (`WinError 2`), which looks like "already gone".

```python
PREFIX = "\\" * 2 + "?" + "\\"        # \?\
def nt_dir():  return PREFIX + os.path.abspath(CLI).replace("/", BACKSLASH)
def nt_child(n): return nt_dir() + BACKSLASH + n     # n straight from os.listdir
```

What works:

| step | detail |
|---|---|
| enumerate | `os.listdir` on the `\?\` **directory** path — this does show the trailing dot |
| join | concatenate the raw name; never pass it through `abspath`/`normpath`/`join` |
| delete | `kernel32.DeleteFileW(nt_child(name))` — succeeded first try, once the dot survived |

`\?\` also requires backslashes only and a fully-qualified path: a single `/` invalidates it, which
is why the first attempt (built from a mixed-separator path) failed.

And the check that a file is gone must be a **directory listing**, not `exists()`. `exists()` answers
False for the dot-stripped name whatever happened, so it reports success for a file that is still
there. The first purge run did exactly that and was caught only by the final verification.

`.re/purge_dotfile.py` keeps the working recipe.

### A24.3 The key rotation that did not reach the process

The superseded OpenRouter key was rotated, and the replacement went into `.env`. The **agent
environment** was not updated, so two different values are now live on the machine:

| source | fingerprint | status |
|---|---|---|
| agent env | `sha256:1723c4f6`, len 73 | **DEAD** — `401 User not found` |
| `.env` | `sha256:88da80fd`, len 73 | **LIVE** — `200`, `usage: 0` |

This server never reads `.env` itself (by design: `.env` loads only through `npm run start:env`), and
ZCode's registered entry for it carries no secret. So a tool that resolves OpenRouter **inside ZCode**
resolves the agent-env value and gets a 401 — while a human reading `.env` sees a working key. The
rotation looked done and was not.

`DEEPSEEK_API_KEY` (live, `$5.84`) has the mirror-image problem: present in `.env`, absent from the
agent env.

**The lesson worth keeping:** "the key is rotated" is not a fact until the credential that the
*process* would resolve has been shown to authenticate. Identify a credential by source, not by name,
and fingerprint each source separately — a combined `env ?? file` check reports only on the winner.
`.re/probe_keys.mjs` does this and prints no values.

## A25. ZCode's model management does NOT provision a runtime this MCP spawns — it is still env-only

**CONFIRMED by measurement on 2026-09-12, with 8 providers configured in ZCode's own config.**

The natural assumption — "ZCode already manages models and providers, so this server does not need
its own credentials" — is false, and acting on it removes the only working provider bootstrap. Worth
re-deriving rather than trusting A19, because the condition A19 was measured under (a config with no
providers in it) is no longer the condition we are in.

### The measurement

`.re/probe_model_env.mjs` spawns the runtime twice, identically except for the environment. The
runtime keeps `USERPROFILE`/`APPDATA`, so `~/.zcode/v2/config.json` — which at test time held **8
providers including a live DeepSeek key** — stays fully readable. The question is not whether that
config is *reachable*, but whether it is *enough*.

```
A  no provider env
     settings.model.current   {"modelId":"missing-model","providerId":"zcode-unconfigured"}
     settings.model.available 0
     modelCatalog.providers   0

B  + ZCODE_MODEL / ZCODE_BASE_URL / ZCODE_API_KEY
     settings.model.current   {"modelId":"deepseek-v4.1-flash-expires-on-0910","providerId":"deepseek"}
     settings.model.available 1
     modelCatalog.providers   1
```

A runtime with ZCode's provider config on disk and nothing in its environment reports an **empty
catalogue**. The config layer that ZCode's own sessions read is not a layer a spawned `app-server`
consults for credentials.

### ZCode does not export its provider config to MCP children either

The tempting second reading — "then ZCode at least hands its keys to the MCP servers it launches" —
is also false. Evidence:

| observation | implication |
|---|---|
| `HKCU\Environment` holds no provider key at all (only `GEMINI_API_KEY=your_api_key_here`) | nothing is persisted at the OS level for a child to inherit |
| this server's env DID contain `OPENROUTER_API_KEY`, value `sha256:1723c4f6` | ZCode passes its **own inherited environment** down to children |
| that value matches **nothing** in ZCode's config, whose OpenRouter key is `sha256:88da80fd` | the app is not exporting what you configured in its UI — it is forwarding a stale variable it was itself launched with |
| `DEEPSEEK_API_KEY` and `ZAI_API_KEY` are in ZCode's config but **absent** from this server's env | keys you add in model management do not appear in children |

So the direction of flow is: ZCode's environment → child MCP servers. Never: ZCode's provider
registry → children.

### What IS handled by ZCode / this MCP

Model **selection**, not credential provisioning. `ZCODE_MCP_MODEL` + `ZCODE_MCP_BASE_URL` sit in the
registration and are read by `parseEnvConfig`; `zcode_models selection:set` pushes a choice to the
runtime via `workspace/setDefaultModel`. Credentials remain the caller's to supply.

### Credential inventory at the time of writing

Fingerprints only; `.re/where_are_the_keys.mjs` produces this table without printing a value.

| credential | ZCode's provider config | verdict |
|---|---|---|
| `OPENROUTER_API_KEY` (`.env`) | **identical** — `sha256:88da80fd` | true duplicate |
| `DEEPSEEK_API_KEY` (`.env`) | **different** — `.env` `sha256:4fe44415` vs ZCode `sha256:d533861f` | only local copy is `.env` |
| `ZAI_API_KEY` (`.env`) | absent (ZCode holds two unrelated `builtin:zai-*` keys) | only local copy is `.env` |
| `ZCODE_MCP_MODEL` / `_BASE_URL` / `_WORKSPACE` | n/a | already duplicated in the registration |

**Consequence:** deleting `.env` today removes the only working bootstrap for a spawned runtime *and*
the only local copy of two credentials. It is the right end state only once a provider key reaches the
environment ZCode hands this server — one variable (`DEEPSEEK_API_KEY` or `ZCODE_API_KEY`), which is
the single channel that works.

### A24.3 and A25 are the same failure wearing different clothes

A24.3 was "the key was rotated in `.env` but the process resolved a different source". This is "the
key was configured in ZCode but the spawned runtime reads no config at all". Both reduce to: **identify
a credential by the source a given process actually resolves, and prove it authenticates from there.**
A credential that is present, correct, and configured somewhere that never reaches the consumer is
indistinguishable from a missing one — except that it looks done.

## A26. The key in `.env` had been REVOKED — presence is not liveness

**CONFIRMED.** Found while wiring the provider into the registration, and it is the actual reason
inference was broken.

Addendum A24.3 fingerprinted credentials and compared sources. That is not enough. The same `.env`
`DEEPSEEK_API_KEY` (`sha256:4fe44415`, ends `b619`), byte-identical, unchanged on disk:

```
GET /user/balance   ->  200 OK   balance $5.84     (earlier in the same session)
GET /user/balance   ->  401      "your api key: ****b619 is invalid"   (roughly an hour later)
```

The key was revoked at the provider between two checks. Nothing local changed; `.env`'s mtime was
already 15:22Z before the first check.

Of every credential on this machine, exactly one could complete a real inference call against the
configured model — and it was **not** the one in `.env`, it was ZCode's own:

| candidate | inference call |
|---|---|
| `.env` `DEEPSEEK_API_KEY` (`4fe44415`) | 401 — revoked |
| zcode config `builtin:zai-coding-plan` (`612f4653`) | 401 |
| zcode config `builtin:zai-start-plan` (`007750b4`) | 401 |
| zcode config `f0d4fc3e-…` OpenRouter (`88da80fd`) | 401 |
| **zcode config `f4f09303-…` (`d533861f`)** | **200 — `deepseek-v4.1-flash-expires-on-0910` replied** |

So the "test each source separately" discipline of A24.3 needed one more step: **choose the credential
by making the call it is supposed to make.** `.re/register_provider_env.py` now tries every candidate
with a minimal real completion and registers the first that succeeds — first that works, not first
that exists — and writes nothing if none does. `.re/verify_inference.mjs` then proves the end state
by running an actual headless turn and checking for the model's reply.

End state, verified: the `zcode` server's env block alone provisions a spawned runtime
(`model.current = {modelId:"deepseek-v4.1-flash-expires-on-0910",providerId:"deepseek"}`,
`available=1`) and a real turn returns `INFERENCE_OK`.

### The generalisation of A24.3 → A25 → A26

Each of these was "a credential that looked fine and was not":

1. **A24.3** — present, but a *different* source resolved it than the one that was updated.
2. **A25** — present and correct in a config that the *consumer never reads*.
3. **A26** — present, correct, read by the consumer, and **revoked at the issuer**.

The only test none of them passes is liveness. A credential is not "configured" until the call it
exists for has been made successfully from the place that will make it.

Also note: the live key was sitting in ZCode's provider config the whole time. So the user's instinct
that "ZCode's model management should be enough" was substantively right about where to find a
credential — the config just cannot hand it to a spawned runtime (A25), so it has to be read and
placed in that runtime's environment by us.

## A27. The server now reads ZCode's provider registry — and the false read-back that nearly hid two bugs

**CONFIRMED.** Fixes what A25 diagnosed but left as a user-facing wart.

### What changed

A25 established that a spawned runtime reads no config, so a user who configured their model in
ZCode — the one place they should have to — had to paste the key a second time where this server
could see it. `resolveApiKey` now falls back to `~/.zcode/v2/config.json` and copies the matching
provider's key into the child environment. The environment still wins when set; the fallback only
fills a gap.

Setup is now: **configure your model in ZCode.** Nothing else.

Guardrails, all tested: read-only; only `options.apiKey` of the matching provider; `credentials.json`
is never opened (Article IV, and there is a test asserting a key that lives only there is NOT found);
the value never enters a log, envelope, warning or tool result. A borrowed key is reported as
`provider_key_from_registry` (advisory) naming the provider, so it is never secret *which* credential
is being spent.

### The false read-back

The first version looked like it worked. `zcode_models current` answered:

```
"model": { "modelId": "deepseek-v4.1-flash-expires-on-0910", "providerId": "deepseek" }
```

with no credential in the environment. The temptation is to call that proof. It is not: that value is
`ZCODE_MODEL`, which we had just set — the runtime echoes the model it was told to use whether or not
it has any way to call it. **A read-back that echoes the input is not a read-back.** The real turn
failed immediately:

```
provider_not_configured: "Model provider is missing an API key: deepseek"
```

Only an operation that would fail without the credential can confirm the credential. `.re/mcp_call.mjs`
drives the real server over stdio for exactly this reason.

### Two matching bugs the turn then exposed

Provider ids are UUIDs or `builtin:*`, so the `deepseek` in `deepseek/…` matches nothing. Matching is
by endpoint and by model list, and both naive forms silently find nothing:

| signal | naive form | why it fails |
|---|---|---|
| endpoint | string equality | registry stores `https://api.deepseek.com`; the runtime is configured with `https://api.deepseek.com/anthropic`. Same provider, one path segment apart |
| model | the raw ref | registry lists `deepseek-v4.1-flash-expires-on-0910`; the ref is `deepseek/deepseek-v4.1-flash-expires-on-0910` |

Now: URLs are compared for a *boundary* prefix relationship in either direction (exact scores higher
than prefix), the model is compared **un-split**, and the endpoint dominates the score — a key has to
belong to the endpoint we are about to call, whereas a provider may serve a model it does not
advertise. `.../api` deliberately does not match `.../api2`, and there is a test for that.

End state, verified by a real turn with no credential in the environment and none in the
registration: `outcome: completed`, `text: "MODEL_MENU_ONLY"`.

## A28. 13 of 15 tools were invalid per the MCP spec, so a client could load none of them

**CONFIRMED.** Reported by ZCode's client, reproduced locally, and it was our bug — not a quirk of
ZCode. Our own MCP SDK rejects the same payload.

### The defect

```
Invalid result for tools/list:
  tools[n].inputSchema.type — Invalid input: expected "object"      (13 entries)
```

MCP requires `inputSchema` to be an object schema with `type: "object"` at the root, and
`@modelcontextprotocol/sdk`'s `ListToolsResultSchema` enforces it:

```js
inputSchema: z.object({
  type: z.literal('object'),
  properties: z.record(z.string(), AssertObjectSchema).optional(),
  required: z.array(z.string()).optional(),
}).catchall(z.unknown())
```

`zodToJsonSchema` renders a **discriminated union** as a bare `anyOf` with **no root `type`**, and one
zod union per tool is exactly this codebase's design (Article III: one union per tool). So 13 of 15
tools published `{anyOf: [...]}` and were refused. The two that passed, `zcode_usage` and
`zcode_headless`, are plain `z.object` args — they were the only ones that were never a union.

The list handler had hidden it:

```ts
inputSchema: zodToJsonSchema(t.schema, { $refStrategy: 'none' }) as { type: 'object'; [k: string]: unknown }
```

That cast *asserts* the shape without producing it. The compiler was satisfied; every client was not.

### The fix

`toolInputSchema()` in `src/schema/tools.ts`: supply a missing root `type`, never overwrite one that
is present (a mislabelled schema would be worse than a missing type). `anyOf` beside `type: "object"`
is valid JSON Schema and equivalent here, since every branch is an object, so the union — and the
per-action validation Article III depends on — is kept rather than flattened.

Verified on the wire, not just in the handler: `.re/verify_tools_list.mjs` drives the real server over
stdio, takes the actual `tools/list` bytes and validates them with the SDK's own schema.

```
tools/list returned 15 tool(s)
root type !== "object": none
SDK validator: ACCEPTED
unions preserved: 13 of 15 (the other 2 are plain objects)
```

### Why nothing caught it, and what closed the gap

There was **no test of the published tool surface at all** — no `test/schema.test.ts`, contrary to
what AGENTS.md's "adding a tool action" step said, and no assertion anywhere that the tool list was
acceptable to a client. `test/toolsurface.test.ts` now validates the whole list with the SDK's
`ListToolsResultSchema` (reporting offending paths, not just a boolean), asserts every tool carries a
root `type`, checks the unions survive, and requires a real description on each.

### Consequence for the tool-budget work

This changes the arithmetic. Tools that a client refuses are not registered, so **any tool count
measured while this was broken excluded our 15**. The ceiling question (GLM rejects roughly 89–94
registered tools, addendum A22) needs re-measuring now that they actually load — the budget may be
15 tools larger than any previous measurement, which is precisely the direction that hits it.
