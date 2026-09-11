# ZCODE_CONTROL_SURFACES.md

Ranked programmatic control mechanisms for ZCode, with a worked control-surface matrix.

---

## Rating scale

| Rating | Meaning | Use in MCP? |
|---|---|---|
| **A** | Stable / public interface, versioned or documented, explicitly designed for programmatic use | **Yes — build on it** |
| **B** | Stable internal semantic interface, zod-validated, used by the vendor's own client | **Yes — with a version guard** |
| **C** | Internal command/event interface, no compatibility contract but semantically meaningful | Yes, defensively |
| **D** | IPC / protocol that can reasonably be wrapped, but requires in-process access or a special mode | Only if nothing better exists |
| **E** | UI automation only | Last resort |
| **F** | Fragile implementation detail (private SQLite columns, minified internals) | No |

---

## 1. Ranked surfaces

### ★★★ A — `zcode app-server --stdio` (the ZCode Protocol)

**Why A:** it is a first-class, self-described CLI subcommand
(`app-server  Run the ZCode Protocol stdio app server`); the protocol is *named and versioned*
(`"ZCode Protocol"` v1); every request and every response payload is zod-validated; and it is
exactly how the vendor's own desktop drives the agent.

| Property | Value |
|---|---|
| Location | `E:\zcode\resources\glm\zcode.cjs` (`app-server` subcommand) |
| Transport | NDJSON over stdin/stdout |
| Caller | any process |
| Receiver | agent runtime |
| Auth | none (process parentage) |
| Stability | **High** — versioned, validated, in-production use |
| Reach | *agent* tier only: sessions, models, tools, plugins, MCP, automations, usage |
| Cannot reach | desktop UI state, open editor tabs, live shell windows |
| Verified | ✔ **CONFIRMED by live probe** |

### ★★★ A — `zcode --prompt … --json` (headless one-shot)

Same binary, but usable as a **stateless command** with no protocol implementation at all.
Flags: `--prompt`, `-p/--print`, `--json`, `--cwd`, `--attach` (repeatable), `--mode`,
`--max-turns`, `--allowed-tools`, `--disallowed-tools`, `--resume <sessionId>`, `-c/--continue`,
`--target`, `--settings`, `--locale`, `--surface`, `--verbose`.

Best for: "run this task and give me the answer", CI-style usage, and as a **fallback** if the
long-lived stdio session ever misbehaves.

### ★★☆ B — ZCode Protocol over WebSocket

CONFIRMED to exist: `initialize()` reports `transportKind: "websocket"`; the remote server
descriptor declares `capabilities: { desktopContinuous: true, websocketRpc: true }` and
`protocolVersion: 1` with `authRequired: boolean`.

**Why B not A:** the same mature protocol, but the binding/handshake is not yet confirmed and it
requires opting into a remote mode. Attractive because a long-lived WS connection maps more
naturally onto MCP than managing a child process — and `web-remote-replayable` mode is explicitly
designed for resumable remote clients.

### ★★☆ B — Host RPC via `attach-service-port` MessagePort

**Why B:** richer than the agent protocol (it reaches workspaces, tasks, permission decisions, and
desktop-synced settings) and its event set is the closest thing to a UI control bus. **But** the
transport is an Electron `MessagePort`, so an external process cannot use it directly.

Reachable **only** through the Web Remote Control subsystem (`web-remote-replayable` client mode)
or by injecting into the Electron process. See `ZCODE_UNKNOWNS.md` U-1.

### ★★☆ B — Filesystem control channels

| File | Control value |
|---|---|
| `~/.zcode/cli/config.json` | MCP server definitions + plugin enablement — **the cleanest way to add/remove MCP servers programmatically** |
| `~/.zcode/v2/setting.json` | desktop settings (interaction behaviour, feature flags, tool grouping, indexing) |
| `~/.zcode/v2/config.json` | provider registry |
| `<workspace>/AGENTS.md` | agent instructions for a workspace |
| `~/.zcode/cli/log/*.jsonl`, `rollout/*.jsonl` | high-fidelity observability (read-only) |

