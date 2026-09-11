# ZCode CLI bundle (`zcode.cjs`) — control-surface findings

**Target:** `E:\zcode\resources\glm\zcode.cjs` (12,615,227 bytes, 3,264 lines, minified CJS, names preserved via `a(fn,"name")`)
**Companion metadata:** `E:\zcode\resources\glm\.node-bundle-meta.json` → `{runtime:"electron-node", entry:"zcode.cjs", platform:"win32-x64", source:"apps/zcode-cli/packages/cli/dist/zcode.cjs"}`
**CLI version string (CONFIRMED):** `xT="0.16.5"` (byte offset 12597238); help text prints `zcode ${version}`.
**Nothing was executed.** All evidence is byte-offset into the bundle.

Labels: **CONFIRMED** = literal/code read directly · **STRONGLY INFERRED** = code structure implies but not exercised · **HYPOTHESIS** = lead only.

---

## 0. Five priority answers (coordinator's questions)

### 0.1 `app-server` flags and startup path

* **CONFIRMED** — `app-server` and `agent-server` are the same handler, both dispatch to `runZCodeProtocolCommand` (`z$i`, byte 12601822):
  ```js
  case"agent-server": case"app-server": return await z$i(e,h,x,u);
  ```
  `z$i` calls `runZCodeProtocolAgent({cwd, env, input: process.stdin, output: process.stdout, presentationSurface, version})` (byte 12492681).
* **CONFIRMED** — **there is no `--stdio` literal anywhere in the bundle** (0 hits for `"--stdio"`). `parseGlobalArgs` declares an option **key** named `stdio` (`stdio:{type:"boolean"}`, byte ~12598010), which Node `parseArgs` maps to the flag `--stdio`. The parsed value is **never read** in the CLI path (0 hits for `.values.stdio`). ⇒ `app-server --stdio` is accepted for compatibility and ignored; stdio framing is unconditional. **CONFIRMED (declared) / STRONGLY INFERRED (no-op)**.
* **CONFIRMED — there are no `--port`, `--host`, `--websocket`, `--auth-token`, `--config`, `--workspace`, `--rpc` options.** The parser is `strict:true`, so any of those would be rejected with an error. (The `"--port"`/`"--rpc"`/etc. literals in the bundle live at offsets 8.0–10.0 MB inside an embedded external-CLI command/flag corpus, e.g. Foundry `cast --rpc`, not zcode options.)
* **CONFIRMED** — for `app-server`/`agent-server` the process installs a console boundary (`installProtocolConsoleBoundary`, byte 12614419) that redirects `globalThis.console` **to stderr**, and `isProtocolServerInvocation` (`_yn`, byte 12614812) = `argv.includes("app-server") || argv.includes("agent-server")` also installs the process error boundary. **stdout stays clean for NDJSON.**
* Full accepted option set for the whole CLI is in §1; the app-server-relevant subset is `--stdio --surface <terminal|desktop> --output-format <text|json|stream-json> --json --no-color --verbose --cwd --locale`.

### 0.2 Remote / WebSocket server mode

* **CONFIRMED NEGATIVE (in this bundle).** Only two listeners exist in the entire 12.6 MB file:
  1. **OAuth loopback callback server** — `(0,Cbr.createServer)(handler)` with `Cbr=require("node:http")`, `i.listen(0,"127.0.0.1")` (byte 7166188 / 7167527). Bind: `127.0.0.1`, **ephemeral port (0)**, path-checked against `callbackPath`, validates `?state=`, accepts `authCode` **or** `code`, replies `200 "Authorization successful! You may close this window and return to the CLI."` / `400 "Authorization failed..."`. This is the BigModel OAuth redirect catcher, not an RPC surface.
  2. **Node-REPL browser broker** — `(0,_cn.createServer)(…)` where `_cn=require("node:net")` (byte 11928248). Unix socket `tmpdir()/znr-<uuid>.sock`, on Windows named pipe `\\.\pipe\zcode-node-repl-<uuid>` (byte 11929184). See §4.
* **CONFIRMED NEGATIVE** — no `WebSocketServer`, no `Sec-WebSocket-Key`, no `101 Switching Protocols`, no `ws://`/`wss://` literals, no `socket.io`, no hono/express/fastify `listen()`.
* **CONFIRMED** — the **remote-server descriptor is a client-side schema only** (byte 537855):
  ```js
  GTn=1,
  WTn=z.object({path,label?,workspaceIdentity?}),
  sQi=z.object({serverId, name?, version, protocolVersion:z.literal(1),
                authRequired:z.boolean(), workspaces:z.array(WTn),
                capabilities:z.object({desktopContinuous:z.literal(true), websocketRpc:z.literal(true)})}),
  uQi=z.object({capability:z.string().min(1), expiresAt:z.number().int().positive()}).strict()
  ```
  ⇒ ZCode CLI can *consume* a `websocketRpc` + `authRequired` remote host descriptor and a `{capability, expiresAt}` capability token, but **the WebSocket RPC server itself is not in this artifact**. Any remote/WS server mode must live in `zcode-agent.exe` or the desktop host. **HYPOTHESIS** for a `/rpc` or `/ws` path — no such literal exists in the bundle.

### 0.3 ZCode Protocol methods — CONFIRMED, complete

Two method tables exist. Both are served by the **same** stdio NDJSON connection, both handled by `ZCodeProtocolAgent` (`Ahn`).

**A. Base protocol, `protocolVersion = 1`** — `Pje=1`, name `Rje="ZCode Protocol"` (byte 418591). Method table `rr` (byte 462950) — **65 methods** (counted):

```
computer-use/operation-event, session/create, session/resume, session/list, session/subagents,
session/requestRuntimePreferences, session/read, session/messages, session/events, session/subscribe,
session/send, session/stop, session/cancelBackgroundTask, session/fork, session/compact, session/goal,
session/close, session/setModel, session/setThoughtLevel, session/updateRuntimeModelConfig,
session/setMode, workspace/readState, workspace/hooks/trustGrant, workspace/updateProviderRegistry,
workspace/updateInteractionPreferences, workspace/updateModelIoPreferences, workspace/upsertModelProvider,
workspace/removeModelProvider, workspace/setDefaultModel, workspace/setDefaultThoughtLevel,
workspace/setDefaultMode, workspace/generateText, workspace/cancelGenerateText, mcp/list,
plugins/list, plugins/referenceCatalog, skills/referenceCatalog, plugins/resolveSuggestedReference,
plugins/setEnabled, plugins/overview, plugins/marketplace/add, plugins/marketplace/remove,
plugins/marketplace/update, plugins/install, plugins/cancelOperation, plugins/uninstall, plugins/update,
plugins/restoreBuiltin, plugins/configure, plugins/resetConfig, plugins/validate, plugins/describe,
automation/create, automation/update, automation/checkTaskBinding, automation/list, automation/delete,
usage/stats, session/usage, interaction/requestPermission, interaction/requestUserInput,
interaction/requestProviderRuntimeHeaders, interaction/requestOfficialMcpAuthHeaders,
interaction/browserList, interaction/browserExecute
```
Dispatch switch is `ZCodeProtocolAgent.dispatchRequest` (byte 12476954…12487700). **Notifications** `mZ` (byte 419834): `process/mcpTelemetry`, `plugins/operationProgress`, `process/resourceSample` (sampled every `mzi=60000` ms, byte 12492900).

**B. v4 conversation/command layer** — table `dc` (byte 10512254), **wireVersion `Iy=3`** (byte 354686), 21 methods:
```
v4/connection/flow, v4/controller/subscribe, v4/controller/resync, v4/controller/unsubscribe,
v4/conversation/subscribe, v4/conversation/resync, v4/conversation/unsubscribe,
v4/conversation/rowsRange, v4/conversation/plans, v4/conversation/fileChanges,
v4/conversation/fileRewindPreview, v4/usage/stats, v4/conversation/usage,
v4/attachment/begin, v4/attachment/chunk, v4/attachment/commit, v4/attachment/abort,
v4/attachment/read, v4/attachment/previewSource, v4/commands/query, v4/command
```
Notification-side (server→client) table `UL` (byte 10512980): `v4/conversation/frame`, `v4/telemetry/event`, `v4/cua/permission-observation`.

Param/result zod schemas for the priority methods are in §5.3 (verbatim, strict objects).

### 0.4 `v4/command` + `v4/commands/query` — the command registry

