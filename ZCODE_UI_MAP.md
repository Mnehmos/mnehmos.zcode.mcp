# ZCODE_UI_MAP.md

The ZCode UI as a control surface, mapped to internal actions.

**Method and honesty note.** The renderer is a 44 MB minified Vite bundle. Rather than guess at
component trees, this map is derived from surfaces whose names and semantics are **CONFIRMED**:

1. the 129 `zcode:*` IPC channels (verbatim literals in `out/preload/index.cjs`);
2. the desktop settings file `~/.zcode/v2/setting.json` — every key is, by definition, a UI control
   the user can toggle (verbatim);
3. `workspace/readState.slashCommands` — the composer's command palette, returned by the live agent
   (verbatim);
4. the CLI slash-command list (verbatim from `zcode --help`);
5. the renderer's dependency set and asset filenames (confirmed, but only indicative of panels).

Anything beyond these is marked **HYPOTHESIS**.

---

## 1. Window and shell chrome

| UI element | Internal action | Evidence |
|---|---|---|
| Custom title bar | `zcode:window-controls-overlay-ready` → `…-changed`; `zcode:get-desktop-window-chrome-state` → `…-state-changed`; `zcode:set-title-bar-theme` | CONFIRMED |
| Window resize / zoom | `zcode:get-desktop-zoom-level`, `zcode:desktop-zoom-level-changed` | CONFIRMED |
| Fullscreen | `zcode:window-fullscreen-changed` | CONFIRMED |
| Tabs strip | `zcode:new-tab`, `zcode:focus-tab`, `zcode:sync-window-tabs`, `zcode:close-active-context-request` | CONFIRMED |
| Unread badge | `zcode:sync-window-unread-count` | CONFIRMED |
| Task notifications | `zcode:show-task-notification`, `zcode:task-notification-click`, `zcode:task-notification-sound` | CONFIRMED |
| System tray | `closeToTrayOnWindows` setting | CONFIRMED |
| Keep awake | `keepAwakeWhileRunning` setting | CONFIRMED |
| Zoom / hardware accel | `desktopChromiumHardwareAccelerationEnabled`, `desktopWindowSize` settings | CONFIRMED |

## 2. Workspace / project controls

| UI element | Internal action | Evidence |
|---|---|---|
| Recent projects list | `recentProjects: string[]` (10 entries observed) | CONFIRMED |
| Open folder | `zcode:select-directory` → `zcode:open-workspace-path`; `zcode:open-workspace` | CONFIRMED |
| Last workspace session | `lastWorkspaceSession: [{kind:'local', workspacePath, workspacePurpose:'project'}]` | CONFIRMED |
| Activate/switch workspace | `zcode:activate-or-set-workspace`; host RPC `workspace.set` | CONFIRMED |
| Workspace list | host RPC `workspace.list`; `session/list` groups by `workspace.workspaceKey` | CONFIRMED |
| Default workspace (no project) | `C:\Users\<u>\.zcode\workspace\default` | CONFIRMED |
| Remote connect (SSH/WSL/Docker) | `zcode:connect-remote`, `zcode:cancel-pending-remote-connection`, `zcode:dispose-remote-session`, `zcode:bind-remote-workspace-session-context`, `zcode:list-ssh-config-aliases`, `zcode:list-wsl-distros`, `zcode:list-docker-containers`, `zcode:is-docker-available`, `zcode:remote-connection-log`, `zcode:remote-session-closed` | CONFIRMED |
| Web Remote Control panel | `zcode:start-web-remote-control`, `…-stop-…`, `…-get-…-status`, `…-reset-…-pairing`, `zcode:web-remote-control-status-changed`, `zcode:sync-web-remote-control-workspaces`, `zcode:sync-web-remote-control-tasks` | CONFIRMED |
| Task list / archive | host RPC `task.list`, `task.set`; `taskAutoArchiveEnabled`, `taskAutoArchiveOlderThanDays` settings | CONFIRMED |
| New task | `zcode:new-task` | CONFIRMED |

## 3. Agent / chat controls ★