**Why B:** documented shapes, tolerant readers (`readJsonFile` returns a default on parse failure),
and genuinely semantic. Caveat: most are read at startup, so changes require a restart.

> ⚠ `credentials.json` is **not** a safe control channel — see `ZCODE_STATE_MODEL.md` §6.5.

### ★☆☆ C — Permission broker RPC (unix socket / named pipe)

A real NDJSON RPC with token auth and peer-credential verification. On Windows it is **hard-restricted
to the `zcode-cua-helper` named-pipe namespace**, so it cannot be repurposed as a general control
channel. Useful only for the specific purpose of approving CUA (computer-use) permissions.

### ★☆☆ C — Bot command language

`parseBotCommand` accepts a documented, bilingual, plain-text command language
(`/status`, `/workspace <path>`, `/model <id>`, `/mode <m>`, `/stop`, `/approve`, …) and turns it
into typed commands. **Its most valuable property is that a prompt string is a valid control
message** — but it is reachable only through the bot integration surfaces (Feishu/Telegram/WeChat),
not through a local socket.

### ★☆☆ C — Agent tool invocation as control

Any capability the agent has (`Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `WebFetch`,
`Agent`, `Skill`, `TodoWrite`, `js`) can be exercised by driving a turn with
`--allowed-tools` narrowed to exactly that tool. This is **semantic, not UI automation** — but it
costs model tokens and is non-deterministic. Use only when no protocol method exists.

### ☆☆☆ D — Electron IPC (`zcode:*`, 129 channels)

Rich (window control, file dialogs, screenshots, embedded browser, updater, process metrics,
desktop command execution) but **in-process only**. Not usable without injecting into Electron.

### ☆☆☆ E — UI automation (mouse/keyboard/screenshot)

The only way to control the *desktop UI itself*: switching tabs, opening panels, clicking buttons.
Violates the project's preferred approach. Use only for genuinely UI-only actions.

### ✗ F — Private SQLite schemas and minified internals

Direct writes to `db.sqlite`, `tasks-index.sqlite`, or reliance on minified identifiers
(`l3e`, `Q3e`, `j3e`) are fragile: WAL concurrency, private migrations, and names that change per
build. **Read** from copies for analysis; never write.

---

## 2. Control-surface matrix

Legend for the "best path" column: **P** = ZCode Protocol, **F** = filesystem, **B** = bot language
(via a turn), **T** = agent tool via turn, **W** = host RPC (requires remote-control mode),
**U** = UI automation.

| Operation | Best path | Method / detail | Rating | Failure modes |
|---|---|---|---|---|
| **App / agent status** | **P** | `workspace/readState` + `session/list` | A | none observed; returns `available:[]` if no provider registry (bare agent) |
| **Version info** | P / CLI | `zcode version`; protocol `protocol.name/version` in session snapshot | A | — |
| List workspaces | **P/F** | `session/list` → distinct `workspace.workspaceKey`; or `~/.zcode/v2/setting.json:lastWorkspaceSession` | A / B | `session/list` only shows workspaces with sessions |
| Open / switch workspace | **W** or U | host RPC `workspace.set`; desktop-side `zcode:activate-or-set-workspace` | D/W | not reachable via agent protocol |
| List files | **T** | `Glob` tool (`--allowed-tools Glob`) | C | costs a model turn unless driven directly |
| Read file | **T / FS** | `Read` tool, or plain FS read in the MCP process | C/— | bypasses agent's snapshot/checkpoint machinery |
| Create / edit / save file | **T** | `Write` / `Edit` / `ApplyPatch` tools | C | **the only path that produces `checkpoint.created` and participates in rewind** |
| Delete file | T | `Bash` tool (`rm`) | C | permission-gated |
| Get active editor | ✘ | no editor service exists | E | UI-only; not in any protocol |
| Get / replace selection | ✘ | not modelled server-side | E | UI-only |
| Search workspace | **T** | `Grep` tool (bundled ripgrep/ugrep) | C | respects ignores differently from editor search |
| **List commands** | **P** | `v4/commands/query` `{commands:[{sessionId}]}`; `workspace/readState` → `slashCommands` | A | min 1 item in array; `-32603` on empty |
| **Execute command** | **P** | `v4/command` envelope (`sendText` / `sendGoalCommand` / `compact` / `createSession`) | A | `noop`/`failed` with reason codes; `proto.payloadTooLarge` >16 MiB |
| **Create session** | **P** | `session/create` or `v4/command{createSession}` | A | needs a valid `workspace` ref |
| **Send prompt / chat** | **P** | `v4/command{sendText}` then subscribe to `session/event` | A | needs provider config (see below) |
| Stream a response | **P** | `v4/conversation/subscribe` (topic frame) or `session/subscribe` | B | deltas are coalesced host-side (≤1500 ms) |
| **Cancel a turn** | **P** | `session/stop` (queue-bypassing) | A | — |
| Stop a background job | P | `session/cancelBackgroundTask` | A | — |
| Cancel workspace text gen | P | `workspace/cancelGenerateText` | A | — |
| Read conversation | **P** | `v4/conversation/rowsRange` (`limit ≤200`) | B | `proto.staleLogEpoch` / `proto.staleRevision` |
| Read messages/events | P | `session/messages`, `session/events` | A | — |
| List subagents | P | `session/subagents` | A | — |
| **Choose model** | **P** | `session/setModel`; or `workspace/setDefaultModel` | A | model must exist in the pushed registry |
| Choose thought level | P | `session/setThoughtLevel`; `workspace/setDefaultThoughtLevel` | A | variants are provider-declared (`low/max/high`) |
| Choose mode | P | `session/setMode`; `workspace/setDefaultMode` | A | `plan\|build\|edit\|yolo\|auto` |
| Fork a session | P | `session/fork {checkpointId?}` | B | needs a checkpoint for rewind-based forks |
| Compact a session | P | `session/compact` | B | — |
| Set / read goal | P | `session/goal` | B | budget fields are provider-agnostic |
| **Approve / deny an action** | **P** | reply to `interaction/requestPermission` with `{decision, permissionUpdates?}` | B | **you must be the attached client**; only one client may own the pending request |
| Answer a user-input request | P | reply to `interaction/requestUserInput` | B | same ownership constraint |
| Submit elicitation | P | `elicitation/submit` / `elicitation/respond` | B | — |
| Provide provider headers | P | reply to `interaction/requestProviderRuntimeHeaders` | B | desktop-only capability |
| **Inspect diffs / file changes** | **P** | `v4/conversation/fileChanges {sessionId, target:{rowId}, baseLogEpoch, baseRevision}` | B | `fault.fileChanges.unsupported` |
| Preview a rewind | P | `v4/conversation/fileRewindPreview` | B | `fault.fileRewindPreview.unsupported` |
| Apply / reject a rewind | P | `session/fork` or `/rewind` | B | FS-mutating; treat as destructive |
| Upload an attachment | P | `v4/attachment/begin → chunk → commit` | B | ≥1 MiB payloads must use this; 512 KiB/chunk, ≤64 chunks |
| Read an attachment | P | `v4/attachment/read` | B | ≤30 MiB preview cap; `fault.attachment.previewNotMedia` |
| **Diagnostics / errors** | **P/F** | session projection `lastError`; tool statuses; log JSONL `turn.failed`, `tool.call.failed` | B | log files rotate daily |
| **Git state** | **T / FS** | `Bash` tool `git …`; or run git directly in the MCP process | C | no dedicated VCS service exists |
| Usage / cost analytics | **P** | `usage/stats {range: all\|7d\|30d}` | A | — |
| **MCP server inventory** | **P/F** | `mcp/list`; `~/.zcode/cli/config.json` | A | `mcp/list` requires `workspace` |
| **Add / remove an MCP server** | **F** | edit `~/.zcode/cli/config.json` → `{mcp:{servers}}` | B | needs agent/live-session restart (new sessions pick it up) |
| **Enumerate extensions** | **P** | `plugins/list`, `plugins/overview`, `plugins/describe` | A | requires `workspace` |
| Enable / disable a plugin | P / F | `plugins/setEnabled`; or `plugins.enabledPlugins` in config | A / B | enablement affects the **tool budget** |
| Install / update / uninstall | P | `plugins/install`, `plugins/update`, `plugins/uninstall` + `plugins/operationProgress` | B | cancellable via `plugins/cancelOperation` |
| Configure a plugin | P | `plugins/configure` / `plugins/resetConfig` (schema surfaced as `userConfig`) | A | schema-driven; validated |
| Marketplace ops | P | `plugins/marketplace/{add,remove,update}` | B | — |
| Skills catalog | P | `skills/referenceCatalog` | A | — |
| Custom slash commands | CLI / P | `zcode commands list`; `v4/commands/query` | A | — |
| **Automations (cron)** | **P** | `automation/create|list|update|delete|checkTaskBinding` | A | ≤20 retained; cron or interval |
| **Get settings** | **F** | `~/.zcode/v2/setting.json` (desktop), session settings via `workspace/readState` | B | file is authoritative but read at startup |
| **Modify settings** | **F / P** | file write (restart) vs protocol (`workspace/updateInteractionPreferences`, `session/setMode`…) | B / A | file edits need restart; protocol edits are immediate |
| Reload workspace / window | ✘ / U | no protocol equivalent | E | restart the app or the agent process |
| Shutdown the agent | ✔ | close stdin / kill the child; graceful on `dispose` | A | owned process group is killed and verified |
| Logs / export | F / W | `~/.zcode/cli/log/*.jsonl`; `zcode:export-logs` (IPC) | B / D | — |
| Desktop window control (screenshot, zoom, titlebar) | D / U | `zcode:capture-window-screenshot`, `zcode:get-desktop-zoom-level` | D | in-process only |
| Embedded browser control | P | `interaction/browserList` / `interaction/browserExecute` | B | `backend_unavailable` when no host executor |

---

## 3. The critical constraint on every design decision

**Verified empirically:** a bare `app-server` started with no host reports
`model.current = {modelId:"missing-model", providerId:"zcode-unconfigured"}` and
`modelCatalog.available = []`.

Why: **the desktop owns the provider registry and the credentials.**
The agent receives them at runtime via `workspace/updateProviderRegistry` and asks for auth headers
per-request through `interaction/requestProviderRuntimeHeaders`.

Therefore an MCP that spawns its own `app-server` must do **one** of:

1. **Bootstrap the provider configuration itself** — write a settings/config file containing a
   provider (`{provider:{…kind:"anthropic", options:{apiKey, baseURL}, models:{…}}}`) and pass it
   via `--settings <path>`, or push it with `workspace/upsertModelProvider` +
   `workspace/updateProviderRegistry`. Requires the user to supply an API key or reuse the
   OAuth token from `~/.zcode/v2/credentials.json`.
2. **Attach to an already-configured agent** — i.e. let the desktop spawn it, and connect over the
   remote-control WebSocket transport instead.
3. **Use a specific workspace whose config already resolves to a working provider.**

This single fact determines the MCP architecture and is the reason `ZCODE_MCP_SPEC.md` proposes a
**two-tier** design (a *session* tier that owns an `app-server` it fully configures, and an optional
*desktop* tier that attaches to the running app).

---

## 4. Anti-patterns to avoid

| Anti-pattern | Why it fails |
|---|---|
| Driving the desktop by simulating clicks/keystrokes | Rating E; brittle, focus-stealing, breaks on any UI change — and the semantic layer already exists |
| Writing `db.sqlite` directly | Live WAL DB, private migrations; corruption risk with zero upside |
| Re-implementing the agent loop on top of the provider HTTP APIs | Duplicates prompt/context/tool/permission/checkpoint logic that already exists and is versioned |
| Assuming one agent process per app | The host keys everything by `workspaceKey`; multiple runtimes can coexist (plus subagents) |
| Hard-coding the tool list | Provider-visible tools are a fixed set but MCP tools are appended — and GLM has an ~89–94 tool ceiling |
| Caching row ids across a `logEpoch` change | `proto.staleLogEpoch`; compaction/fork invalidates rows |
| Auto-approving permission requests | ZCode deliberately routes approval through `interaction/requestPermission` with a persisted-rule mechanism; blanket auto-allow defeats an intentional security boundary |