* **CONFIRMED** — envelope schema `Doi` (byte 10531374):
  ```js
  Doi = z.object({ commandId:z.string(), clientId:z.string(), sessionId:z.string().nullable(),
                   baseRevision:z.number().optional(), baseLogEpoch:z.string().trim().min(1).optional(),
                   type:Ooi /* enum of the 40 keys below */, payload:z.unknown(), issuedAt:Hn /* number */ })
  ```
  CAS rule: for commands in `qft` (17 of them) `baseRevision` **and** `baseLogEpoch` are mandatory; for `Vft` (`applyFileRewind, forkAssistant, editUserQuery, retryTurn, setAssistantFeedback`) both are mandatory (error `"CAS commands require baseRevision and baseLogEpoch"`, byte 10524640).
* **CONFIRMED** — the full command catalog `KLr` (byte 10525225). **30 command types** with exact payload fields:

| type | payload fields (verbatim) |
|---|---|
| `createSession` | `{workspaceId, firstInput?:{text,attachments?:[{ref,fileName,mime,bytes,previewRef?}]}, config?:{provider?,model?,thought?,followupMode?:queue\|guide,mode?}, runtimeModel?, mcpServers?}` |
| `createSelectionSideSession` | `{firstInput?:{text}}` |
| `sendText` | `{text, attachments?, requestedDelivery?:startNow\|queue\|guide, browserAmbientContext?:{tabCount,currentUrl?}, heldQueueDisposition?:clearQueueAndSend\|keepQueueAndSend, expectedHeldQueueItemIds?, turnRuntimeModel?, automationId?, offPeakTaskId?, offPeakRunType?:init\|resume, botDeliveryTarget?, toolDisallowlist?}` |
| `sendGoalCommand` | `{text, displayText?, heldQueueDisposition?, expectedHeldQueueItemIds?}` |
| `stop` | `{expectedForegroundExecutionId?}` |
| `compact` | `{}` |
| `forkAssistant` | `{target:{rowId,entityId}}` |
| `applyFileRewind` | `{target}` |
| `editUserQuery` | `{target, newText, attachments?, workspaceMode?:preserve\|rewind}` |
| `retryTurn` | `{target}` |
| `setAssistantFeedback` | `{target, feedback:like\|dislike\|null}` |
| `sendQueuedNow` | `{queueItemId}` |
| `editQueueItem` | `{queueItemId,newText}` |
| `reorderQueueItem` | `{queueItemId,beforeQueueItemId:nullable}` |
| `deleteQueueItem` | `{queueItemId}` |
| `setAutoDrain` | `{autoDrain:boolean}` |
| `resolveInteraction` | `{interactionId, answer:{optionId?,freeText?,action?:accept\|decline\|cancel,content?}}` |
| `respondWorkspaceHookReview` | workspace-hook-review + `decision` |
| `toggleWorkspaceHookReviewItem` | `{…review, reviewItemId, enabled}` |
| `revokeWorkspaceHookTrust` | `{reviewItemIds[]}` \| `{all:true}` |
| `requestWorkspaceHookReview` | hook review request |
| `snoozeInteractionAutoResolution` | `{interactionId}` |
| `switchModelConfig` | `{provider,model,thought,runtimeModel?}` |
| `switchCollaborationMode` | `{mode:build\|edit\|plan\|yolo}` |
| `setFollowupMode` | `{mode:queue\|guide}` |
| `pauseGoal` / `resumeGoal` | `{}` |
| `cancelBackgroundWork` | `{workId}` |
| `renameSession` | `{title}` |
| `deleteSession` | `{}` |

* **CONFIRMED** — query pair:
  ```js
  JLr = { sessionId: string|null, commandId: string }              // .strict()
  YLr = { commands: JLr[].min(1).max(64) }                         // params of v4/commands/query
  Boi = { key: JLr, result: Loi | "unknown" }
  QLr = { results: Boi[].min(1).max(64) }                          // result
  Loi = { commandId, status:"accepted"|"rejected"|"stale"|"duplicate"|"noop"|"failed",
          reasonCode?, message?, revisionAtDecision:number, result?:Noi }
  ```
  Query waits for in-flight session "ready" flights first, then returns per-command status (byte 12344031). Command execution is `handleCommand` (byte 12341966): admission → durable input pinning → `host.executeCommand(envelope, ctx)` → ack `{status:"accepted", result?}`; failures produce `reasonCode` `fault.command.notImplemented` (byte 12343681) or `fault.command.executionFailed`; oversize projections → `proto.payloadTooLarge`.
  ⇒ **This is the cleanest MCP control surface: one `v4/command` call with `{type:"sendText", payload:{text}}` starts a turn; `v4/commands/query` polls the outcome.**

### 0.5 Attachment NDJSON envelope + `maxFrameBytes`

* **CONFIRMED** — `assertV4AttachmentNdjsonEnvelope` does **not** exist in this bundle (that symbol is desktop-side). The CLI's framing is:
  * line-delimited JSON, one envelope per line, `\n`-terminated: `send()` = `output.write(JSON.stringify(msg)+"\n")` and `onData()` splits on `"\n"`, `trim()`s each line, `JSON.parse`s (byte 12488436+).
  * **CONFIRMED limits object `nn`** (byte 355400):
    ```js
    nn = { maxFrameBytes: 1024*1024,                       // 1 MiB
           logicalFrameAssemblyMaxBytes: 16*1024*1024,     // 16 MiB
           logicalFrameAssemblyMaxFragments: 1024,
           logicalFrameAssemblyMaxConcurrent: 32,
           logicalFrameAssemblyMaxStagedBytes: 32*1024*1024,
           logicalFrameAssemblyTimeoutMs: 30000,
           transportEnvelopeIdMaxChars: 256,
           subscriberBufferMaxOps: 500, subscriberBufferMaxBytes: 1024*1024,
           eventRetentionPerSession: 2000, snapshotTailWindowRows: 60, rowsRangeMaxLimit: 200,
           toolOutputFinalHeadBytes: 32768, toolOutputFinalTailBytes: 32768,
           goalVerificationsRetained: 20, pendingCommandsDisplayMax: 32,
           commandPendingTtlMs: 24*60*60000, idempotencyTablePerSession: 512,
           conversationQueryTimeoutMs: 10000,
           attachmentMaxBytes: 20*1024*1024, attachmentChunkMaxBytes: 512*1024,
           attachmentPreviewMaxBytes: 31457280, attachmentPreviewMaxChunks: 60,
           attachmentReadCacheMaxBytes: 31457280, attachmentReadCacheTtlMs: 30000,
           attachmentUploadMaxChunks: 64, attachmentUploadMaxConcurrent: 16,
           attachmentUploadMaxStagedBytes: 64*1024*1024, attachmentUploadTtlMs: 300000,
           attachmentUnreferencedTtlMs: 24*60*60000 }
    ```
  * **CONFIRMED** — physical framing envelope `GLr` (byte 10522158): `{wireVersion:3, kind:"complete"|"fragment", deliveryKind, logicalFrameId, logicalFrameOrdinal, topic, subscriptionId, fragmentIndex, fragmentCount, logicalBytes, checksum:{algorithm:"crc32",value}, dataBase64}`; `encodeTopicWireFrames` splits oversized logical frames into base64 fragments with a binary-searched byte budget (`findFragmentByteBudget`) and throws `"proto.frameAssemblyTooLarge"` / `"proto.frameFragmentCountExceeded"` / `"proto.frameEnvelopeTooLarge"`. CRC32 is the standard IEEE polynomial expression `3988292384` (byte 466619).
  * **No separate handshake/hello message**: `v4/connection/flow` (`vc.connectionFlow`) *is* the handshake — params `VCe` (byte 10513158):
    ```js
    { connectionId:string, clientMode:"desktop-continuous"|"web-remote-replayable",
      workspace?:{workspacePath,workspaceIdentity?,remoteSessionId?,workspaceKey},
      legacyTaskIds?:string[<=200], resumeThoughtLevel?:string }
    ```
    and per-subscription acks `iCs/aCs/sCs/uCs = {ack:…}`. Server→client connection state notification: `{connectionId, state:"saturated"|"drained"|"closed"}` (byte 10512890).

---

## 1. Invocation contract — complete flag list

Entry point: `main()` = `$$i` (byte 12615193) → `run({argv, stdin, stdout, stderr})` = `U$i` (byte 12601956).
Parser: **`node:util.parseArgs`** (NOT commander/yargs), function `parseGlobalArgs` (`S$i`, byte 12597355), `allowPositionals:true, strict:true`.

**CONFIRMED — every accepted flag (verbatim option keys, `short` where present):**