| UI element | Internal action | Evidence |
|---|---|---|
| Composer (rich text) | Lexical (`node_modules/lexical`, `@lexical`) | CONFIRMED dependency |
| Send message | renderer builds v4 envelope → host RPC → `v4/command{sendText}` | CONFIRMED (source) |
| Message queue behaviour | `zcodeInteractionBehavior: "queue"` (also `guide`); queue states `admitted/queued/reserved/promoting/drained` | CONFIRMED |
| Queue in-flight input | queue item `kind: sendText`; host `getQueueHead`, `getQueueLength`; `pendingCommandsDisplayMax: 32` | CONFIRMED |
| Stop / interrupt | `session/stop` (bypasses the agent's serial processing queue) | CONFIRMED |
| Steering (edit mid-turn) | `steer.state: notRequested/submitting/steering/guided/fellBack`; `turn.steerQueued` / `turn.steerDrained` | CONFIRMED |
| Model picker in composer | host RPC `model.list` / `model.set` / `model.provider.set`; `meta.model`; `session/setModel` | CONFIRMED |
| Reasoning/thought-level picker | `thoughtLevel.list` / `.set`; provider-declared variants `low/max/high` | CONFIRMED |
| Mode picker (plan/build/edit/yolo) | host RPC `mode.list` / `mode.set`; `meta.mode`; `session/setMode` | CONFIRMED |
| Reply granularity control | host RPC `reply.list` / `reply.set`; bot `/reply` | CONFIRMED |
| Show reasoning toggle | `messageStreamShowReasoning`, `messageStreamShowReasoningMigrationInitialized` | CONFIRMED |
| Show todos toggle | `messageStreamShowTodos` | CONFIRMED |
| Tool grouping toggles | `toolGroupingExploreEnabled`, `toolGroupingTerminalEnabled`, `toolGroupingChangesEnabled` | CONFIRMED |
| File-change / diff view | `toolGroupingChangesEnabled`; `@pierre` diff library; `v4/conversation/fileChanges`; `checkpoint.created` / `rewind.triggered` | CONFIRMED (setting + method + dep) |
| Rewind / checkpoint UI | `rewind.triggered`; `/rewind [latest|checkpointId]`; `session/fork {checkpointId}`; `v4/conversation/fileRewindPreview` | CONFIRMED |
| Ask-user-question auto-resolution | `askUserQuestionAutoResolutionEnabled`; pushed to agent as an interaction preference | CONFIRMED |
| Permission prompt | `permission.requested` / `permission.resolved`; `interaction/requestPermission` reply `{decision, permissionUpdates}` | CONFIRMED |
| Elicitation prompt | `elicitation.submit` / `elicitation.respond`; `/elicitation` bot command | CONFIRMED |
| Attach files | `zcode:select-file`, `zcode:select-files`, `zcode:create-temp-text-attachment`; `v4/attachment/*` | CONFIRMED |
| Paste screenshots | `~/.zcode/tmp/paste-attachments`; `image-cache/<sessionId>` | CONFIRMED |
| Command palette / slash menu | `workspace/readState.slashCommands` = `[{name, description, inputHint, source: builtin\|custom}]`; builtin observed: `goal`, `compact`, `init`, `plan` | CONFIRMED |
| Session list / history | `session/list`; `titleSource` shows generated/custom/first_input | CONFIRMED |
| New session | `session/create`; CLI `/new` | CONFIRMED |
| Resume session | `session/resume`; `--resume <sessionId>`, `-c/--continue`; CLI TUI `/resume` | CONFIRMED |
| Fork session | `session/fork`; `/fork [latest\|checkpointId]` | CONFIRMED |
| Compact conversation | `session/compact`; `/compact [instructions]` | CONFIRMED |
| Session goal | `session/goal`; `/goal [pause\|resume\|clear\|replace <objective>\|<objective>]`; `$Be` goal model | CONFIRMED |
| Subagent view | `session/subagents`; `sessionKind: subagent_child`; sessions named `sess_subagent_agent_<uuid>` on disk | CONFIRMED |
| Usage / cost dashboard | `usage/stats`, `v4/conversation/usage`, `session/usage`; renderer assets `AppUsageDailyModelTrendChart`, `AppUsageModelUsagePieChart`, `CodingPlanUsageBarChart`, `CodingPlanUsageLineChart`, `CartesianChart`, `LineChart` | CONFIRMED |
| Token/context meter | session projection `totalTokenCount`, `contextUsed`, `contextWindow` | CONFIRMED |
| Background job indicator | projection `backgroundJobs[]`; `background_task.tracking.*` events | CONFIRMED |
| Diagnostics / error banner | projection `lastError{type,code,message,detail,attribution}`; `turn.failed` | CONFIRMED |

## 4. Embedded browser

`zcode:open-browser-url` → `zcode:browser-view-ready` → per-tab lifecycle
(`attach-guest`, `detach-guest`, `ensure-resident`, `report-residency`, `restore-tabs`,
`close-tab`, `close-tab-from-renderer`, `suspend`/`suspend-ready`, `restore`, `visibility`,
`update-viewport`/`viewport-changed`), screenshot surface channels
(`screenshot-surface-prepare|ready|release`), JS dialog bridge
(`zcode:embedded-browser-javascript-dialog`), data controls (`clear-embedded-browser-data`,
`import-chrome-browser-data`).
Settings: `embeddedBrowserAllowInsecureCertificates`,
`embeddedBrowserViewportPreference: {mode, viewport:{width:393,height:852}, zoom:"fit"}`.
Recording: `out/main/browserWebmRecorder.js`, `out/preload/browserVideoRecorder.cjs`.
**CONFIRMED.**
Agent-side control of the same browser: `interaction/browserList` / `interaction/browserExecute`.

## 5. Settings surface

Every key in `~/.zcode/v2/setting.json` is a UI control. Grouped:

| Group | Keys |
|---|---|
| General / locale | `locale`, `localePreference`, `desktopChromiumHardwareAccelerationEnabled`, `keepAwakeWhileRunning`, `closeToTrayOnWindows` (+ migration flag) |
| Appearance / window | `desktopWindowSize`, `messageStreamShowReasoning`(+migration), `messageStreamShowTodos` |
| Agent behaviour | `zcodeInteractionBehavior`, `askUserQuestionAutoResolutionEnabled`, `optimizeAgentExperienceEnabled`(+migration), `toolGroupingExploreEnabled`, `toolGroupingTerminalEnabled`, `toolGroupingChangesEnabled` |
| Model / provider | `enabledBuiltinAgentCliProviders`, `modelProviderFamilyModes`, `modelProviderFamilySelectedKeys`, `providerFamilyDomain`(+`UpdatedAt`, `Migrated`), `modelIoFullRetentionEnabled` |
| Indexing / search | `repoSnapshotIndexingEnabled`, `instantGrepIndexingEnabled`, `nativeSearchEnhancementsEnabled`, `memoryEnabled` |
| Tasks | `taskAutoArchiveEnabled`, `taskAutoArchiveOlderThanDays` |
| Terminal | `terminalInheritSystemProfile`, `terminal.integrated.fontFamily` (agent-side key observed) |
| Embedded browser | `embeddedBrowserAllowInsecureCertificates`, `embeddedBrowserViewportPreference` |
| CUA | `computerUseComposerEntryHidden` |
| Projects | `recentProjects`, `lastWorkspaceSession` |

Observation: `*MigrationInitialized` flags indicate ZCode migrates these settings forward — a
reminder that **file-level setting writes must be additive**, never a wholesale replace.

## 6. Terminal

| Element | Internal action | Evidence |
|---|---|---|
| Integrated terminal | `node-pty` (in `app.asar.unpacked`) | CONFIRMED |
| Shell environment | `~/.zcode/cli/exec/bash-startup`, `exec/shell-snapshots`; `terminalInheritSystemProfile` | CONFIRMED |
| Agent-run shell commands | agent `Bash` tool; per-call `toolCallId`, `durationMs`; process-tree ownership | CONFIRMED |
| Background jobs from shell | `background_task.tracking.*`; `session/cancelBackgroundTask` | CONFIRMED |
| Terminal font | `terminal.integrated.fontFamily` | CONFIRMED |

> The desktop terminal and the agent's `Bash` tool are **separate facilities** with separate process
> trees. There is no protocol method to drive the desktop's integrated terminal — it is rating E
> (UI-only) for external control. Use `zcode_chat` with `Bash` allowed instead.

## 7. Editor-adjacent surfaces — and their limits

CONFIRMED UI affordances: `zcode:open-in-editor`, `zcode:get-installed-editors`,
`zcode:open-in-file-manager`, `zcode:save-file`, `zcode:print-to-pdf`.

**CONFIRMED architectural limit:** ZCode has **no editor document service**. There is no protocol
method for "get active editor", "get selection", or "replace selection", and no tab/document model
in any API surface. Its editor story is:

```
composer → agent turn → Write/Edit/ApplyPatch tool → checkpoint.created
                                                    → file-change record per conversation row
                                                    → rewind available
```

Therefore the requested `zcode.editor.active`, `zcode.editor.selection`, and
`zcode.editor.replace_selection` tools **cannot be built** on any stable interface. The honest
substitutes are:

| Requested | Substitute | Where |
|---|---|---|
| get active editor | "which sessions are running, and on which workspace" | `zcode_status sessions` |
| get selection | conversation file-change record for a row | `zcode_files changes` |
| replace selection | `zcode_chat send` with an edit instruction and `tool_allowlist:['Edit']` | `zcode_chat` |

## 8. Menus, dialogs, palettes

| Surface | Internal action | Evidence |
|---|---|---|
| Feedback dialog | `zcode:open-feedback-dialog`; `resources/config/default.json:feedback_url` | CONFIRMED |
| Tickets panel | `zcode:open-tickets-panel` | CONFIRMED |
| Community links | `zcode:can-open-community`; `community_urls.{zh-CN,en-US}` | CONFIRMED |
| MCP config import/export | `zcode:load-mcp-from-user-directory`, `zcode:save-mcp-to-user-directory`, `zcode:migrate-legacy-common-mcp` | CONFIRMED |
| Plugin manager UI | `plugins/overview`, `plugins/list`, `plugins/configure` (schema-driven `userConfig`), `plugins/operationProgress` | CONFIRMED |
| Marketplace UI | `plugins/marketplace/{add,remove,update}`; `marketplaces/` dir | CONFIRMED |
| Skills browser | `skills/referenceCatalog`; CLI `skills list`; plugins page | CONFIRMED |
| Process monitor window | `zcode:open-process-monitor` → `processMonitor.cjs` preload; `zcode:get-process-metrics` | CONFIRMED |
| Log export | `zcode:export-logs`; `~/.zcode/export-log-stage` | CONFIRMED |
| Update UI | `zcode:get-update-state` → `…-state-changed`; `download-update`, `cancel-update-download`, `quit-and-install-update`, `open-update-status-window`, `skip-update-version`, `get-auto-update-preferences`, `post-update-release-notes`, `ack-post-update-release-notes` | CONFIRMED |
| OAuth login | `zcode:oauth-callback`, `oauth-register-state`, `oauth-callback-handled`; `/login`, `/logout` | CONFIRMED |
| Billing / payment | `zcode:payment-callback`; `/api/biz/subscription/list`, `/api/v1/zcode-plan/billing/*` | CONFIRMED |
| CUA permission onboarding | `zcode:open-cua-permission-onboarding`, `cancel-…`, `prepare-cua-helper-permission-drag`, `start-…`, `notify-…-ended`, `get-cua-gray-enabled` | CONFIRMED |
| Wiki reference pane | renderer asset `WikiReferenceSidePane-*.js` | CONFIRMED asset |
| Device identity display | `zcode:get-device-id`; `__ZCODE_DEVICE_ID__` | CONFIRMED |

## 9. Keyboard / command invocation

There is **no externally visible keyboard-shortcut registry**. Keybindings live inside the minified
renderer and are not exposed by any protocol or IPC channel. **HYPOTHESIS:** they are React-level
handlers with no central registry that is machine-readable.

Nameable command surfaces, in order of usefulness for external control:

| Rank | Surface | How to drive it |
|---|---|---|
| 1 | ZCode Protocol methods (66) | directly — `zcode_protocol` / typed tools |
| 2 | Slash commands (`goal`, `compact`, `init`, `plan`, +custom) | `zcode_chat` message text beginning with `/` |
| 3 | Bot command language (`/status`, `/workspace`, `/model`, `/mode`, `/stop`, `/approve`, …) | only via bot integrations |
| 4 | CLI flags | `zcode_headless` |
| 5 | Desktop IPC | not reachable externally |

## 10. UI action → internal effect (worked examples)

```
"Send" button
  → Lexical composer serialises text + attachments
  → v4 envelope {type:"sendText", payload:{text, attachments, delivery:{requested:"auto"}}}
  → host RPC → host.admitCommandInput(envelope,{admissionSeq,admittedAt,queueItemId})
  → v4/command → agent Inbox.admit → queue item
  → turn.started → phases → model.request.started
  → session/event {type:"model.streaming", payload:{kind:"text_delta", delta}}
  → host normalizes seq, coalesces 1500 ms, fans out
  → renderer appends part  → turn.completed

Mode picker → "plan"
  → host RPC mode.set {value:"plan"}
  → session/setMode {sessionId, mode:"plan"}
  → settings.mode.current === "plan" on next workspace/readState
  → meta.mode event updates every open window

Permission prompt → "Allow, and always allow Bash(git *)"
  → interaction/requestPermission received by the client
  → reply {decision:"allow", permissionUpdates:[{type:"addRules",behavior:"allow",
             rules:[{toolName:"Bash", ruleContent:"git *"}]}]}
  → rule persisted in the agent → permission.resolved event

Diff view → "Rewind"
  → v4/conversation/fileChanges {sessionId,target:{rowId},baseLogEpoch,baseRevision}
  → v4/conversation/fileRewindPreview (dry run)
  → /rewind or session/fork {checkpointId}
  → rewind.triggered
```

Each arrow in these traces is CONFIRMED from source, except the renderer-internal steps (Lexical
serialisation and the store update), which are STRONGLY INFERRED from the dependency set and event
names.
