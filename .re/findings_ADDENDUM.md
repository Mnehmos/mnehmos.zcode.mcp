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