| option key | type | short | notes |
|---|---|---|---|
| `help` | boolean | `-h` | prints `QGr(version,locale,detected)` help |
| `json` | boolean | | machine-readable output "where supported" |
| `output-format` | string | | one of `["text","json","stream-json"]` (`myn`); error: `` --output-format must be one of text, json, stream-json (received: X). `` |
| `no-color` | boolean | | |
| `no-browser` | boolean | | OAuth: print URL, don't open browser |
| `browser-use` | string | | only `headless` accepted, else `Unsupported --browser-use value: X. Supported value: headless.` |
| `browser-executable` | string | | requires `browser-use=headless` (`--browser-executable requires --browser-use=headless.`) |
| `prompt` | string | `-p` | headless single prompt; `""` → `--prompt requires non-empty text.` |
| `attach` | string, `multiple:true` | | repeatable; file types inferred (`inferAttachmentTypeFromPath`) |
| `cwd` | string | | resolved via `resolveCliWorkingDirectory`; bad path → error string to stderr |
| `locale` | string | | `en-US`, `zh-CN`, `auto` |
| `resume` | string | | `sess_…`; mutually exclusive with `--continue` |
| `target` | string | | headless goal objective; cannot be combined with `--prompt` |
| `target-replace` | boolean | | requires `--target` |
| `continue` | boolean | `-c` | resume latest session for cwd |
| `force` | boolean | `-f` | forwarded as `force` in globalOptions |
| `force-mcs` | boolean | | force mid-conversation system projection; only with `--prompt`/`--target`/`tui` |
| `mode` | string | | `build\|edit\|plan\|yolo` (lowercased; else `Unsupported --mode value: …`) |
| `verbose` | boolean | | prints stack traces |
| `version` | boolean | `-v` | prints `0.16.5` |
| `stdio` | boolean | | **declared, never read** (compat no-op) |
| `surface` | string | | `terminal` (default) → `terminal`, `desktop` → `zcode_desktop`; only valid with `--prompt`, `--target`, `app-server`, `agent-server` |

Pre-pass `extractDisallowedToolsArgs` (`M$i`, byte 12599040) strips `--disallowedTools` / `--disallowed-tools` (also `--disallowedTools=…`, `--disallowed-tools=…`) before parseArgs; multi-value parsing supports `(`-grouped rules and comma/space separators; `web_search` is aliased to `WebSearch`; `--disallowedTools` with no value → `` --disallowedTools requires at least one tool. ``

TUI-mode secondary parser `parseTuiModeArgs` (`Syn`, byte 12614671): `-c/--continue, -h/--help, --json, --cwd, --mode, --no-color, --prompt, --resume, --verbose, -v/--version` (non-strict).

**CONFIRMED — help text advertises flags that the parser will reject** (help lives at byte 11203600 en / 11213884 zh; verified 0 occurrences in the CLI arg region 12,597,000–12,616,200 for `settings`, `max-turns`, `permission-mode`, `allow-main-worktree-yolo`):
`--settings <path>`, `--permission-mode <mode>`, `--max-turns <n>`, `--allowed-tools <list>`, `--allow-main-worktree-yolo`. Because `strict:true`, passing them throws. **STRONGLY INFERRED: they are documented-but-unimplemented in this build (0.16.5).**

Also **CONFIRMED**: two hidden argv[0] forms handled before parseArgs:
* `__zcode-plugin-host <server-path> [-- <server-arg>...]` (`Vj="__zcode-plugin-host"`, byte 768604; handler `VDt`/`runPluginHostCommand` byte 839674) — imports the plugin server file, requires it to export `main()`, and rewrites `process.argv` to `[execPath, serverPath, ...args]`.
* `__internal-search find|grep …` (`x3i="__internal-search"`, byte 11864646) — embedded bfs/ugrep/ripgrep search shim, selected by `ZCODE_EMBEDDED_SEARCH_COMMAND`.
* `hooks trust status|review|grant|revoke` — `runHooksCommand` (`Bhn`, byte 12500263) with its own parser `parseTrustArgs`: `--workspace`, `--hook-digest` (multiple), `--all-current`, `--bundle-digest`, `--all`, `--json`, `-h/--help`.

---

## 2. Subcommands / modes

`switch(commandName(positionals))` — default when no positional is `"tui"` (byte 12605187).

| command | handler | interactive? | notes |
|---|---|---|---|
| *(none)* / `tui` | `runTuiCommand` (`U$i`→`cyn`) | **TUI (interactive)** | requires TTY; runs full-screen React/Ink-style UI (`initialMode`, `modelOptions`, `effortOptions`, `slashCommands`, `submitPrompt`, `setMode`, workflow panel…) |
| `app-server` / `agent-server` | `runZCodeProtocolCommand` (`z$i`) | **non-interactive, stdio daemon** | ZCode Protocol + v4 NDJSON server on stdin/stdout |
| `doctor` | `runDoctor` (`F$i`, byte 12600864) | non-interactive | JSON via `--json`; reports version/process/node/platform/sea/execPath/cwd |
| `login` | `rOe` | non-interactive-ish | Z.AI OAuth; opens browser unless `--no-browser` |
| `logout` | `nOe` | non-interactive | |
| `commands` | `Hhn` + `positionals.slice(1)` | non-interactive | `commands list` — custom slash commands; `--json` |
| `plugins` | `x_n` (byte 12574330) | non-interactive | `plugins list\|enable\|disable\|uninstall [id]`; uninstall prompts unless `--force` or non-TTY (refuses in non-interactive shell without `--force`); `--json` |
| `skills` | `mOe` | non-interactive | `skills list` |
| `version` | inline | non-interactive | prints `0.16.5` |
| `help` | `hOe` | non-interactive | |
| `hooks trust …` | `Bhn` | non-interactive | `status/review/grant/revoke`, `--json` |
| `__internal-search` | `qhn` | non-interactive | subprocess shim (`find`/`grep`) |
| `__zcode-plugin-host` | `VDt` | non-interactive | plugin entry launcher |
| *(anything else)* | — | — | `Unknown command: X` + help to stderr, exit 1 |

**Headless prompt path (no TUI):** if `--prompt <text>` is present, or `--target` is present (which synthesizes `/goal <objective>` or `/goal replace <objective>` via `buildHeadlessTargetCommand` `j$i`, byte 12600660), `runPrompt` (`gkt`, byte 12564026) runs **before** the subcommand switch. `--prompt` accepts slash commands inline (`/help`, `/login`, `/logout`, `/skill <name> <task>`, `/expert`, `/goal`).

**CONFIRMED** version-display rule: `-v/--version` short-circuits before any mode; `_yn()` check = `argv.includes("app-server")||argv.includes("agent-server")` gates the protocol console boundary.

---

## 3. Transport / IO — exact framing

**CONFIRMED — `ZCodeProtocolNdjsonConnection` (`X3e`, class at byte 12487786):**

```js
send(msg)      { this.options.output.write(`${JSON.stringify(msg)}\n`) }
onData(chunk)  { buffer += chunk; while ((i = buffer.indexOf("\n")) >= 0) { line = buffer.slice(0,i).trim(); …
                 if (line.length) dispatchLine(line) } }
```

* Delimiter: `\n` (LF). Empty lines ignored. Trailing partial line at stream close is dispatched once.
* **Request** (client→server) schema `x1n` (byte 418908):
  ```js
  { id: string|number, method: string(trim,min1), params?: unknown, trace?: {traceId?,parentId?,spanId?,traceparent?} }
  ```
  **Notification** schema `b1n`: `{method, params?, trace?}` (no id).
  **Success response** `w1n`: `{id, result: unknown}`.
  **Error response** `k1n`: `{id, error:{code:int, message:string(min1), data?:unknown}}`.
  *(No `"jsonrpc":"2.0"` field — the 20 `jsonrpc` literals in the bundle belong to the vendored MCP SDK at 7.2 MB and OTel semconv at 11.3 MB, not to this protocol.)*
* **Server→client requests** use negative-space ids `server-<n>` (`nextClientRequestId` starts at 1) — used for `interaction/requestPermission`, `interaction/requestUserInput`, `interaction/requestProviderRuntimeHeaders`, `interaction/requestOfficialMcpAuthHeaders`, `interaction/browserList`, `interaction/browserExecute`, plus re-announce retry with exponential backoff to `uzi`.
* **Error codes CONFIRMED**: `-32700` parse error (`sendError("parse-error",-32700,"Parse error")`), `-32600` invalid message (`"Invalid ZCode Protocol message"`, includes zod `issues` in `data`), `-32601` `` Method not found: ${method} ``, `-32602` invalid params (`"sessionId is only supported for imported history creates"`), `-32603` internal (`toProtocolError`, HTTP-ish fallback / `"v4 gateway is not initialized"`), `-32004` `sessionUnavailable` (`XB={sessionUnavailable:-32004}`), `-32010` `"A prompt is already running for this session"`, `-32020` `` No ZCode Protocol client is attached for ${method} ``, `-32021` `` Client request cancelled: ${method} ``, `-32022` `` Client request timed out: ${method} `` (data `{timeoutMs}`), `-32031` restore-warning (`{code,sessionId,workspace}`).
* Ordering: responses to requests are queued (`processing` promise chain) but `session/stop` **bypasses the queue** (`shouldBypassProcessingQueue`: `"id" in msg && msg.method === rr.sessionStop`) so stop is never blocked behind a long turn.
* Post-response batched frames: `takePostResponseBatch(id)` → `{messages, commit}`; used by `v4/conversation/subscribe|resync` to deliver initial `v4/conversation/frame` notifications *after* the ack in the same connection.
* Representative exchange:
  ```json
  {"id":1,"method":"session/create","params":{"workspace":{"workspacePath":"F:\\proj","workspaceKey":"F:\\proj"},"mode":"yolo","persistence":"immediate"}}
  {"id":1,"result":{"sessionId":"sess_…","messages":[],"stateRevision":1, …snapshot}}
  {"method":"plugins/operationProgress","params":{…}}
  {"id":2,"method":"session/send","params":{"sessionId":"sess_…","content":"hello"}}
  {"id":2,"result":{"sessionId":"sess_…","accepted":true,"stateRevision":2}}
  {"method":"process/resourceSample","params":{"platform":"win32","arch":"x64", …}}
  ```
  (result shape of `session/create` = `E2(...)` snapshot; send result = `hKi`.)

**Other IO:**
* `--output-format stream-json` (headless prompt only) → NDJSON on stdout via `mapSessionEvent` (`qMe`, byte 11987513): `{deliveryKind, eventId, payload, seq, sessionId, timestamp, traceId, turnId?, type}` where `type` ∈ the session-event enum `V` (byte 567761: `session_created, session_resumed, session_forked, session_compacted, session_title_updated, session_mode_changed, session_ended, turn_started, turn_input_received, turn_steer_*, session_input_promoted, queue_auto_drain_changed, followup_mode_changed, turn_complete, turn_error, user_message, assistant_message, assistant_feedback_updated, system_message, model_request, model_selected, model_streaming, streaming_tool_ledger_updated, stream_recovery_*, model_network_status, model_anomaly_warning, network_request_status, model_complete, model_error, tool_call_scheduled, tool_call_started, tool_call_progress, tool_call_result, tool_call_error, tool_batch_complete, background_task_started/updated/completed, permission_requested/resolved/denied, user_input_auto_resolution_updated, …`).
* `--json`/`--output-format json` → single pretty JSON (`JSON.stringify(x,null,2)`).

---

## 4. Every listener in the bundle

| # | listener | bind | port | auth | evidence |
|---|---|---|---|---|---|
| 1 | **OAuth callback HTTP server** (`node:http createServer`) | `127.0.0.1` literal `Aat` | **`listen(0,…)` ephemeral** | CSRF `state` query param + one-shot promise | byte 7166188–7167600; replies `d6o="Authorization successful!…"` / `fte="Authorization failed.…"` |
| 2 | **Node-REPL browser broker** (`node:net createServer`) | Windows: `\\.\pipe\zcode-node-repl-<uuid>` ; else `join(tmpdir(),"znr-<uuid>.sock")` | n/a (pipe/socket) | **32-byte hex token**, `crypto.timingSafeEqual`; rejects `runtimeScope==="subagent"` | byte 11928248–11930000 (`_Oi`=createSocketPath, `yOi`=handleSocket, `xOi`=authorizeRequest). Request ≤1 MiB (`hOi=1024*1024`), request id must be a UUID, one JSON line in, one JSON line out `{id, ok, result?|error?}`. Socket path + token injected into MCP child env as `ZCODE_NODE_REPL_BROWSER_BROKER_SOCKET` / `ZCODE_NODE_REPL_BROWSER_BROKER_TOKEN` (byte 551104/551148) |
| — | **no HTTP/WS RPC server** | — | — | — | 0 hits for `WebSocketServer` / `Sec-WebSocket` / `101 Switching` / `wss://`; hono/express/fastify absent |

The broker request schema `QPt`/`KPt` (byte 551200): `{id:uuid, runtimeScope:"main"|"subagent", token:min32, sessionId, turnId?, trace:{traceId,spanId,…}, op:"list", sessionId, turnId}` or `{op:"execute", browserId, browserGeneration, sessionId, turnId, command}`.

**HYPOTHESIS (needs `zcode-agent.exe` / desktop host):** the `websocketRpc` + `authRequired` + `{capability,expiresAt}` descriptor is consumed by the CLI when *attaching to* a remote workspace host. This artifact contains no server for it.

---

## 5. Headless / programmatic control

**CONFIRMED — end-to-end turn without a TUI, two ways.**

### 5.1 One-shot: `zcode -p "<prompt>" [--output-format text|json|stream-json] [--mode yolo] [--cwd …] [--resume sess_…] [-c] [--attach f] [--disallowedTools …]`
Entry chain: `main($$i)` → `run(U$i)` → `runPrompt(gkt, 12564026)` → `dOe(n,o)` builds browser control port → `createZCodeApp(...)` (app factory `Nbt`) → `app.submitPrompt(text | {text, attachments}, {abortSignal, onEvent?})` → returns `{traceId, turnId, response, usage, events, projection}`.
Output:
* text (default): `stdout.write(response + "\n")`.
* `--json`/`--output-format json`: `{sessionId, traceId, turnId?, response, usage?, eventCount, workspaceHookTrust?, projection:{status,turnCount,totalTokenCount,contextUsed,contextWindow}}`.
* `--output-format stream-json`: NDJSON events (via `mapSessionEvent`) **then** a final line `{"type":"result", sessionId, traceId, turnId?, response, usage?, eventCount, projection:{…}}` — the `type:"result"` literal is at byte 12567102. `wantsEventStream = outputFormat === "stream-json"`, `wantsJsonSummary = json || outputFormat ∈ {json, stream-json}` (`h_n`/`Y9i`, byte 12563562).

### 5.2 Long-lived: `zcode app-server --stdio` (or `agent-server --stdio`)
`runZCodeProtocolAgent` (`Ahn`, byte 12492681) constructs: telemetry env → MCP port (`gIr`) → session store (`Ssn`/sqlite) → `new Q3e({createZCodeApp})` (app factory with per-session `mcpPortFactory`) → Node-REPL broker (`PMe`) → `new X3e({input:stdin, output:stdout, handleMessage: app.handleMessage, onTransportClosed: app.disconnectClient, takePostResponseBatch})` → `O.start()`. Process exits when stdin closes. Cleanup order (1.5 s `hzi` budget each): resource sampler → MCP telemetry → Node-REPL broker → MCP adapter → session store → telemetry.

### 5.3 Param schemas for the priority v1 methods (all `.strict()`)

```js
// session/create  (wEt)                       byte 439447
{ sessionId?:string, workspace:{workspacePath,workspaceIdentity?,remoteSessionId?,workspaceKey},
  parentSessionId?:string, mode?:("plan"|"build"|"edit"|"yolo"|"auto"),
  model?:{providerId,modelId,variant?}, runtimeModel?:…, persistence?:("immediate"|"deferred"),
  thoughtLevel?:string, titleGenerationEnabled?:boolean, mcpServers?:McpServerSpec[],
  toolAllowlist?:string[], toolDenylist?:string[], importedHistory?:{source:"claudeCode",title?,…,messages:[{role:"user"|"assistant",content,timestamp?}]} }
// session/send    (OEt)                       byte 442066
{ sessionId:string, inputId?:string, queryId?:string, content:string, attachments?:unknown[],
  browserAmbientContext?:{tabCount:1..100,currentUrl?}, expectedRevision?:int>=0,
  expectedProviderRevision?:string, expectedModelRuntimeRevision?:string, runtimeModel?:…,
  automationId?:string, offPeakTaskId?:string, offPeakRunType?:("init"|"resume"),
  botDeliveryTarget?:…, toolDenylist?:string[] }          // automationId XOR offPeakTaskId
// → result hKi {sessionId, accepted:true, stateRevision, modelRuntimeRevision?}
// session/read    (EEt)                       byte 441640
{ sessionId, deliveryKind?:("desktop-continuous"|"web-remote-replayable"), messageLimit?:int>0, afterSeq?:int>=0 }
// session/messages (AEt)  { sessionId, afterMessageId?, limit? }        → {messages}
// session/events   (REt)  { sessionId, afterSeq?, limit? }             → {events}
// session/subscribe (xEt) { sessionId, deliveryKind, afterSeq?, includeSnapshot? }
//                          → {eventSeq, events, sessionId, snapshot?}
// session/subagents (IEt) { sessionId, endedCursor?, endedLimit:default20,max100 }
// session/resume  (GEt)   { workspace, runtimeModel?, preferWorkspaceDefaults? }
// session/fork    (DEt)   { sessionId, target:{kind:"turn"|"message"|"checkpoint"|"latestCheckpoint",…}=latestCheckpoint, expectedRevision? }
// session/compact (NEt)   { sessionId, inputId?, instructions?, expectedRevision?, runtimeModel? }
// session/goal    (LEt)   { sessionId, inputId?, action:show|set|replace|pause|resume|clear, objective?, expectedRevision? }
// session/setModel(zEt)   { sessionId, model:{providerId,modelId,variant?}, runtimeModel?, expectedRevision?, persistAsWorkspaceLastUsed=true }
// session/setThoughtLevel(UEt) { sessionId, thoughtLevel?, runtimeModel?, expectedRevision?, persistAsWorkspaceLastUsed=true }
// session/updateRuntimeModelConfig($Et) { sessionId, runtimeModel, applyModelSelection=true }
// session/setMode (qEt)   { sessionId, mode, expectedRevision? }
// session/close   (VEt)   { sessionId, expectedPersistence? }   → {closed?}
// session/cancelBackgroundTask(FO) { sessionId, taskId }        → {cancelled, reason?, snapshot?, status, taskId}
// session/list    (SEt)   { workspace?, includeArchived=false, limit? } → {sessions:[…]}
// session/usage   (CEt)   { sessionId }   usage/stats (TEt) { range, timeZone? }
// workspace/readState (bkn) { workspace, settings, modelCatalog?, slashCommands? }  byte 439158-region
// workspace/hooks/trustGrant (tj) { workspace, bundleDigest:sha256hex, hookDeclarationDigest:sha256hex }
// interaction answer (z2) { decision:"allow"|"deny"|"escalate"|"modify", reason?, modifiedInput?, permissionUpdates?:[{type:"addRules",behavior:"allow"|"deny"|"ask",rules:[{toolName,ruleContent?}]}] }
// task snapshot (Tkn): taskId, toolCallId?, toolName?, taskKind:"bash"|"subagent"?, blocked?, cancellable?, command?, description?, status:"running"|"completed"|"failed"|"timed_out"|"cancelled"|"spawn_error"|"lost", pid?, startedAt?, completedAt?, outputPath?, stdout/stderrPersistedOutputPath?, outputBytes?, outputTruncated?, stdout/stderrTail?, terminalId?
```

**Result envelope shared by `session/create`, `session/read`, `session/fork`, `session/compact`, `session/goal` — snapshot `pce` (byte 430310):**
```js
{ protocol:{name:"ZCode Protocol", version:1},      // literal protocol/version echo
  session:qBe, settings:hEt, projection:q1n, runtime:tCt,
  messages:[GBe], goalStats?, todos?, todoGroups?, slashCommands? }   // .strict()
```
`session/create` therefore returns the full snapshot (including `messages`), and `session/read`/`session/messages` gate on `deliveryKind` + `messageLimit`/`afterSeq`/`afterMessageId`.

**Desktop v4 frame vocabulary (server→client notification `v4/conversation/frame`, event kinds `aKi`, byte 431000):** `session.created, session.resumed, session.updated, session.titleUpdated, session.closed, turn.started, turn.steerQueued, turn.steerDrained, turn.completed, turn.failed, message.upserted, message.removed, part.started, part.delta, part.upserted, part.removed, model.streaming, tool.updated, permission.requested, permission.resolved, userInput.requested, userInput.resolved, checkpoint.created, rewind.triggered, streamRecovery.updated`.

---

## 6. Tools registry

**CONFIRMED — built-in tool contracts array `dft` (28 entries) registered by `registerBuiltInTools` (`BL`, byte 10463920).** Each entry shape:
```js
{ capability, metadata:{name, description, readOnly, destructive, concurrentSafe, timeoutMs?, maxOutputBytes, sideEffectScope, riskLevel, needsApproval, providerVisible?},
  handler, validateInput?, resolveModelContract?, formatModelContent?, inputSchema, outputSchema,
  runtimeInputSchema, runtimeOutputSchema,
  permission:{permission, reason, riskLevel, sideEffectScope, needsApproval, patternSources[], alwaysAllowPatternSources[], denyPriority},
  resultBudget:{maxInlineBytes,maxModelBytes,strategy:"truncate"|"artifact",preview:{maxBytes,direction},artifact?},
  timeout:{defaultMs,maxMs,allowCallOverride} | {kind:"none"},
  cancellation:{supported,cleanup,userVisibleMessage}, trace:{…} }
```

| # | tool name | var | offset | notes / runtime input schema |
|---|---|---|---|---|
| 1 | `Read` | UAr | 9880587 | `{file_path, offset?, limit?, pages?}` — `file_path` "The absolute path to the file to read"; maxOutputBytes `nx`; timeout 30 000 ms |
| 2 | `Write` | OPr | 10007499 | `{file_path, content}` |
| 3 | `Edit` | KPr | 10022136 | `{file_path, old_string, new_string, replace_all=false}` |
| 4 | `Bash` | lTe | 10108055 | `{command, timeout?, description?, run_in_background?, dangerouslyDisableSandbox?}` (`.strict()`, byte 800000) |
| 5–7 | `js`, `js_reset`, `js_add_node_module_dir` | nCe/sDr/uDr | 10328283/… | Node REPL / Code-Act; gated by `includeNodeRepl`; browser variant by `includeBrowserUse`; also exposed as `mcp__node_repl__js*` |
| 8 | `Glob` | lDr | 10331914 | `{pattern, path?}`; dropped when `embeddedSearchEnabled` |
| 9 | `Grep` | dDr | 10336190 | `{pattern, path?, glob?, output_mode?:"content"\|"files_with_matches"\|"count", -B?, -A?, -C?, context?, -n?, -i?, -o?, multiline?, head_limit?, offset?, type?}` |
| 10 | `WebFetch` | qDr | 10367337 | name const `zp="WebFetch"`; `{url, prompt}`; UA `mDr="ZCode-WebFetch/0.1 (+https://zcode.ai; coding-agent-cli)"`; needsApproval |
| 11 | `WebSearch` (provider-native) | e6r | 10374822 | name `mCe="WebSearch"`, alias literal `vti="web_search"`; `{query, allowed_domains?, blocked_domains?}`-style |
| 12 | `TodoRead` | S6r | 10400620 | `{}` |
| 13 | `TodoWrite` | I6r | 10401616 | `{todos:[{content,status:pending\|in_progress\|completed,priority:high\|medium\|low}]}` |
| 14–17 | `CronCreate`, `CronList`, `CronUpdate`, `CronDelete` | C6r/E6r/A6r/R6r | 10405166+ | gated by `includeAutomation` |
| 18 | `EnterPlanMode` | bCe | 10424127 | name `a4="EnterPlanMode"`; `{}` |
| 19 | `ExitPlanMode` | z6r | 10424820 | name `hl="ExitPlanMode"` |
| 20 | `AskUserQuestion` | H6r | 10429001 | name `jy` |
| 21 | `SendMessage` | K6r | 10431998 | name `_K`; gated by `includeSendMessage` |
| 22 | `RespondToCoordinator` | Y6r | 10434177 | name `Fy`; gated by `includeRespondToCoordinator` |
| 23 | `TaskOutput` | aNr | 10442674 | name `Qj`; "read output/logs from a background task" |
| 24 | `TaskStop` | dNr | 10445938 | name `eF` |
| 25 | `ReadSessionContext` | ONr | 10460614 | name `Yde`; "Read bounded context from another persisted ZCode session by session id" |
| 26 | `Agent` | NL | 10394716 | `{description, prompt, subagent_type?}` (+async launch result `{status:"async_launched", agentId, childSessionId, backgroundTaskId, outputFile, canReadOutputFile}`) |
| 27 | `Task` | v6r | 10395827 | **providerVisible:false**, exact copy of Agent — Claude-Code compatibility alias (name `Uq="Task"`) |
| 28 | `Skill` | w6r | 10397365 | loads skill markdown into context; `${CLAUDE_SKILL_DIR}`/`${ZCODE_SKILL_DIR}` substitution |

**CONFIRMED — provider-visible ordering set `eli`** (31 names, byte 10768497): `Agent, AskUserQuestion, Bash, CronCreate, CronDelete, CronList, CronUpdate, Edit, EnterPlanMode, EnterWorktree, ExitPlanMode, ExitWorktree, Glob, Grep, LSP, NotebookEdit, Read, ScheduleWakeup, Skill, TaskCreate, TaskGet, TaskList, TaskOutput, TaskStop, TaskUpdate, TodoRead, TodoWrite, WebFetch, WebSearch, Workflow, Write` — plus a separate allow-list `mCn` (byte 546560): `Read, Write, Edit, ApplyPatch, Bash, Glob, Grep, WebFetch, WebSearch, web_search, TodoRead, TodoWrite, GoalRead, ReadSessionContext, AskUserQuestion, SendMessage, RespondToCoordinator, TaskOutput, TaskStop, js, js_reset, js_add_node_module_dir, mcp__node_repl__js, mcp__node_repl__js_reset, mcp__node_repl__js_add_node_module_dir, Agent, Task, Skill`.

**CONFIRMED — tool gating in `registerBuiltInTools`:** `allowedTools` set filter; `disallowedTools` rule set (name or `Name(spec)` rule, aliases `web_search→WebSearch`); `embeddedSearchEnabled` removes `Glob`/`Grep`; `includeAgent`, `includeSkill`, `includeSendMessage`, `includeRespondToCoordinator`, `includeWorkflow`, `includeAutomation`, `includeNodeRepl`, `includeBrowserUse` flags. Permissions: read-only set `{Read,Glob,Grep,WebSearch,WebFetch,TodoRead,TodoWrite,AskUserQuestion,Agent,Task,Skill}`; write set `{Write,Edit,ApplyPatch,Bash}`; destructive `{Bash}` (byte 10674690).

**CONFIRMED — MCP tool naming:** `mcp__${sanitize(serverName)}__${sanitize(toolName)}`, sanitize = `replace(/[^a-zA-Z0-9_-]/g,"_").replace(/_+/g,"_")` (byte 7583573 and `h2`/`Tw` at 10551287). MCP child isolation enum `session|workspace`; servers come from `mcpServers` in plugin manifests/`.mcp.json` or inline `session/create` params (`fZ` schema: `{name,command,args,env:[{name,value}],isolation?,protocolVersion?:"legacy"|"auto"|"2026-07-28",timeoutMs?}` or `{name,type:"http"|"sse",url,headers,oauth?,…}`).

---

## 7. Session / persistence

**CONFIRMED** — `SqliteSessionStore` (`hpe`, byte 937567) uses **`node:sqlite` `DatabaseSync`** (byte 937789). DB path: **`~/.zcode/cli/db/db.sqlite`** (`Q9e()`, byte 882429). Alternative root override: `ZCODE_STORAGE_DIR` (then `<root>/cli/db/db.sqlite`); `ZCODE_BETA=1`/`ZCODE_ENV=beta` or a `zcode-beta*` argv[0] switches storage root to `~/.zcode-beta` (byte 553209). WAL enforced with retry (byte 879533); schema_migration table `(id, checksum, app_version, time_applied)` with sha256 immutability checks (byte 880900).

**Migration list `f6t` (byte 854351) — 18 migrations, verbatim ids:** `0001_base_session_store`, `0002_local_setting`, `0003_backfill_permission_local_setting`, `0004_session_target`, `0005_session_target_accounting`, `0006_input_history_attachments`, `0007_workflow_script_runtime`, `0008_workflow_definition_scope`, `0009_session_title_metadata`, `0010_usage_observability`, `0011_session_target_summary_title`, `0012_session_trace_id`, `0013_session_target_active_run_accounting`, `0014_message_part_sequence`, `0015_message_part_sequence_backfill_and_guard`, `0016_session_input_ledger`, `0017_session_input_start_now_delivery`, `0018_session_input_failed_status`.

**Tables:** `session(id, project_id, workspace_id, parent_id, slug, directory, path, title, version, share_url, summary_additions, summary_deletions, summary_files, summary_diffs, revert, permission, time_created, time_updated, time_compacting, time_archived, task_type, title_source, title_message_id, time_title_updated, trace_id, sequence…)`, `message(id, session_id FK, time_created, time_updated, data JSON)`, `part(id, message_id FK, session_id, time_created, time_updated, data JSON, sequence)`, `todo(session_id, content, status, priority, position, PK(session_id,position))`, `session_entry(id, session_id, type, time_created, time_updated, data)` — event store, filterable by type (`v4/command_fact`, `verifier` entries, `goal`, `RewindTriggered` are seen as `type` values), `permission(project_id, data)`, `input_history(id, project_id, session_id, text, kind, time_created, attachments)`, `local_setting(scope, scope_id, namespace, key, value, schema_version, …)`, `session_target(session_id PK, target_id, objective, status active|paused|budget_limited|complete, token_budget, tokens_used, time_used_seconds, summary_title, active_input_id, active_run_started_at, active_run_last_seen_at, …)`, `workflow_definition(id, name, source builtin|user, trusted, enabled, script_path, script_hash, meta_json, scope)`, `workflow_run(id, definition_id, name, kind, parent_session_id, cwd, script_path, script_hash, args_json, args_hash, status pending|running|paused|completed|failed|cancelled, current_phase, budget_total, budget_spent, stats_json, failure_json, times…)`, `workflow_activity(run_id, parent_activity_id, call_index, call_path, attempt, type, phase, label, input_hash, prompt, opts_json, status queued|running|completed|failed|skipped|cancelled|cached|lost, child_session_id, result_json, error_json, UNIQUE(run_id,call_path,attempt))`, `workflow_event(run_id, sequence, type, phase, activity_id, payload_json, UNIQUE(run_id,sequence))`, `session_task_link(id, root_workflow_run_id, parent_link_id, activity_id, parent_session_id, child_session_id UNIQUE, role, depth, path, phase, label, agent_type, model, status)`, `model_usage(… provider_id, model_id, variant, agent, mode, task_type, status running|completed|error|cancelled, started_at, first_token_at, completed_at, duration_ms, time_to_first_token_ms, finish_reason, tool_call_count, input/output/reasoning/cache_creation/cache_read tokens, provider_total_tokens, computed_total_tokens, retry_count, retryable, cancelled_by_user, context_exceeded, error_type/code/message, raw_usage_json, provider_metadata_json)`, `turn_usage(session_id, turn_id, …)`, `tool_usage(…)`, `session_input(…)` (input ledger with start-now delivery + failed status), `schema_migration`.

Legacy/alternate readers: `resolveLatestSession`/`listZCodeSessions` (byte 12500105) open `u4({dbPath:Wae(ns({env}).…)})`; `Wae` = storage-root resolver (byte 11784096).

---

## 8. Model providers, base URLs, auth env

**CONFIRMED — built-in provider ids (`ys`, byte 412790):**
```js
V2="builtin:"; ys={ zai:"builtin:zai", zaiCodingPlan:"builtin:zai-coding-plan", zaiStartPlan:"builtin:zai-start-plan",
                     bigmodel:"builtin:bigmodel", bigmodelCodingPlan:"builtin:bigmodel-coding-plan",
                     bigmodelStartPlan:"builtin:bigmodel-start-plan", zapi:"builtin:zapi" };
```
Provider families (`dFe`, byte 510190): `{id:"zai", label:"Z.ai", rootDomain:"z.ai", oauthProviderId:"zai", apiKeyProviderId:builtin:zai, startPlanProviderId:builtin:zai-start-plan, codingPlanProviderId:builtin:zai-coding-plan}` and `{id:"bigmodel", label:"BigModel", rootDomain:"bigmodel.cn", …}`.
Kind/api-format enums (byte 418xxx): kind `anthropic | openai | openai-compatible`; api format `anthropic-messages | openai-chat-completions | openai-responses`; provider source `builtin | models-dev | custom | user | workspace | ephemeral`.
Reasoning levels `sce=["max","high","nothink"]`, default `max`; model family detection `glm-5.2` prefix / `^glm-\d{4}` / `glm-5.3`.

**CONFIRMED base URLs (verbatim):**
* `https://api.z.ai/api/anthropic` (byte 6962793) — Z.AI Anthropic-compatible endpoint
* `https://open.bigmodel.cn/api/anthropic` (6962673) — BigModel Anthropic-compatible
* `https://api.z.ai` (7160906) — coding-plan biz API (`/api/auth/z/login`, `/api/biz/customer/getCustomerInfo`, `/api/biz/v1/organization/{org}/projects/{proj}/api_keys`, key name `zcode-api-key`)
* `https://zcode.z.ai/api/v1` (7163800) — CLI OAuth (`/oauth/cli/init`, `/oauth/cli/poll/{flowId}`)
* `https://zcode.z.ai` (396461), `https://bigmodel.cn` (396519), `https://dev.bigmodel.cn` (396545)
* `https://api.anthropic.com/v1` (4179009), `https://api.openai.com/v1` (4315935), `https://openrouter.ai/api/v1` (5574907)
* Logo/portal: `https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json` (byte 544583, official plugin marketplace)
* ~80 further third-party URLs are the vendored models.dev registry (zenmux, minimax, novita, groq, deepseek, xai, perplexity, ollama.com, etc.) — full list in the scan output; each is a *provider base URL* literal.
* Env-driven overrides: `ZCODE_PRODUCTION_BASE_URL`, `ZCODE_TEST_BASE_URL`, `ZCODE_BASE_URL`, `ZCODE_ENDPOINT_ORIGIN`, `BIGMODEL_API_BASE_URL`, `BIGMODEL_PRODUCTION_API_BASE_URL`, `BIGMODEL_TEST_API_BASE_URL` (byte ~395300–395800), plus standard `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`.

**CONFIRMED OAuth flows:** Z.AI CLI OAuth — POST `{provider:"zai"}` to `/oauth/cli/init` with `Authorization: Bearer <poll_token>` → `{authorize_url, expires_at, flow_id, poll_interval_sec, poll_token}`; GET `/oauth/cli/poll/{flow_id}` → `pending|failed|ready` with `ready = {token, user:{user_id,email?,name?,avatar?}, zai:{access_token}}` (byte 7160800–7164200). BigModel OAuth — authorize URL `<origin>/login?appId&redirect&state`; exchange POST `/api/auth/tokenByAuthCode` `{appId,appSecret,authCode}` → `data.accessToken(+refreshToken)`; loopback server on `127.0.0.1:0` (byte 7156500, 7166188). Credentials at `~/.zcode/v2/credentials.json` (encrypted values, `ZCODE_CREDENTIAL_SECRET` default; keys `activeProvider`, `zaiAccessToken`, `zaiRefreshToken`, `zaiUserInfo`, `zcodeJwtToken`), written with file-lock + atomic rename (byte 7165723, 7170100).

**CONFIRMED provider key env vars (sampled from the models.dev catalog):** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `AI_GATEWAY_API_KEY`, `AZURE_API_KEY`/`AZURE_RESOURCE_NAME`, `GEMINI_API_KEY`/`GOOGLE_API_KEY`/`GOOGLE_GENERATIVE_AI_API_KEY`, `GOOGLE_VERTEX_PROJECT`/`GOOGLE_VERTEX_LOCATION`/`GOOGLE_APPLICATION_CREDENTIALS`, `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_REGION`/`AWS_BEARER_TOKEN_BEDROCK`, `CLOUDFLARE_API_KEY`/`CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_GATEWAY_ID`, `DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY`, `MISTRAL_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `XAI_API_KEY`, `PERPLEXITY_API_KEY`, `TOGETHER_API_KEY`, `FIREWORKS_API_KEY`, `BASETEN_API_KEY`, `DEEPINFRA_API_KEY`, `NEBIUS_API_KEY`, `NOVITA_API_KEY`, `SILICONFLOW_API_KEY`/`SILICONFLOW_CN_API_KEY`, `MODELSCOPE_API_KEY`, `DASHSCOPE_API_KEY`, `LLMGATEWAY_API_KEY`, `HF_TOKEN`, `GITHUB_TOKEN` (+ `api.githubcopilot.com`), `OLLAMA_API_KEY`, plus `ZCODE_API_KEY`. Retry tuning env: `ZCODE_MODEL_RETRY_MAX_RETRIES`, `ZCODE_MODEL_RETRY_BASE_DELAY_MS`, `ZCODE_MODEL_RETRY_MAX_DELAY_MS`, `ZCODE_MODEL_RETRY_BACKOFF_FACTOR` (byte 4496562+).

---

## 9. Plugin loading

**CONFIRMED — on-disk format (verified on `E:\zcode\resources\glm\packages\*`):**
```
<pkg>/.zcode-plugin/plugin.json      ← manifest
<pkg>/.mcp.json                      ← MCP servers, Claude-Code-compatible (uses ${CLAUDE_PLUGIN_ROOT})
<pkg>/skills/<name>/SKILL.md         ← skills
<pkg>/commands/<name>.md             ← custom slash commands
<pkg>/hooks/hooks.json               ← hooks, e.g. {"hooks":{}}
<pkg>/agents/<name>.md               ← subagent profiles
<pkg>/dist/mcp/server.js             ← MCP server entry
```
Manifest fields seen: `name, version, description, author{name}, license, skills:"skills", commands:"commands", mcpServers:{<name>:{command|type, args[], cwd?, env{}, timeoutMs?}}, userConfig:{<key>:{type,default,description}}`. Placeholders substituted at launch: `${ZCODE_PLUGIN_ROOT}`, `${ZCODE_PLUGIN_DATA}`, `${ZCODE_PROJECT_DIR}`, `${user_config.<key>}`, `${CLAUDE_*}`, `${ZCODE_SKILL_DIR}`/`${CLAUDE_SKILL_DIR}` (byte 10396600).

**CONFIRMED — plugin-host activation:** `__zcode-plugin-host <server-path> [-- <args...>]` → `runPluginHostCommand` (`VDt`, byte 839674): resolve path → `import(pathToFileURL(f))` → require exported `main()` → set `process.argv=[execPath, serverPath, ...args]` → `await main()`. Guard `assertCapturedBrokerLaunchIsAuthorized` (`$Pn`): if `{socket, token, pluginAuthority}` are present, it refuses unless `ZCODE_PLUGIN_ID === "computer-use@zcode-plugins-official"` **and** `--permission-broker-socket` value matches the captured socket — error `"Captured ZCode CUA broker credentials may only launch the bundled official product plugin"`.

**CONFIRMED — marketplaces (`sPt`, byte 544492):**
```js
[{id:"zcode-plugins-official", source:"https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json",
  name:"zcode-plugins-official", description:"Official ZCode plugins marketplace: built-in and community plugins for ZCode.", pluginCount:0},
 {id:"claude-plugins-official", source:"anthropics/claude-plugins-official", …}]
```
Plugin id form `<name>@<marketplace>` (e.g. `computer-use@zcode-plugins-official`, alias `zcode-cua@zcode-plugins-official`). Host config fields (zod, byte 6951200): `{enabled?, dirs?:string[], enabledPlugins?:{[id]:bool}, extraKnownMarketplaces?:{[id]:{source}}, options?:{[plugin]:{[key]:{enable?}}}, suppressedBuiltins?:string[]}`. Plugin list output fields (byte 12574400): `id, name, version, source, marketplace, rootPath, manifestPath, dataPath, enabled, skillCount, skillRootCount, commandRootCount, declaredMcpServerNames, mcpServerNames, hookDetails[{command,event,runnable,sourcePath,type,args?,async?,matcher?,shell?,statusMessage?,timeout?,timeoutMs?}]`. Plugin diagnostics carry `{code,message,severity,path?,pluginId?}`. Loader entry points exported from the bootstrap module: `listZCodePlugins`, `setZCodePluginEnabled`, `uninstallZCodeMarketplacePlugin`, `resolveZCodePlugins` (`zd`).

**CONFIRMED — hook events** (`on`, byte 763459): `SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, PostToolUseFailure, Stop`; hook results `success|blocked|failed|cancelled|timed_out`; hook stdin JSON includes `hook_event_name, session_id, transcript_path, cwd, permission_mode, tool_name, tool_input, tool_use_id` plus a generated `transcript.jsonl` in `tmpdir()/zcode-claude-hook-<rand>` (byte 10464800). Hook trust model: workspace hooks must be explicitly trusted (`hooks trust grant --workspace <id> --hook-digest <sha256>` or `--all-current --bundle-digest <sha256>`), trust file `workspace-hook-trust-v1.json`, statuses `trusted_persistent` etc.; blocked reasons `workspace_hooks_pending_trust`, `workspace_hooks_require_trust_capable_host`, `workspace_hooks_feature_disabled`, `workspace_hooks_blocked_by_policy`, `workspace_hooks_bundle_changed`, `workspace_hooks_snapshot_mismatch`.

---

## 10. Environment variables (all read sites)

| var | context (byte) |
|---|---|
| `ZCODE_STORAGE_DIR` | storage root override; default `~/.zcode` (553209) |
| `ZCODE_BETA`, `ZCODE_ENV` | `"1"`/`"beta"` → `~/.zcode-beta` (553250) |
| `ZCODE_DATA_BASE_DIR` | data dir base (4688799) |
| `ZCODE_APP_VERSION` | telemetry/product version (7381, 11764769) |
| `ZCODE_HOME` | home override (11764212) |
| `ZCODE_BUILD_COMMIT_ID`, `ZCODE_RUNTIME_ENV` | telemetry (11764535/11764624) |
| `ZCODE_DEBUG`, `ZCODE_LOG_DIR`, `ZCODE_LOG_CONSOLE` | logging (7435, 6933678, 6933768) |
| `ZCODE_FILE_LOCK_TIMEOUT` | file-lock timeout ms (8398) |
| `ZCODE_WINDOWS_OUTPUT_ENCODING` | win console encoding (1503829) |
| `ZCODE_E2E_COVERAGE`, `ZCODE_E2E_FS_FAULTS`, `ZCODE_E2E_FS_FAULTS_ALLOW`, `ZCODE_E2E_ASK_USER_QUESTION_CLOCK_SCALE` | test hooks (841682, 845274, 845300, 544277) |
| `ZCODE_MODEL_TELEMETRY_ENABLED` | telemetry toggle (534417) |
| `ZCODE_TELEMETRY_*` (`_DEVICE_MID`, `_USER_ID`, `_USER_ID_HASH`, `_USER_SUBJECT_ID`, `_IDENTITY_STATE`, `_RUNTIME_SURFACE`, `_RUNTIME_DISTRIBUTION`) | telemetry identity (534392–536070) |
| `ZCODE_RUNTIME_ENV`, `ZCODE_HTTP_PROXY`, `ZCODE_NO_PROXY`, `ZCODE_REMOTE_HTTP_PROXY`, `ZCODE_REMOTE_NO_PROXY`, `ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY`, `ZCODE_AGENT_CA_CERT`, `ZCODE_TOOL_ENV_PASSTHROUGH_JSON` | network/tool env projection (534840–535100) |
| `ZCODE_BFS_BINARY`, `ZCODE_RG_BINARY`, `ZCODE_UGREP_BINARY` | bundled search binaries (`Oce`, byte 545560) |
| `ZCODE_EMBEDDED_SEARCH_COMMAND` | if set + `__internal-search`, use `{kind:"internal-cli"}` (11864646) |
| `ZCODE_GIT_BINARY` | git binary (7095054) |
| `ZCODE_CUA_*` (`_GRAY_ENABLED`, `_PRODUCT_HELPER`, `_DEV_MODE`, `_PERMISSION_BROKER_SOCKET`, `_PERMISSION_BROKER_TOKEN`, `_PERMISSION_BROKER_REFRESH_MARKER`, `_PERMISSION_BROKER_UNAVAILABLE`, `_PLUGIN_AUTHORITY`, `_HELPER_ALLOW_UNAUTHENTICATED_LOCAL`) | computer-use authority (535073–535609, 11841716, 11843452) |
| `ZCODE_PLUGIN_ID`, `ZCODE_PLUGIN_ROOT`, `ZCODE_PLUGIN_DATA`, `ZCODE_PLUGIN_NAME` | plugin host + manifest expansion (545447, 7017797, 7017871, 11935237) |
| `ZCODE_PLUGIN_SEED_INCOMPLETE`, `ZCODE_PLUGIN_SEED_LOCK_TIMEOUT` | seed/install (11813186, 11813920) |
| `ZCODE_PROJECT_DIR`, `ZCODE_SESSION_ID`, `ZCODE_SKILL_DIR` | plugin/skill expansion (7017938, 7018041, 7018160) |
| `ZCODE_API_KEY`, `ZCODE_BASE_URL`, `ZCODE_ENDPOINT_ORIGIN`, `ZCODE_PRODUCTION_BASE_URL`, `ZCODE_TEST_BASE_URL` | endpoint resolution (11777175, 395431/395455/395337/395371) |
| `ZCODE_WORKSPACE_IDENTITY` | explicit workspace identity (411704) |
| `ZCODE_OFFICIAL_MCP_DEV_TRUSTED_ORIGINS` | official-MCP dev origin trust list (411659) |
| `ZCODE_NODE_REPL_BROWSER_BROKER_SOCKET` / `_TOKEN` | broker credentials injected into MCP child (551104/551148) |
| `ZCODE_RUNTIME_MODEL_UNAVAILABLE` | error code for unavailable historical model (12129491) |
| `ZCODE_MESSAGE_ENABLED` | mailbox/messaging toggle (11781073) |
| `ZCODE_MAILBOX_ROOT` | mailbox dir (11953514) |
| `ZCODE_CREDENTIAL_SECRET` | credential cipher secret (7165723) |
| `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, `CLAUDE_PROJECT_DIR`, `CLAUDE_SESSION_ID`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_SKILL_DIR` | Claude-Code-compat aliases (7017772–7018137) |
| Proxy/CA (generic): `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `NODE_TLS_REJECT_UNAUTHORIZED` | `n5t` list, byte 535230 |
| `NODE_ENV`, `ELECTRON_RUN_AS_NODE`, `NODE_NO_WARNINGS` | runtime detection (535220) |
| `ZCODE_TOOL_ENV_PASSTHROUGH_JSON` / sanitization | tool child env projection (`mj`, `xFe`, byte 536000) |

---

## 11. Byte-offset index (for follow-up greps)

| what | offset |
|---|---|
| entry `main` `$$i` / `run` `U$i` | 12615193 / 12601956 |
| `parseGlobalArgs` `S$i` | 12597355 |
| `parseTuiModeArgs` `Syn` | 12614671 |
| help text en / zh | 11203600 / 11213884 |
| `ZCodeProtocolAgent` class | 12475800 |
| `dispatchRequest` switch | 12476954 |
| `ZCodeProtocolNdjsonConnection` `X3e` | 12487786 |
| `runZCodeProtocolAgent` `Ahn` | 12492681 |
| protocol envelope zod (`x1n`,`b1n`,`w1n`,`k1n`,`nEt`) | 418908 |
| protocol method table `rr` / notifications `mZ` | 462950 / 419834 |
| protocol error table `XB` / protocol name `Rje` / version `Pje` | 418591 / 418591 |
| v4 method table `dc` / notification table `UL` | 10512254 / 10512980 |
| v4 limits `nn` / wireVersion `Iy` | 355400 / 354686 |
| v4 command envelope `Doi` + catalog `KLr` | 10531374 / 10525225 |
| `commands/query` `YLr`/`QLr` | 10530296 / 10530434 |
| session/create `wEt`, list `SEt`, read `EEt`, send `OEt` | 439447 / 440066 / 441640 / 442066 |
| sqlite store `hpe` / db path `Q9e` / migrations `f6t` | 937567 / 882429 / 854351 |
| tool contracts `dft` / registration `BL` | 10464256 / 10463920 |
| provider enum `ys` / marketplaces `sPt` | 412790 / 544492 |
| OAuth (BigModel) / (Z.AI CLI) | 7156500–7167600 / 7160800–7164200 |
| node-repl broker `PMe` | 11928248 |
| plugin host `VDt` | 839674 |
| headless prompt `gkt` / stream-json writer | 12564026 / 12566150 |
| `mapSessionEvent` `qMe` / event enum `V` | 11987513 / 567761 |

## 12. Open items / not confirmed

* **HYPOTHESIS** — remote WebSocket RPC server lives outside this artifact (`zcode-agent.exe` / desktop host). Descriptor schema is client-side here; no `/rpc`, `/ws`, or `--port` in the CLI.
* **HYPOTHESIS** — `--settings`, `--permission-mode`, `--max-turns`, `--allowed-tools`, `--allow-main-worktree-yolo` are either legacy or implemented in a newer build; present in help, absent from the parser.
* **NOT INVESTIGATED** — full text of per-tool descriptions (available at the listed offsets), provider model catalog contents (~80 models.dev providers), TUI component layout, and the `automation/*` cron persistence tables beyond schema DDL.
