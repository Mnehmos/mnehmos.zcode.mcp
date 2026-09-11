# ZCode 3.11.2 — State Model & Persistence Layer (reverse-engineered)

Scope: Electron app `ZCode.exe` 3.11.2 (Z.ai). Code sources (all already extracted, not re-extracted):
- `F:\Github\mcp\mnehmos.zcode.mcp\.re\x\host-index.js` + `x\chunks\out_host_*.js` — the "host" (agent runtime) process. Import maps confirm `host-index.js` is a byte-identical copy of `out_host_index.js`.
- `x\main-index.js` + `x\chunks\out_main_*.js` — Electron main.
- `x\chunks\out_scheduler_index.js` — scheduler (cron/off-peak).
- `E:\zcode\resources\glm\zcode.cjs` (12.6 MB) — the bundled **ZCode CLI agent** (provider id `glm`). This is where the 19-table session store lives; the host bundles do **not** contain the session-store DDL.
- `E:\zcode\resources\app.asar` (renderer bundles extracted read-only via `.re\asar.py`).

Runtime data was treated read-only. `db.sqlite` + `-wal` were copied to `.re\dbcopy\` before any query (`-shm` was locked and skipped; SQLite rebuilt it on the copy). Evidence labels: **CONFIRMED** (direct code/DB/artefact), **STRONGLY INFERRED** (from consistent multiple signals), **HYPOTHESIS** (unverified but plausible).

Environment note for the reader: live data shows this machine's runtime is actually the *CLI agent runtime* (`glm`/`zcode.cjs`) plus the desktop host; the desktop v2 config dir is `~/.zcode/v2`, the CLI data dir is `~/.zcode/cli`.

---

## 1. SQLite schema

### 1.1 Main session store — `C:\Users\mnehm\.zcode\cli\db\db.sqlite`

- 19 tables, 18 applied migrations (`schema_migration` has 18 rows; ids `0001_base_session_store` … `0018_session_input_failed_status`), **CONFIRMED** (queries below).
- `PRAGMA journal_mode = wal`, `PRAGMA user_version = 0`, `page_size=4096`, `encoding=UTF-8`, `auto_vacuum=0`, `application_id=0`, `freelist_count=0` (144 MB file / 35 403 pages). Table sizes measured on the copy (WAL replayed): `message` 8,720; `part` 32,668; `model_usage` 7,485; `tool_usage` 8,388; `turn_usage` 406; `session` 36; `session_entry` 1,596; `session_input` 436; `todo` 162; `input_history` 100; `local_setting` 14; `session_target` 2; `session_task_link`/workflow_* / `permission` 0. **CONFIRMED**

**What each table stores**

| table | purpose | notes |
|---|---|---|
| `session` | one row per conversation/task session (the "Task" domain object in CLI terms) | `project_id` is the *workspace* key (`proj_<slug>`), `workspace_id` is always NULL on this machine, `parent_id` links subagent/fork children; `permission` JSON = `{"mode":"build"\|"yolo"}`; `revert` holds large JSON kept-message lists; `task_type` default `interactive`, also `subagent_child` |
| `message` | user/assistant messages; `data` = full message JSON (see 4.3) | `sequence` auto-filled by trigger `message_sequence_autofill` |
| `part` | message parts: `text`/`reasoning`/`file`/`tool`/`step-start`/`step-finish`/`snapshot`/`patch`/`compaction`/`timeline`/`subagent`/`agent`/`retry` | `data` JSON; `sequence` trigger `part_sequence_autofill` |
| `session_entry` | append-only per-session event log (runtime snapshots): observed types `runtime/workspace_checkpoint` (1,560), `runtime/model_selection` (18), `runtime/bash_shell_selection` (15), `target_completion_verification` (2), `runtime/user_input_auto_resolution` (1) | `data` = `{eventId, sequenceNumber, traceId, turnId, payload, …}` |
| `session_input` | input admission ledger (queue/steer/startNow) | `delivery ∈ {startNow, guide, queue}`; `status ∈ {admitted, promoted, cancelled, discarded, failed}`; `payload` carries `{text, intent{…admissionSeq…}, conversationInputIntent, attachments}` |
| `session_target` | "goal mode" target per session | `status ∈ {active, paused, budget_limited, complete}`; usage counters `tokens_used`, `time_used_seconds`, `summary_title` |
| `todo` | per-session todo list | PK `(session_id, position)` |
| `input_history` | prompt history for ↑ recall | `kind ∈ {prompt, steered_input}`; inserts trim to last N per project (`v4n`) |
| `local_setting` | namespaced key-value store, scoped | PK `(scope, scope_id, namespace, key)`; observed: `(project, proj_*, permission, mode/ruleset)`, `(user, default, model, reasoningLevel)`; `value` is JSON |
| `permission` | per-project permission ruleset blob | currently empty; data copied to `local_setting` by migration `0003` |
| `model_usage` | LLM call accounting (one row per attempt) | token counts, TTFT, retry, error fields; `query_source ∈ {main_turn, subagent, session_title, compact, goal_summary_title, target_completion_verification}` |
| `tool_usage` | tool-call accounting | `(session_id, tool_call_id)` unique; `status ∈ {running, completed, error, cancelled}`; read_only/destructive/approval_status flags |
| `turn_usage` | per-turn aggregation | PK `(session_id, turn_id)`; model/tool counts and token sums |
| `workflow_run` / `workflow_definition` / `workflow_activity` / `workflow_event` | script-workflow runtime (ZCode "expert/workflow" feature) | all empty here; `workflow_activity.status ∈ {queued, running, completed, failed, skipped, cancelled, cached, lost}` |
| `session_task_link` | parent/child session linkage for workflows & subagents | `unique(child_session_id)`; FK to `workflow_run`/`workflow_activity` |
| `schema_migration` | applied migration ledger `(id, checksum, app_version, time_applied)` | checksums sha256 of trimmed SQL |

Oddities (`PRAGMA table_info` anomalies are all explained by later `ALTER TABLE` migrations): `message.sequence`, `part.sequence`, `input_history.attachments`, `session.task_type/title_source/title_message_id/time_title_updated/trace_id`, `session_target.summary_title/active_input_id/active_run_started_at/active_run_last_seen_at` were appended by migrations; `session_target` is stored with a quoted table name (`CREATE TABLE "session_target"`). **CONFIRMED**

Sanitized samples (long text truncated; secrets redacted):
```text
session:      id=sess_…, project_id=proj_example, workspace_id=NULL, parent_id=NULL,
              slug=…, directory=F:\projects\example, path=F:\projects\example,
              title="<session title>", version="0.16.5",
              permission={"mode":"build"}, revert={"keptMessageIDs":[…112568b]} (nullable),
              task_type=interactive, title_source=generated, trace_id=…
session_input: kind=sendText, delivery=startNow, status=promoted,
              payload={"text":"…","intent":{"admissionSeq":1,…,"requestedDelivery":"startNow"},…}
session_target: objective="<redacted>", status=complete, tokens_used=27445539, time_used_seconds=8643,
              summary_title="<session title>"
local_setting: scope=user scope_id=default namespace=model key=reasoningLevel value={"level":"max"}
todo:          content="…", status=completed, priority=high, position=0
message.data:  {role, time:{created,completed}, parentID, modelID, providerID, mode:"build",
                agent:"zcode-agent", path:{cwd,root}, cost, tokens:{input,output,reasoning,cache},
                finish, semantics:{origin,kind,uiVisibility,providerVisibility,transcriptVisibility}, anchor}
part.data:     {type:"tool", callID, tool:"WebFetch", state:{status,input,output,title,metadata,time}}
               or {type:"text"|"reasoning", text, time} | {type:"step-finish", reason, cost, tokens}
```

### 1.2 Second DB — `C:\Users\mnehm\.zcode\v2\tasks-index.sqlite` (the desktop "task index")

- Owner: bundled **desktop host** (`TaskIndexRepo` `Wa`, `AutomationRepo` `yd`, `OffPeakTaskRepo` `wl`) using `node:sqlite DatabaseSync`. **CONFIRMED** (`host-index.js` @194743, @148804, @2094055).
- Tables: `tasks` (22 rows), `automations` (0), `automation_runs` (112), `off_peak_tasks` (0), `task_groups` (1), `task_group_members` (1), `task_group_view_node_orders` (23), `task_group_workspace_bootstraps` (0). **CONFIRMED**
- Pragma: `journal_mode=wal`, `user_version=0`; repo code sets `busy_timeout=5000`, `foreign_keys=ON`, `synchronous=NORMAL`. **CONFIRMED**

`automations` is exactly the documented 20-cap table (`AutomationCreateLimitError`: *"At most 20 automations may be retained"*, host @146300); automations are created by the agent tools **`CronCreate` / `CronUpdate` / `CronDelete`** (`rA` list, host @143931). `tasks` is keyed `PRIMARY KEY (workspace_key, task_id)` and carries UI state (pinned/archived/unread/title_overridden) plus `cron_automation_id`, `off_peak_task_id`, `searchable_text`, `meta_json`. Full DDL in Appendix A.5. **CONFIRMED**

### 1.3 PRAGMAs / integrity

```
db.sqlite:  journal_mode=wal  user_version=0  page_count=35403  page_size=4096
            application_id=0  auto_vacuum=0  encoding=UTF-8  freelist_count=0
tasks-index: journal_mode=wal  user_version=0
```

---

## 2. Where the DBs are opened / created (code)

### 2.1 Session store (`db.sqlite`)

- Path resolution: `function Q9e(){return join(homedir(), ".zcode","cli","db","db.sqlite")}` — `getDefaultSessionDbPath` in `E:\zcode\resources\glm\zcode.cjs` (@~755 700). **CONFIRMED**
- Overridable via config key `storage.sessionDbPath` (default `"~/.zcode/cli/db/db.sqlite"`), config field `StorageSessionDbPath`; the config-level default object is `Va` and `storage={dir:"~/.zcode", sessionDbPath:"~/.zcode/cli/db/db.sqlite"}` (@755 410). `resolveWorkspaceStorageDir` (`Vot`) exists for per-workspace storage dirs. **CONFIRMED**
- Opened with `node:sqlite`'s `DatabaseSync` (single `DatabaseSync` occurrence in zcode.cjs @938 241; `openStartupSqliteSessionStore` = `u4` @946 300). Startup runs `runSqliteSessionMigrations` = `v6t` (@879 600): `pragma foreign_keys = on`, ensure WAL (retry/backoff, `SQLite refused WAL journal mode` error class `Uy`, errcode 5/6 lock detection), `begin immediate`, create `schema_migration`, apply `f6t` migrations, `commit`; each migration's SQL is sha256-checksummed (`g4n`) and immutability-enforced (`SQLite migration checksum mismatch … add a new migration instead`). **CONFIRMED**
- Migrations array `f6t` is at zcode.cjs bytes 854 351–879 533 (18 entries, `appVersion` 0.2.0→0.15.2). Full verbatim text in Appendix A.4. The runtime DB reports `version` column "0.16.5" in `session.version` while migrations stop at 0.15.2 — the app-version in `schema_migration` is the *migration authoring* version, not the running app. **CONFIRMED**

Session-store write paths (for state-mutation mapping): `message` upsert uses `insert into message … on conflict(id) do update set … sequence = case when message.session_id = excluded.session_id then message.sequence else excluded.sequence end`, then `s4(e,n,s)` re-indexes; `part` upsert identical shape (`CK`); message delete `J6t`; `session_entry` insert; `input_history` insert + trim-to-N in `begin immediate`/`commit`. **CONFIRMED** (zcode.cjs @890 363 / @896 932 / @897 768).

### 2.2 `tasks-index.sqlite`

```
function jl(){return join(ht(),"tasks-index.sqlite")}          // getTasksIndexDatabasePath
function ht(){return join(cd(),"v2")}                          // getAppConfigDir  → ~/.zcode/v2
function cd(){return join(qr(),".zcode")}                      // getZCodeDataRootDir
function qr(){return OJ || process.env.ZCODE_DATA_BASE_DIR?.trim() || (HOME || homedir())}
```
**CONFIRMED** — host-index.js @15 117–15 400. `ZCODE_DATA_BASE_DIR` is the documented override env var. Each repo (`yd`/`Wa`/`wl`) takes an optional constructor path, defaults to `jl()`, runs `mkdir(dirname)`, opens `new DatabaseSync(path)`, then the DDL exec block. **CONFIRMED**

Full DDL text (verbatim, host-index.js @148 804 [`automations`+`automation_runs`], @194 743 [tasks/groups], @209 4055 [off_peak_tasks]) is reproduced in Appendix A.5; the on-disk schema is its exact after-state.

---

## 3. Config system

### 3.1 Layered CLI config (`~/.zcode/cli/config.json`)

`createConfig` (`ns`, zcode.cjs @6 978 193) builds an ordered list of layers:

| layer | source path(s) | priority |
|---|---|---|
| system | built-in defaults `Va` (frozen) | 0 |
| user | `~/.zcode/cli/config.json` (`tI()` = `join("~/.zcode/cli","config.json")`; `I_r="config.json"`, `T_r="~/.zcode/cli"`) | 10 |
| project | walk up from `workingDirectory` to the git root (`e5o`: stops at a dir containing `.git`), reading for every dir: **`zcode.json`** and **`.zcode/config.json`** (`L_r`) plus an optional explicit `--project-config` path | 20 |
| session | session overrides (in-memory when running) | 30 |
| env | `parseEnvConfig` (`gxe`) of `process.env` | 40 |
| cli | CLI flags (`e.cliOverrides`) | 50 |

Merge order = priority sort then `Object.assign` deep-ish merge (`_xe`); `hooks` and `modelCatalog` get special merges; project-scope `plugins.extraKnownMarketplaces` is stripped. **CONFIRMED** (wc/m3t @755 410; `ns` @6 978 193).

Zod schema of the user config file (`bRn`): top-level keys

```
schemaVersion? (literal 1)   modelCatalog.overrides{}
modelStream.idleTimeoutMs    permission{mode, allowedTools[], disallowedTools[], autoApproveHighRisk, allowMediumRiskInAuto}
storage{dir, sessionDbPath}  network{httpProxy, noProxy, caCertFile, timeout}
features{compact,rewind,subagent,memory,skill,mcp}
memory.use                   mcp.servers{} (stdio/http/sse + oauth)
plugins{dirs[],enabled,enabledPlugins{},extraKnownMarketplaces{},options{},suppressedBuiltins[]}
skills{enabled,includeInstructions,metadataBudget,roots[]}
skillOverrides{}  commandOverrides{}
logging{level,format}        toolConcurrency.maxConcurrency
modelAnomalyGuard{maxBudgetWarningsPerTurn,repeatedToolCallWarningThreshold}
hooks{enabled,events{SessionStart,UserPromptSubmit,PreToolUse,PermissionRequest,PostToolUse,PostToolUseFailure,Stop},maxOutputBytes,timeoutMs}
ui{locale,theme}
```
**CONFIRMED** — `Va` default object @755 410 and the zod schemas `bRn`/`bAo`/`wAo`/`PAo`/`MAo`/`OAo` @6 948 98x. Observed live file has only `mcp.servers` (comfyui/remcp/aseprite/blender/unreal) and `plugins.enabledPlugins` (4 entries) — i.e. the file is sparse and merged over defaults. **CONFIRMED**

Also in this file: the **workspace-hook trust store** (`Workspace Hook Trust`) is a *separate section* read/written by `aF` (`nMn`): default `userConfigPath ?? join(home,".zcode","cli","config.json")`, honoring `storage.dir`; entries keyed `${workspaceIdentity}\0${hookDeclarationDigest}` with `decision:"trusted"` records (zod `DZt`). **CONFIRMED** (zcode.cjs @946 250; main-index @79 9732 schema).

### 3.2 Desktop v2 config dir (`~/.zcode/v2/`)

| file | format | read/write code | notes |
|---|---|---|---|
| `config.json` | JSON | provider registry: `{provider:{<id>:{name,kind:"anthropic"\|"openai-compatible",options:{apiKey,baseURL,apiKeyRequired},models:{…},enabled?,source,systemDisabledReason?}}}` | 10 providers on this machine; **API keys are plaintext** (see §7) |
| `setting.json` | JSON | App settings service (`getSettingsDir`=`IL`=`~/.zcode/v2`, `getSettingsFile`=`RL`, main-index @45 110); also read *early* for `dataBaseDir` bootstrap and `desktopChromiumHardwareAccelerationEnabled` (main-index @80 8068) | contains `recentProjects[10]`, locale, window size, `lastWorkspaceSession` (13 entries incl. `{kind:"local", workspacePath, workspacePurpose:"project"}`), provider-family prefs, feature toggles |
| `credentials.json` | JSON, values `enc:v1:` AES-256-GCM | CLI: `C6o()` → `join(ZCODE_DATA_BASE_DIR ?? homedir(), ".zcode","v2","credentials.json")` (zcode.cjs @7 165 800); App: `Vw()`=`getCredentialsFile` (main-index @51 805) — same file | keys: `oauth:zai:access_token`, `zcodejwttoken`, `oauth:zai:user_info`, `oauth:active_provider`; also written by App (`saveZaiLoginCredentials`) |
| `certs/zcode-network-ca.key` / `.pem` | local CA for the network proxy | `resolveWorkspaceStorageDir` family | present |
| `logs/<date>.log` | text logs | main/updater | present |
| `crash/…` | crashpad dirs | — | present |
| `bot-state.v2.json` | JSON `{version:2,bots:{}}` | bot state | present |
| `telemetry-state.json` | `{deviceMid,lastDailyActiveDate}` | telemetry client | present |
| `coding-plan-cache.json` | JSON | coding-plan entitlement cache | present |
| dirs referenced by support-bundle allowlist: `agent-config`, `certs`, `repo-snapshots`, `repo-wiki`, `sessions`, `session-bindings`, `checkpoints` | | `rye` array, main-index @1 192 228 | created lazily per feature |

**CONFIRMED** for all files above (existence + read code); **STRONGLY INFERRED** for the lazily created dirs (allowlist only; not present yet).

### 3.3 Other config files (resolved, real vs not)

- `settings.json` — **not** a ZCode config file. It is the *native* config file name for imported CLIs: `claude` → `~/.claude/settings.json`, `gemini` → `~/.gemini/settings.json` (+ `oauth_creds.json`, `google_accounts.json`), `opencode` → `~/.config/opencode/opencode.json`, `codex` → `~/.codex/config.toml`, `glm` → `~/.zcode/cli/config.json` (native dir map `DJ`, host-index @13 533; per-workspace isolated dirs `~/.zcode/v2/agent-config/<provider>/<workspaceHash12>` via `Mv`/`hwe`). **CONFIRMED**
- `config.toml` — only as the Codex native config (`~/.codex/config.toml`); no ZCode TOML config. **CONFIRMED**
- `mcp.json` — **plugin-relative** `.mcp.json` at a plugin root (plugin-provided MCP servers, zod-validated, `plugin:<name>:<key>`); not a user config path. **CONFIRMED** (zcode.cjs @7 012 648)
- `zcode.json` / `.zcode/config.json` — project config candidates (see layer table). **CONFIRMED**
- `opencode.json` — native opencode config only. **CONFIRMED**
- `hooks.json` — plugin-relative `hooks/hooks.json` (official plugin hook declarations; event whitelist `bPo`). **CONFIRMED** (zcode.cjs @7 021 757)
- `marketplace.json` — plugin marketplace artifacts under `<plugins>/marketplaces/<id>/marketplace.json`, plus `bundled-marketplace.json` / `cdn-marketplace.json` partitions written by `rebuildOfficialMarketplaceSync`; runtime registries `~/.zcode/cli/plugins/{installed_plugins.json,known_marketplaces.json,icon-sources.json}`. **CONFIRMED** (zcode.cjs @7 028 191; live files inspected)
- `credentials.json` — real: `~/.zcode/v2/credentials.json` (above). `.credentials.json` is only a filename in a *redaction allowlist* (`oye` Set, main-index @1 192 228), not a live path. **CONFIRMED**
- `owner.json` — **not a config**: it is the plugin-seed lock owner file (`<lock>/owner.json {createdAt,pid}`, `withOfficialPluginSeedLock` `Ksn`). **CONFIRMED** (zcode.cjs @1 181 190)
- `wiki.json` — not a file; "wiki" is the repo-wiki feature (`repo-wiki` dir, manifest `wikiId`/`manifestHash`). The string `wiki.json` is only a *support-bundle redaction* artefact / filename pattern whitelist. **STRONGLY INFERRED** (no code path constructs `wiki.json`)
- `instructions.json`, `skills.json`, `commands.json`, `subagents.json`, `plugins.json`, `settings.behavior.json`, `state.json`, `task.json`, `tickets.json`, `memory.json` — these exact literals appear in the host bundle but not as config *paths*; they belong to memory/support-bundle filename vocabularies. Treat as **HYPOTHESIS** unless needed; the live `app-memory:*` channels (`app-memory:global-settings`, `:global-instructions`, …) are the real mechanism (host ch-host.json) and persist into `~/.zcode/v2` app-managed stores.

---

## 4. Core state objects (protocol schemas)

All shapes below are **CONFIRMED** from zod schemas in `x/chunks/out_host_chunk-RWMCBKS2.js` (the shared protocol chunk; mirrored byte-for-byte in `out_main_chunk-WR3FEWGO.js` and the scheduler). Aliases: `T`=`string().trim().min(1)`, `d`=same, `V`=`int().nonnegative()`, `F`=`record<string,unknown>`, `G`=modelRef.

### 4.1 Workspace — event/schema `O`
```ts
type Workspace = {
  workspacePath: string;            // absolute path (local) or remote path
  workspaceIdentity?: string;       // stable identity, preferred over path
  remoteSessionId?: string;         // set for remote/desktop-bridged workspaces
  workspaceKey: string;             // = workspaceIdentity?.trim() || workspacePath  (see §8)
};
```
Carried by: `workspace.upserted` / `workspace.removed` sync deltas, `workspace.list/set` command replies, every workspace-scoped RPC frame (`{workspacePath, workspaceIdentity?, remoteSessionId?}`), `session.updated` snapshot (`Iu.workspace`). **CONFIRMED**

### 4.2 Session — schema `Iu`
```ts
type Session = {
  sessionId: string; workspace: Workspace; parentSessionId?: string; traceId?: string;
  sessionKind: "interactive"|"fork"|"selection_side_chat"|"workflow_parent"|"workflow_child"|"subagent_child"|"nested_workflow_child";
  title: string; titleSource?: "default"|"first_input"|"generated"|"custom";
  mode: Mode; status: "idle"|"running"|"waiting"|"paused"|"completed"|"error";
  model?: ModelRef; target?: Target|null;
  createdAt: number; updatedAt: number; archivedAt?: number;
};
```
DB counterpart (`session` table): `project_id` (= workspace key), `directory`/`path`, `slug`, `share_url`, summary counters, `revert`, `permission` JSON, `time_archived`. **CONFIRMED**

### 4.3 Message / Part
```ts
type Message = { info: MessageInfo; parts: Part[] };
type UserMessageInfo = { messageId; sessionId; role:"user"; time; agent; model: ModelRef;
   system?: string; tools?: Record<string,boolean>; synthetic?; source?: InputSource;
   visibility?: "user-visible"|"model-only"; semantics?; metadata? };
type AssistantMessageInfo = { messageId; sessionId; role:"assistant"; time; parentMessageId; agent;
   model: ModelRef; path:{cwd,root}; cost: number; tokens: TokenCounts; finish?: string;
   error?; semantics?; structured? };
type Part = PartBase & (
 {type:"text", text; synthetic?; ignored?; metadata?} | {type:"reasoning", text; metadata?} |
 {type:"file", mime; filename?; url; metadata?} | {type:"tool", callId; tool; state: ToolState; metadata?} |
 {type:"step-start", snapshot?} | {type:"step-finish", reason; snapshot?; cost; tokens} |
 {type:"snapshot", snapshot} | {type:"patch", hash; files[]} |
 {type:"compaction", auto; reason?; summaryMessageId?; metadata?} |
 {type:"timeline", timelineType:"context_compaction"|"goal_verification"|"session_fork"|"model_change", …} |
 {type:"subagent", prompt; description; agent; model?; command?} |
 {type:"agent", name} | {type:"retry", attempt; error});
type ToolState = {status:"pending",input,raw} | {status:"running",input,title?,metadata?,startedAt}
              | {status:"completed",input,output,title,metadata,startedAt,completedAt}
              | {status:"error",input,error,metadata?,startedAt,completedAt};
type InputSource = "background_task"|"fork"|"goal_state_change"|"goal-continuation"|"plugin_reference"|"rewind"|"selection_side_chat"|"subagent"|"subagent_message"|"todo_reminder";
```
Carried by: `message.upserted/removed`, `part.started/delta/upserted/removed`, and the `session/event` snapshot (`mi.messages`). **CONFIRMED**

### 4.4 Settings block (session-scoped) — schema `Wh`
```ts
type SessionSettings = {
  appliedProviderRevision?: string;
  model: { current: ModelRef; available: Model[]; lastUsed?: ModelRef };
  thoughtLevel: { enabled: boolean; current?: string; defaultLevel?: string; available: ThoughtLevel[] };
  mode: { current: Mode };
  permission?: { mode?: Mode; rulesRevision?: number };
};
type ModelRef = { providerId: string; modelId: string; variant?: string };
type Model = { ref: ModelRef; label; providerLabel?; providerSource?; providerLogoUrl?; description?;
  contextWindow?; maxOutputTokens?; reasoning?; supportsImages/Pdf/Video/Tools/StructuredOutput?; disabledReason? };
type ThoughtLevel = { value: string; label: string; description?: string };
type Mode = "plan"|"build"|"edit"|"yolo"|"auto";
```
**CONFIRMED**. `model.list/set`, `model.provider.set`, `mode.list/set`, `thoughtLevel.list/set` operate on this block (bot command handlers in host `out_host_index.js` @1 498 6xx–1 507 5xx); DB mirror is `local_setting(scope=user|project, namespace=model|permission)`.

### 4.5 Projection (live session state) — schema `$C`
```ts
type Projection = { sessionId; status: SessionStatus; mode: Mode; turnCount; totalTokenCount;
  contextUsed; contextWindow; currentTurnId?;
  pendingPermissions: PendingPermission[]; activeToolCalls: ActiveToolCall[]; backgroundJobs: unknown[];
  target?: Target|null; lastError?: {type,code?,message,detail?,attribution?} };
type PendingPermission = { requestId; toolCallId; toolName; reason; riskLevel:"low"|"medium"|"high"|"critical";
  input?; origin?: SubagentOrigin; options: PermissionOption[]; requestedAt };
type ActiveToolCall = { toolCallId; toolName; status:"pending"|"running"|"completed"|"failed"|"denied"; startedAt? };
```
### 4.6 Permission — request `sR`, response `cR`, option `fp`, decision `vu`, rule `_u`/`m_`
```ts
type PermissionRequest = { requestId?; toolCallId; toolName; riskLevel; reason; input;
  suggestedPermissionUpdates?: {type:"addRules", behavior:"allow"|"deny"|"ask",
     rules:{toolName,ruleContent?}[]}[]; origin?; options: PermissionOption[] };
type PermissionOption = { optionId; kind; name; description?; response: PermissionResponse };
type PermissionResponse = { decision:"allow"|"deny"|"escalate"|"modify"; reason?; modifiedInput?;
  permissionUpdates?: AddRules[] };
type PermissionResolution = { requestId?; toolCallId; toolName?; decision?; reason?; modifiedInput?; inputSummary? };
```
Carried by `permission.requested` / `permission.resolved` session events and the `permission.request` / `permission.respond` RPC (`interactionRequestPermission`); persisted per-project in `permission` → `local_setting` namespace `permission` (`ruleset`, `mode`). **CONFIRMED**

### 4.7 Elicitation (user input) — `lR` / `dR`, renderer-side `xk`/`_k`/`vk`
```ts
type UserInputRequest = { requestId; prompt: string; inputType?:"text"|"choice"|"confirm"; choices?: string[] };
type UserInputResolution = { requestId; value?: unknown; cancelled?: boolean };
// renderer elicitation payload (host chunk @~383000):
type Elicitation = { taskId; requestId; runId; origin?; actorKey?; currentQuestionIndex;
  questions: {question,header,options:{value,label,description?}[],multiSelect?}[];
  answers: Record<string,string[]>; renderContext?: {kind:"plan_approval",plan}; 
  expandedCustomAnswerQuestionIndexes?: number[]; handledAt? };
```
Carried by `userInput.requested` / `userInput.resolved` and `elicitation.submit` / `elicitation.respond`. **CONFIRMED** (schema names in host chunk RWMCBKS2 @~440 000; `xk` in `out_host_chunk-RWMCBKS2.js` @~379 9xx)

### 4.8 Turn / Phase — `HC,XC,QC,eR,tR`
```ts
TurnInput   = { turnNumber; input; inputId?; queryId?; inputSource?; inputVisibility?;
                executionKind?:"agent"|"controlOnly"; targetId?; messageId?; intent?; originMeta?; attachments? };
TurnSteerQueued = { pendingInputId; inputId?; queryId?; input; inputPreview; inputSize;
                commandKind?:"sendText"|"sendGoalCommand"|"compact"; source?:"plan_approval_feedback";
                toolDisallowlist?; delivery?:"queue"|"guide"; targetTurnId; queueLength; intent? };
TurnSteerDrained = { pendingInputIds[]; queryIds?[]; targetTurnId; injectedMessageIds[]; drainedInputs?[] };
TurnCompleted = { response; tokenCount; usage?; toolCallCount; historyRoundCount?; duration; cacheStats?;
                inputId?; resultType:"success"|"cancelled"|"error_max_turns"|"error_max_budget"|"error_during_execution"|"error_max_tool_calls" };
TurnFailed = { error: ProtocolError; turnPhase: string; inputId? };
```
Events: `turn.started`, `turn.completed`, `turn.failed`, `turn.steerQueued`, `turn.steerDrained`. `phase.completed` / `phase.error` are **workflow-phase** events (scheduler/workflow runtime), and `turnPhase` is a string carried inside `turn.failed`. **CONFIRMED** for the schemas; phase.* only as literals in the host bundle.

### 4.9 Reply / bot reply granularity — `kk` + `yk` + `bk`/`Sk`
```ts
type Bot = { id; name; provider:"…"; enabled; credentialRef?; webhookSecretRef?; webhookUrl?;
  webhookAuthHeaderName?; feishuAppId?; providerUserId?; displayName?;
  allowedWorkspaces: string[]; allowedCommands: {status,new,workspace,model,mode?,thoughtLevel,reply,…};
  currentOptions: {model?,mode?,thoughtLevel?,sandboxMode?,approvalPolicy?,cli?};
  replyMode: "assistant_changes"|"assistant_toolcalls_changes"|"summary_changes"|"streaming_card" };
```
`reply.list/set` only switches `bot.replyMode` (non-feishu providers support all 4; feishu only `streaming_card`). Persisted in `~/.zcode/v2/bot-state.v2.json` (runtime bots) and bot config in main process. **CONFIRMED**

### 4.10 Automation — table row ↔ object (`rowToAutomation` `hd`)
```ts
type Automation = { automationId; title; cronExpr; prompt; model?; provider?;
  mode?: "plan"|"build"|"edit"|"yolo"|"auto"; thoughtLevel?;
  workspaceKey; workspacePath; workspaceIdentity?; targetTaskId?;
  locationKind:"local"|"remote"; recurring:boolean; maxRuns?; endAt?; scheduleRule?; scheduleEditedByUser?;
  runCount; enabled; lifecycleStatus; nextRunAt?; lastRunAt?; dispatchStatus; dispatchAttempts;
  retryAt?; lastError?; createdAt; updatedAt };
```
Plus `automation_runs` rows `{runId,automationId,workspaceKey,scheduledAt?,trigger:"schedule",dispatchStatus:"claimed",outcome?,sessionId?,error?,attempts,createdAt,updatedAt}`. Created by tools `CronCreate/CronUpdate/CronDelete`; cap 20. **CONFIRMED** (host-index.js @146 127 `hd`, @146 441 rowToAutomation, DDL @148 804)

### 4.11 StreamRecovery — event `streamRecovery.updated`
```ts
payload: Record<string, unknown>            // zod: F (open record)
```
Dedicated coalescing key `${type}\0${sessionId}\0${turnId??""}\0${inputId??""}\0${traceId??""}`; background events are buffered (`flushDelayMs=1500`, `maxItems=96`) and deltas merged (`mergeBackgroundSessionEvents`). The recovery payload is produced by the CLI runtime (not typed in these bundles) — treat concrete fields as **HYPOTHESIS**; the event identity, payload type and coalescing are **CONFIRMED** (host-index.js @143 9xx `xSe`/`ASe`/`aY`).

### 4.12 Target (goal mode) — `ku` / DB `session_target`
```ts
type Target = { sessionId; targetId; objective; summaryTitle: string|null;
  status:"active"|"paused"|"budget_limited"|"complete"; tokenBudget: number|null; tokensUsed;
  timeUsedSeconds; activeInputId?: string|null; activeRunStartedAtMs?: number|null;
  activeRunLastSeenAtMs?: number|null; createdAt; updatedAt };
```
**CONFIRMED** (`out_host_chunk-RWMCBKS2.js` @~431 000)

### 4.13 Session snapshot (full state frame) — `mi`
```ts
type SessionSnapshot = { protocol:{name:"ZCode Protocol",version:1}; session: Session; settings: SessionSettings;
  projection: Projection; runtime: RuntimeState; messages: Message[];
  goalStats?: {timeUsedSeconds,tokensUsed,tokenBudget,contextUsed,contextWindow,toolCallCount,iterationCount};
  todos?: Todo[]; todoGroups?: {id,source:"goal_iteration"|"session",goalIteration?,targetId?,startedAt?,updatedAt?,todos:Todo[]}[];
  slashCommands?: {name,description,inputHint?,source:"builtin"|"custom"}[] };
type Todo = { content; status:"pending"|"in_progress"|"completed"; priority:"high"|"medium"|"low" };
type RuntimeState = { eventSeq; stateRevision; deliveryKind?:"desktop-continuous"|"web-remote-replayable";
  activeTurnId?; activeTurnKind?:"regular"|"compact"|"rewind"; pendingRequestIds: string[];
  apiRetry?: {kind:"api_retry",attempt,maxRetries,retryDelayMs,errorStatus,error}|null;
  contextUsage?: {used,size,cost?,cache?,breakdown?}; goalVerifications?[]; goalVerificationTimeline?[] };
```
Carried by `session.getSnapshot`-style responses and `session.event` batch frames; `deliveryKind` controls replay policy. **CONFIRMED**

---

## 5. State mutation & observation

### 5.1 The `session.event` envelope (25 event types) — `KL` / `Gh`
```
session.created, session.resumed, session.updated, session.titleUpdated, session.closed,
turn.started, turn.steerQueued, turn.steerDrained, turn.completed, turn.failed,
message.upserted, message.removed, part.started, part.delta, part.upserted, part.removed,
model.streaming, tool.updated, permission.requested, permission.resolved,
userInput.requested, userInput.resolved, checkpoint.created, rewind.triggered, streamRecovery.updated
```
Envelope `ZC`: `{eventId, sessionId, turnId?, seq, traceId?, timestamp, deliveryKind?}`. Transport: JSON-RPC notification method **`session/event`** (`A6.safeParse` in the host, then `Sf` = `handleSessionEvent`, which de-dupes via `liveEventIds` and forwards `{type:"session.event",event}` to that session's subscribers only). `state.updated` is a separate notification method parsed by `$6` (schema `YL`) and dispatched by `Bc` (`handleStateUpdated`): if it has `sessionId` → session-scoped; else broadcast. **CONFIRMED** (host-index.js @328 626–330 500; chunk RWMCBKS2 @428 5xx–441 6xx)

### 5.2 Event → what changed → emitter

| event / op | what changed | emitted by |
|---|---|---|
| `session.updated` | session summary/title/archived/settings; payload open record (`F`) | CLI runtime (zcode.cjs), re-broadcast by host |
| `session.titleUpdated` | `{previousTitle,title,source,modelRef?,messageID?}` | CLI title generator |
| `session.created` | `{mode,contextWindow}` | CLI |
| `session.resumed` | `{directory,interruptedToolCount,messageCount,partCount,recoveredCompactTimelineCount?,recoveredSteerInputCount?,resumedTodoCount?}` | CLI startup recovery |
| `turn.started/completed/failed/steerQueued/steerDrained` | turn lifecycle & steering (4.8) | CLI turn engine |
| `message.upserted` / `message.removed` | conversation rows | CLI (writes `message` table) |
| `part.started` / `part.delta` / `part.upserted` / `part.removed` | message parts (`part.delta` = `{messageId,partId,field?:text\|reasoning\|input\|output,delta}`) | CLI |
| `model.streaming` | token stream `{kind,delta,done,input?,toolCallId?,toolName?,assistantMessageId?,partId?}`; kinds `start/finish/error/text_*/reasoning_*/tool_input_*/tool_call` | CLI model client |
| `tool.updated` | tool call state machine: `scheduled`→`started`→`progress`→`result`/`error`, plus `batch` and `raw`; base `{toolCallId,toolName?,parentToolCallId?,source?,agentId?...}` | CLI tool executor |
| `permission.requested` / `permission.resolved` | approval flow (4.6); host maps RPC `interactionRequestPermission` → `Ye(...)` session event | CLI → host |
| `userInput.requested` / `userInput.resolved` | elicitation flow | CLI |
| `streamRecovery.updated` | recovery marker for a turn (coalesced 1.5 s / 96 items) | CLI |
| `checkpoint.created`, `rewind.triggered` | git checkpoints / rewind | CLI |
| `state.updated` | `{scope:"server"\|"workspace"\|"session", workspace?, sessionId?, revision, reason?, patch}` — coarse state push; also the bot/desktop `{type:"state.updated", notification}` variant forwarded by host `Bc` | CLI runtime; host forwards |
| `workspace.upserted` / `workspace.removed`, `task.upserted` / `task.removed`, `session.upserted`/removed `op` deltas | task-index & workspace-list sync frames (`{op, …}`, frames `{indexLogEpoch,fromSeq,toSeq,payload:{kind:"snapshot"\|"deltas"}}`) | desktop main (task index writer), consumed by host (`applySessionsIndexFrame` Gt / `applyWorkspaceConfigFrame` xt) and renderer |
| `workspace_config_options_update` | per-workspace config options changed | host → renderer |
| `phase.completed` / `phase.error` | workflow phase transitions | scheduler/workflow runtime |
| `runtime/model_selection`, `runtime/workspace_checkpoint`, `runtime/bash_shell_selection`, `target_completion_verification`, `runtime/user_input_auto_resolution` | durable `session_entry` records (append-only) | CLI |

**CONFIRMED** for names/payloads as cited; the division of labor (CLI emits, host forwards, main writes index) is **CONFIRMED** for host/main roles and **STRONGLY INFERRED** for the CLI role (events are emitted inside zcode.cjs which owns the DB; only `session/event` consumption is visible in host bundles).

### 5.3 Observation surface (RPC)

Host RPC surface (dotted methods, already known + verified here): `workspace.list/set`, `task.list/set`, `model.list/set`, `model.provider.set`, `mode.list/set`, `thoughtLevel.list/set`, `reply.list/set`, `permission.request/respond`, `elicitation.submit/respond`, `mcp.servers`, plus JSON-RPC notifications `session/event`, `state.updated`, `interactionRequestPermission`, `interactionRequestUserInput`, `plugin.operation.progress`, `conversationTelemetryFact`, `cuaPermissionObservation`. Bot-command layer maps `/workspace`, `/model`, `/mode`, `/thoughtlevel`, `/task`, `/reply`, `/stop`, `/permission`, `/elicitation`, `/approve`, `/deny` to those same mutations (host `out_host_index.js` @1 498 646–1 510 700). **CONFIRMED**

---

## 6. Persistence layer inventory

| # | mechanism | path | format | owner | growth | safe to touch externally |
|---|---|---|---|---|---|---|
| 1 | session store | `~/.zcode/cli/db/db.sqlite` (+`-wal`,`-shm`) | SQLite (WAL) | CLI agent (`zcode.cjs`) | core; 144 MB now | **read-only**; writes require matching migration checksums and will corrupt live sessions |
| 2 | task index | `~/.zcode/v2/tasks-index.sqlite` (+wal) | SQLite (WAL, `node:sqlite`) | desktop host | small (1.3 MB) | read-only safe-ish; writers are host/scheduler |
| 3 | model I/O rollout | `~/.zcode/cli/rollout/model-io-<sessionId>.jsonl` | JSONL, 1 record per model request/response attempt | CLI model client | 300 KB–800 KB per active session, appended | append-only; safe to read; deleting loses diagnostics only |
| 4 | logs | `~/.zcode/cli/log/zcode-YYYY-MM-DD.jsonl` | JSONL `{timestamp,level,event,module,message,traceId,spanId,parentSpanId,sessionId,turnId,toolCallId,durationMs,status,context}` | CLI | ~25 MB/day on this machine | safe to read |
| 5 | app logs | `~/.zcode/v2/logs/<date>.log`, `~/.zcode/feedback/{logs,attachments}`, `~/.zcode/v2/crash/live` | text / crashpad | main | varies | read-only |
| 6 | subagent artifacts | `~/.zcode/cli/agents/<sessionId>/agent_<uuid>/{metadata.json,output.txt,task.output}` | JSON + text; metadata = `{agentId,childSessionId,parentSessionId,parentToolUseId,profileId,profileSnapshot{name,description,color,injectAgentsMd,source,systemPrompt},cwd,description,createdAt,outputFile,metadataFile}` | CLI subagent runner | one dir per subagent | safe to read |
| 7 | tool result artifacts | `~/.zcode/cli/artifacts/<sessionId>/<callId>-tool-result-<uuid>.{json,txt}` | JSON/text snapshots of oversized tool results | CLI | grows with tool use | safe to read |
| 8 | exec logs | `~/.zcode/cli/exec/<sessionId>/<callId>-{stdout,stderr}.log` | plain text | CLI bash tool | grows with `Bash` calls | safe to read |
| 9 | shell snapshots | `~/.zcode/cli/exec/shell-snapshots/snapshot-bash-<ms>-<rand>.sh`, `exec/bash-startup/<sessionId>/embedded-search-startup-<id>.sh` | shell script (87 KB env snapshot; startup shim that wraps `grep` etc.) | CLI bash tool | per shell start | read-only |
| 10 | image cache | `~/.zcode/cli/image-cache/<sessionId>/image-<md5>.png` | PNG | CLI media pipeline | per attached image | safe to read |
| 11 | plugin store | `~/.zcode/cli/plugins/{cache,data,marketplaces,installed_plugins.json,known_marketplaces.json,icon-sources.json}` | JSON registries + extracted plugin trees; `installed_plugins.json` = `{version,plugins:[{id,name,marketplace,version,installPath,installedAt,updatedAt,scope,source{type,url,sha256,path},cacheTransactionId}]}`; `known_marketplaces.json` similar; `icon-sources.json` = `[{name,icon,mimeType}]` | CLI plugin manager | grows with installs (cache dirs per version) | **do not write**; host validates |
| 12 | desktop app settings | `~/.zcode/v2/setting.json` (+`config.json`, `credentials.json`, `bot-state.v2.json`, `telemetry-state.json`, `coding-plan-cache.json`) | JSON | Electron main | small | writes must go through the app (it rewrites atomically) |
| 13 | Chromium Local Storage | `%APPDATA%\ZCode\session\Local Storage\leveldb` | LevelDB | renderer | small MBs | Chromium-locked while running; read with a copy |
| 14 | Chromium Session Storage | `…\session\Session Storage` | LevelDB | renderer | small | as above |
| 15 | Chromium IndexedDB | `…\session\IndexedDB\file__0.indexeddb.leveldb` — one database observed: `feilin_indexeddb_<ms>` (two instances) | LevelDB | renderer (embedded webviews) | small | as above |
| 16 | Chromium cookies / network | `…\session\Network\{Cookies,TransportSecurity,Trust Tokens,Network Persistent State}`, `DIPS`, `DIPS-wal` | Chromium formats | app | grows with browsing | cookies encrypted via `os_crypt` (DPAPI) — flagged by support-bundle redaction |
| 17 | Chromium prefs | `…\session\Preferences`, `…\session\Local State` (`os_crypt.encrypted_key` = DPAPI blob **[REDACTED]**), `SharedStorage`, `WebStorage\QuotaManager` | JSON/binary | Electron | small | Local State contains the cookie-encryption key — do not export |
| 18 | webview partitions | `…\session\Partitions\zcode-coding-plan`, `…\zcode-embedded-browser` | Chromium profile per partition | main | grows with use | read-only |
| 19 | telemetry/rum | `%APPDATA%\ZCode\rum-electron-store\ZGVmYXVsdA.json` (`{_arms_session,_arms_uid}`), `zcode-data-size-telemetry.json` (`{lastReportedAt}`), `.updaterId` (uuid) | JSON | main | tiny | safe to read |
| 20 | repo/wiki/checkpoints (lazy) | `~/.zcode/v2/{repo-snapshots,repo-wiki,sessions,session-bindings,checkpoints,agent-config}`; `~/.zcode/cli/git-checkpoint-index` (`ox()`), legacy task snapshots `~/.zcode/v2/sessions/<sha12>/<taskId>.json` (`Hl`) | mixed | host/CLI | per feature | read-only |

**Renderer storage keys** (client state; **CONFIRMED** by scanning all 2 682 renderer JS assets; only `styles-DyAcaLKy.js` — the app bundle — plus 5 small files use storage):

- localStorage: `zcode-theme`, `zcode-locale`/`zcode-locale-preference`, `zcode-mcp-config` (+ legacy migration key `zcode-mcp-deleted-preload`), `zcode-last-agent-provider`, `zcode-last-agent-model` (prefix pattern `${k}:${provider}:${model}`), `zcode-last-draft-collaboration-mode`, `zcode-v4-client-id:v1` (`client-<hex>`), `zcode-v4-last-session:v1:<workspaceKey>`, `zcode-v4-pane-layout:v1` / `:v2`, `zcode-v4-pending-commands:v1`, `zcode-v4-composer-drafts:v1:<scopeKey>` (+ older `zcode-chat-composer-drafts:v1:`), `zcode-chat-prompt-history:<scope>`, `zcode-command-center-search-history:<scope>`, `zcode-task-snapshot-cache:v1`, `zcode-usage-entitlement:<providerId>:<fingerprint>`, `zcode:sidebar-usage-coding-plan-provider`, `zcode.feedback.contact`, `zcode-cua-permission-status`, `zcode:usage-entitlement:`, `zcode-settings-last-section`, `zcode:developer-tools:enabled`, `zcode:token-debug:enabled`, `zcode:auth:jwt-invalid-restart`, `zcode:workspace-shell:sidebar-width-px`, `react-resizable-panels:workspace-shell-layout:sidebar:content`, `zcode-sidebar-task-preferences`, `zcode-sidebar-purpose-section-preferences`, `zcode-web-remote-control-mobile-task-home-preferences`, `zcode:web-remote-control:collapse-navigation-once`, `zcode-grouped-task-collapsed-groups`, `zcode-v4-session-workbench-groups:v1`, editor find keys (`zcode-v4-conversation-find*`, `zcode-model-trajectory-find*`), `zcode-default-group-cron`, `zcode-default-group-off-peak`, `zcode:coding-plan:report-context` (report context injected into the coding-plan webview), plus OAuth tokens injected into the *embedded coding-plan webview* by main: `oauth:zai:access_token`, `zcodejwttoken`, `oauth:bigmodel:access_token` (removed again on logout via `CZe`). **CONFIRMED**
- sessionStorage (one-shot UI intents, written then removed): `zcode-settings-section-intent`, `zcode-settings-usage-tab-intent`, `zcode-settings-plugin-tab-intent`, `zcode-settings-plugin-origin-intent`, `zcode-settings-plugin-scope-key-intent`, `zcode-settings-model-provider-id-intent`, `zcode:settings-section-intent`. **CONFIRMED**

---

## 7. Secrets / auth storage

| secret | where | protection |
|---|---|---|
| Provider API keys (Z.ai/BigModel/OpenRouter/DeepSeek/…) | `~/.zcode/v2/config.json` → `provider.<id>.options.apiKey` | **plaintext JSON** (verified: `58ddd320…`, `eyJhbGci…`, `sk-or-v1…`, `sk-4eafb…` prefixes; values NOT printed) — file mode 0600-ish via `mode:384` writes (`ew`) |
| Z.ai OAuth tokens + user info | `~/.zcode/v2/credentials.json` → keys `oauth:zai:access_token`, `zcodejwttoken`, `oauth:zai:user_info`, `oauth:active_provider` | **AES-256-GCM, but keyed from machine identity** — the key falls back to a value derived from the machine's own identity when `ZCODE_CREDENTIAL_SECRET` is unset, so the file is obfuscated rather than truly encrypted. Precise derivation withheld from this public document; the class and the mitigation are what matter. **[values REDACTED]** |
| Bot credentials (telegram/feishu/weixin/webhooks) | bot config (`~/.zcode/v2/bot-state.v2.json` + main-process bot store): `credentialRef`, `webhookSecretRef` — *references*, actual secret values live in the credentials store under those refs | via credential store |
| Chromium cookies / site sessions | `%APPDATA%\ZCode\session\Network\Cookies`; encryption key in `session\Local State` → `os_crypt.encrypted_key` (DPAPI, user-bound) | OS DPAPI — **[REDACTED]** |
| Coding-plan webview session | tokens injected into the webview's localStorage (keys in §6) | plaintext inside Chromium profile |
| `ZCODE_CREDENTIAL_SECRET`, `ZCODE_DATA_BASE_DIR` | env vars | — |

Support bundles explicitly redact `credentials.json` / `.credentials.json` and key-matching fields (`password|secret|token|credential|api[-_]?key|…` → `***REDACTED***`, main-index @1 192 228). **CONFIRMED**

---

## 8. Workspace representation

**Key rule (single source of truth):**
```js
// host: out_host_chunk-BG4MS6RN.js @47323  (exported, name-registered "workspaceKey")
function workspaceKey(r){ return r.workspaceIdentity?.trim() || r.workspacePath }
// host: out_host_index.js @1393702 "getWorkspaceKey" — identical
function getWorkspaceKey(e,t){ return t?.trim() || e }
// zod refinement (OUT_HOST_CHUNK-RWMCBKS2 @354812): "workspaceKey must match workspaceIdentity fallback rule"
```
So: `workspace_key = workspace_identity.trim() || workspace_path`. On this machine `workspace_identity` is usually absent → key = path. **CONFIRMED**

- `workspace_identity` is provided for **remote/bridged workspaces** (required together with `remoteSessionId` for bridges: `isBridgeableRemoteTarget`, main-index @1 156 202) and by the desktop for workspaces whose path alone is not stable; otherwise omitted. **CONFIRMED** (requirement checks) / **STRONGLY INFERRED** (desktop only supplies it for remote)
- `workspace_path` = absolute local path (or remote path). `workspaceKey` is also used as the "workspaceId" in bot contexts: `createWorkspaceRef` (`CI`) = `{id: key, label: basename(path), workspacePath, workspaceIdentity}`; label = last path segment (`Lj`). **CONFIRMED**
- Hashing for per-workspace dirs: `getWorkspaceHash = sha256(getWorkspaceKey(path,identity)).hex.slice(0,12)` (`dd`) → used by `getTaskSessionDir` (`~/.zcode/v2/sessions/<hash12>`), `getProviderWorkspaceConfigDir` (`~/.zcode/v2/agent-config/<provider>/<hash12>`). **CONFIRMED** (host-index.js @15 200–15 400)
- Session rows store this key as `session.project_id` (`proj_<lowercased path with - and _>`; e.g. `proj_example`, `proj_c-users-mnehm-.zcode-workspace-default`) and NULL in `workspace_id` on this machine — so the CLI project_id is *derived from the workspace key*, while the desktop tasks-index stores the raw `(workspace_key, workspace_path, workspace_identity)` triple in `tasks`, `automations`, `off_peak_tasks`. **CONFIRMED** (session sample rows; tasks DDL)
- Workspace enumeration: host builds `WorkspaceRef[]` via bot/desktop providers (`Ds({currentWorkspace})` → `workspaces`; filter by bot `allowedWorkspaces` with `*` = all, `zh`/`RI`; canonicalization `PBe` prefers a unique path match with identity). The task-index/workspace-list sync frames (`workspace.upserted/removed`, `task.upserted/removed`, `session.upserted` deltas) are how the renderer enumerates. `setting.json.lastWorkspaceSession[]` records the last session per workspace `{kind:"local", workspacePath, workspacePurpose}`; `ex()` = `~/.zcode/workspace/default` is the fallback "conversation workspace". **CONFIRMED**

---

## Appendix A — Verbatim DDL

### A.1 VERBATIM sqlite_master (db.sqlite, production file)

```sql
CREATE TABLE input_history (
        id text primary key,
        project_id text not null,
        session_id text,
        text text not null,
        kind text not null,
        time_created integer not null
      , attachments text)

CREATE TABLE local_setting (
        scope text not null,
        scope_id text not null,
        namespace text not null,
        key text not null,
        value text not null,
        schema_version integer not null,
        time_created integer not null,
        time_updated integer not null,
        primary key(scope, scope_id, namespace, key)
      )

CREATE TABLE message (
        id text primary key,
        session_id text not null references session(id) on delete cascade,
        time_created integer not null,
        time_updated integer not null,
        data text not null
      , sequence integer)

CREATE TABLE model_usage (
        id text primary key,
        logical_request_id text not null,
        attempt_index integer not null default 0,
        session_id text not null references session(id) on delete cascade,
        turn_id text,
        trace_id text,
        span_id text,
        assistant_message_id text,
        parent_user_message_id text,
        query_source text not null,
        provider_id text not null,
        model_id text not null,
        variant text,
        agent text,
        mode text,
        task_type text,
        status text not null check(status in ('running', 'completed', 'error', 'cancelled')),
        started_at integer not null,
        first_token_at integer,
        completed_at integer,
        duration_ms integer,
        time_to_first_token_ms integer,
        finish_reason text,
        tool_call_count integer not null default 0,
        input_tokens integer not null default 0,
        output_tokens integer not null default 0,
        reasoning_tokens integer not null default 0,
        cache_creation_input_tokens integer not null default 0,
        cache_read_input_tokens integer not null default 0,
        provider_total_tokens integer,
        computed_total_tokens integer not null default 0,
        retry_count integer not null default 0,
        retryable integer not null default 0 check(retryable in (0, 1)),
        cancelled_by_user integer not null default 0 check(cancelled_by_user in (0, 1)),
        context_exceeded integer not null default 0 check(context_exceeded in (0, 1)),
        error_type text,
        error_code text,
        error_message text,
        raw_usage_json text,
        provider_metadata_json text
      )

CREATE TABLE part (
        id text primary key,
        message_id text not null references message(id) on delete cascade,
        session_id text not null,
        time_created integer not null,
        time_updated integer not null,
        data text not null
      , sequence integer)

CREATE TABLE permission (
        project_id text primary key,
        time_created integer not null,
        time_updated integer not null,
        data text not null
      )

CREATE TABLE schema_migration (
        id text primary key,
        checksum text not null,
        app_version text,
        time_applied integer not null
      )

CREATE TABLE session (
        id text primary key,
        project_id text not null,
        workspace_id text,
        parent_id text,
        slug text not null,
        directory text not null,
        path text,
        title text not null,
        version text not null,
        share_url text,
        summary_additions integer,
        summary_deletions integer,
        summary_files integer,
        summary_diffs text,
        revert text,
        permission text,
        time_created integer not null,
        time_updated integer not null,
        time_compacting integer,
        time_archived integer
      , task_type text not null default 'interactive', title_source text not null default 'first_input'
        check(title_source in ('default', 'first_input', 'generated', 'custom')), title_message_id text, time_title_updated integer, trace_id text)

CREATE TABLE session_entry (
        id text primary key,
        session_id text not null references session(id) on delete cascade,
        type text not null,
        time_created integer not null,
        time_updated integer not null,
        data text not null
      )

CREATE TABLE session_input (
        id text primary key,
        session_id text not null references session(id) on delete cascade,
        kind text not null,
        delivery text not null check(delivery in ('startNow', 'guide', 'queue')),
        payload text not null,
        admitted_sequence integer not null,
        promoted_sequence integer,
        promoted_message_id text,
        status text not null check(status in ('admitted', 'promoted', 'cancelled', 'discarded', 'failed')),
        status_reason text,
        time_created integer not null,
        time_updated integer not null
      )

CREATE TABLE "session_target" (
        session_id text primary key references session(id) on delete cascade,
        target_id text not null,
        objective text not null,
        status text not null check(status in ('active', 'paused', 'budget_limited', 'complete')),
        token_budget integer,
        tokens_used integer not null default 0,
        time_used_seconds integer not null default 0,
        time_created integer not null,
        time_updated integer not null
      , summary_title text, active_input_id text, active_run_started_at integer, active_run_last_seen_at integer)

CREATE TABLE session_task_link (
        id text primary key,
        root_workflow_run_id text references workflow_run(id) on delete cascade,
        parent_link_id text references session_task_link(id) on delete cascade,
        activity_id text references workflow_activity(id) on delete set null,
        parent_session_id text references session(id) on delete set null,
        child_session_id text not null references session(id) on delete cascade,
        role text not null,
        depth integer not null default 0,
        path text not null,
        phase text,
        label text,
        agent_type text,
        model text,
        status text not null,
        time_created integer not null,
        time_updated integer not null,
        unique(child_session_id)
      )

CREATE TABLE todo (
        session_id text not null references session(id) on delete cascade,
        content text not null,
        status text not null,
        priority text not null,
        position integer not null,
        time_created integer not null,
        time_updated integer not null,
        primary key(session_id, position)
      )

CREATE TABLE tool_usage (
        id text primary key,
        session_id text not null references session(id) on delete cascade,
        turn_id text,
        trace_id text,
        tool_call_id text not null,
        tool_name text not null,
        side_effect_scope text,
        read_only integer check(read_only in (0, 1)),
        destructive integer check(destructive in (0, 1)),
        approval_status text,
        status text not null check(status in ('running', 'completed', 'error', 'cancelled')),
        started_at integer not null,
        first_output_at integer,
        completed_at integer,
        duration_ms integer,
        time_to_first_output_ms integer,
        exit_code integer,
        output_bytes integer not null default 0,
        stdout_bytes integer not null default 0,
        stderr_bytes integer not null default 0,
        truncated integer not null default 0 check(truncated in (0, 1)),
        retry_count integer not null default 0,
        retryable integer not null default 0 check(retryable in (0, 1)),
        cancelled_by_user integer not null default 0 check(cancelled_by_user in (0, 1)),
        error_type text,
        error_code text,
        error_message text
      )

CREATE TABLE turn_usage (
        session_id text not null references session(id) on delete cascade,
        turn_id text not null,
        trace_id text,
        user_message_id text,
        status text not null check(status in ('running', 'completed', 'error', 'cancelled')),
        started_at integer not null,
        first_model_start_at integer,
        first_token_at integer,
        completed_at integer,
        duration_ms integer,
        time_to_first_token_ms integer,
        model_request_count integer not null default 0,
        model_retry_count integer not null default 0,
        tool_call_count integer not null default 0,
        tool_error_count integer not null default 0,
        input_tokens integer not null default 0,
        output_tokens integer not null default 0,
        reasoning_tokens integer not null default 0,
        cache_creation_input_tokens integer not null default 0,
        cache_read_input_tokens integer not null default 0,
        computed_total_tokens integer not null default 0,
        retryable integer not null default 0 check(retryable in (0, 1)),
        cancelled_by_user integer not null default 0 check(cancelled_by_user in (0, 1)),
        context_exceeded integer not null default 0 check(context_exceeded in (0, 1)),
        error_type text,
        error_code text,
        primary key(session_id, turn_id)
      )

CREATE TABLE workflow_activity (
        id text primary key,
        run_id text not null references workflow_run(id) on delete cascade,
        parent_activity_id text,
        call_index integer not null,
        call_path text not null,
        attempt integer not null default 1,
        type text not null,
        phase text,
        label text,
        input_hash text not null,
        prompt text,
        opts_json text,
        status text not null check(status in (
          'queued',
          'running',
          'completed',
          'failed',
          'skipped',
          'cancelled',
          'cached',
          'lost'
        )),
        child_session_id text references session(id) on delete set null,
        result_json text,
        error_json text,
        time_created integer not null,
        time_started integer,
        time_updated integer not null,
        time_completed integer,
        unique(run_id, call_path, attempt)
      )

CREATE TABLE workflow_definition (
        id text primary key,
        name text not null,
        source text not null check(source in ('builtin', 'user')),
        trusted integer not null default 0 check(trusted in (0, 1)),
        enabled integer not null default 1 check(enabled in (0, 1)),
        script_path text,
        script_hash text not null,
        meta_json text not null,
        time_created integer not null,
        time_updated integer not null
      , scope text not null default 'explicit'
        check(scope in ('builtin', 'explicit', 'project', 'user')))

CREATE TABLE workflow_event (
        id text primary key,
        run_id text not null references workflow_run(id) on delete cascade,
        sequence integer not null,
        type text not null,
        phase text,
        activity_id text references workflow_activity(id) on delete set null,
        payload_json text,
        time_created integer not null,
        unique(run_id, sequence)
      )

CREATE TABLE workflow_run (
        id text primary key,
        definition_id text,
        name text not null,
        kind text not null default 'script',
        parent_session_id text references session(id) on delete set null,
        cwd text not null,
        script_path text,
        script_hash text not null,
        args_json text,
        args_hash text,
        status text not null check(status in (
          'pending',
          'running',
          'paused',
          'completed',
          'failed',
          'cancelled'
        )),
        current_phase text,
        budget_total integer,
        budget_spent integer not null default 0,
        stats_json text,
        failure_json text,
        time_created integer not null,
        time_started integer,
        time_updated integer not null,
        time_completed integer
      )

CREATE INDEX input_history_project_time_idx
        on input_history(project_id, time_created desc, id desc)

CREATE INDEX input_history_time_idx
        on input_history(time_created desc, id desc)

CREATE INDEX local_setting_namespace_key_idx
        on local_setting(namespace, key)

CREATE INDEX local_setting_scope_idx
        on local_setting(scope, scope_id)

CREATE INDEX message_session_sequence_idx
        on message(session_id, sequence, time_created, id)

CREATE INDEX message_session_time_created_id_idx
        on message(session_id, time_created, id)

CREATE INDEX model_usage_query_source_idx
        on model_usage(query_source)

CREATE INDEX model_usage_session_turn_idx
        on model_usage(session_id, turn_id)

CREATE INDEX model_usage_started_model_idx
        on model_usage(started_at, provider_id, model_id)

CREATE INDEX model_usage_trace_idx
        on model_usage(trace_id)

CREATE INDEX part_message_id_id_idx on part(message_id, id)

CREATE INDEX part_message_sequence_idx
        on part(message_id, sequence, time_created, id)

CREATE INDEX part_session_idx on part(session_id)

CREATE INDEX part_session_message_sequence_idx
        on part(session_id, message_id, sequence)

CREATE INDEX session_entry_session_idx on session_entry(session_id)

CREATE INDEX session_entry_session_type_idx on session_entry(session_id, type)

CREATE INDEX session_entry_time_created_idx on session_entry(time_created)

CREATE INDEX session_input_session_admitted_idx
        on session_input(session_id, admitted_sequence)

CREATE INDEX session_input_session_status_idx
        on session_input(session_id, status)

CREATE INDEX session_parent_idx on session(parent_id)

CREATE INDEX session_project_idx on session(project_id)

CREATE INDEX session_task_link_activity_idx
        on session_task_link(activity_id)

CREATE INDEX session_task_link_parent_idx
        on session_task_link(parent_link_id)

CREATE INDEX session_task_link_root_workflow_idx
        on session_task_link(root_workflow_run_id, depth, path)

CREATE INDEX session_task_type_idx on session(task_type)

CREATE INDEX session_trace_idx on session(trace_id)

CREATE INDEX session_workspace_idx on session(workspace_id)

CREATE INDEX todo_session_idx on todo(session_id)

CREATE UNIQUE INDEX tool_usage_session_tool_call_idx
        on tool_usage(session_id, tool_call_id)

CREATE INDEX tool_usage_session_turn_idx
        on tool_usage(session_id, turn_id)

CREATE INDEX tool_usage_started_tool_idx
        on tool_usage(started_at, tool_name)

CREATE INDEX turn_usage_started_idx
        on turn_usage(started_at)

CREATE INDEX workflow_activity_child_session_idx
        on workflow_activity(child_session_id)

CREATE INDEX workflow_activity_run_status_idx
        on workflow_activity(run_id, status, call_index)

CREATE INDEX workflow_definition_source_idx
        on workflow_definition(source, enabled)

CREATE INDEX workflow_event_run_sequence_idx
        on workflow_event(run_id, sequence)

CREATE INDEX workflow_run_cwd_status_idx
        on workflow_run(cwd, status, time_updated desc)

CREATE INDEX workflow_run_definition_idx
        on workflow_run(definition_id)

CREATE INDEX workflow_run_parent_session_idx
        on workflow_run(parent_session_id)

CREATE TRIGGER message_sequence_autofill
      after insert on message
      when new.sequence is null
      begin
        update message
        set sequence = (
          select coalesce(max(sequence), -1) + 1
          from message
          where session_id = new.session_id
        )
        where id = new.id;
      end

CREATE TRIGGER part_sequence_autofill
      after insert on part
      when new.sequence is null
      begin
        update part
        set sequence = (
          select coalesce(max(sequence), -1) + 1
          from part
          where message_id = new.message_id
        )
        where id = new.id;
      end

```

### A.2 Row counts

| table | rows |
|---|---|
| input_history | 100 |
| local_setting | 14 |
| message | 8720 |
| model_usage | 7485 |
| part | 32668 |
| permission | 0 |
| schema_migration | 18 |
| session | 36 |
| session_entry | 1596 |
| session_input | 436 |
| session_target | 2 |
| session_task_link | 0 |
| todo | 162 |
| tool_usage | 8388 |
| turn_usage | 406 |
| workflow_activity | 0 |
| workflow_definition | 0 |
| workflow_event | 0 |
| workflow_run | 0 |

### A.3 schema_migration rows

```
('0001_base_session_store', '60e2d6a38ab36f31417c4f92c02690c96c7dcaaa0b6abe1741117d62a55c6462', '0.2.0', 1788449677872)
('0002_local_setting', '22a6ada9325c9ad55a00a1f0ecf72332c63c1e89fc3d91fec8d155bb0058b465', '0.2.0', 1788449677872)
('0003_backfill_permission_local_setting', 'bd880375ba7b948c8bcda847e7eb52bc568d065bcba48190f6c3bfb14d11b7dc', '0.2.0', 1788449677872)
('0004_session_target', 'df670752991c78e38e2f25b0a003abc0e9689bc8d4894351358f2f83335a3ae1', '0.7.0', 1788449677872)
('0005_session_target_accounting', '6138ed4562dfdd5b571d39d3b62266c55dd9eb8f2f41948e046441a0e4a954cc', '0.7.0', 1788449677873)
('0006_input_history_attachments', 'a2eab98649d738e15bdae27de7c5c114713f7777c55aa4111b19e03ee5ced54f', '0.11.0', 1788449677874)
('0007_workflow_script_runtime', '0068fc4bcaffe4de4669442a62eee227726e0e8e81b61c7458213a20ac596009', '0.13.0', 1788449677875)
('0008_workflow_definition_scope', 'f7ee304e4005c291fb8883cfc180005263e6c6b2f94077487443f2c17a71d3eb', '0.13.0', 1788449677876)
('0009_session_title_metadata', '3855cf957177ae6319ae91866cdff59e946ca07a10b36b5b59689818bd13fe00', '0.14.0', 1788449677877)
('0010_usage_observability', '36918b0a98f465fe844097aa60c65ef73ea9c62cc266f02742bf3fc2cedf860b', '0.15.0', 1788449677878)
('0011_session_target_summary_title', '2b7723479426a4e7a1ed9901ed817495c1bbf63e9547eb1c63cd9e24bf9305f8', '0.15.0', 1788449677878)
('0012_session_trace_id', '9dcef90998dd00c8ed1b22a2170e180eb15471b93947e65ebe101d41e96bdb60', '0.15.0', 1788449677879)
('0013_session_target_active_run_accounting', '7ab185540ebb7d26c5403ca52a50de6cf161c79cb93ccd47ff1b43b87415fe1c', '0.15.0', 1788449677881)
('0014_message_part_sequence', '66b45c45e4d3a1a60829f193f38d865dcdbd3de2eb78aa79ba954fe7ef1aab08', '0.15.0', 1788449677883)
('0015_message_part_sequence_backfill_and_guard', 'da3046bf061ebb5ba253bb772f0fc9e4d1f2856dac4cdbc4cc0a65aae00e8511', '0.15.2', 1788449677883)
('0016_session_input_ledger', '18d51ae3f5e1425dc1e5c809282129fdc7430cacb6b1ce517b412ddbc34be790', '0.15.2', 1788449677884)
('0017_session_input_start_now_delivery', '8c2da5985ecdf342438a2df713c9e18114276a0e85ce6f2e4f79bdf1596b52f8', '0.15.2', 1788449677886)
('0018_session_input_failed_status', 'a4d1a7b7c5d4af426b695769ed0f3a031efac8aa7af1f6412a85292c42b5d15b', '0.15.2', 1788449677889)
```

### A.4 Migration DDL (verbatim from `f6t` array in zcode.cjs)

```js
f6t=[{appVersion:"0.2.0",id:"0001_base_session_store",sql:`
      create table if not exists session (
        id text primary key,
        project_id text not null,
        workspace_id text,
        parent_id text,
        slug text not null,
        directory text not null,
        path text,
        title text not null,
        version text not null,
        share_url text,
        summary_additions integer,
        summary_deletions integer,
        summary_files integer,
        summary_diffs text,
        revert text,
        permission text,
        time_created integer not null,
        time_updated integer not null,
        time_compacting integer,
        time_archived integer
      );

      create index if not exists session_project_idx on session(project_id);
      create index if not exists session_workspace_idx on session(workspace_id);
      create index if not exists session_parent_idx on session(parent_id);

      create table if not exists message (
        id text primary key,
        session_id text not null references session(id) on delete cascade,
        time_created integer not null,
        time_updated integer not null,
        data text not null
      );

      create index if not exists message_session_time_created_id_idx
        on message(session_id, time_created, id);

      create table if not exists part (
        id text primary key,
        message_id text not null references message(id) on delete cascade,
        session_id text not null,
        time_created integer not null,
        time_updated integer not null,
        data text not null
      );

      create index if not exists part_message_id_id_idx on part(message_id, id);
      create index if not exists part_session_idx on part(session_id);

      create table if not exists todo (
        session_id text not null references session(id) on delete cascade,
        content text not null,
        status text not null,
        priority text not null,
        position integer not null,
        time_created integer not null,
        time_updated integer not null,
        primary key(session_id, position)
      );

      create index if not exists todo_session_idx on todo(session_id);

      create table if not exists session_entry (
        id text primary key,
        session_id text not null references session(id) on delete cascade,
        type text not null,
        time_created integer not null,
        time_updated integer not null,
        data text not null
      );

      create index if not exists session_entry_session_idx on session_entry(session_id);
      create index if not exists session_entry_session_type_idx on session_entry(session_id, type);
      create index if not exists session_entry_time_created_idx on session_entry(time_created);

      create table if not exists permission (
        project_id text primary key,
        time_created integer not null,
        time_updated integer not null,
        data text not null
      );

      create table if not exists input_history (
        id text primary key,
        project_id text not null,
        session_id text,
        text text not null,
        kind text not null,
        time_created integer not null
      );

      create index if not exists input_history_project_time_idx
        on input_history(project_id, time_created desc, id desc);
      create index if not exists input_history_time_idx
        on input_history(time_created desc, id desc);
    `},{appVersion:"0.2.0",id:"0002_local_setting",sql:`
      create table if not exists local_setting (
        scope text not null,
        scope_id text not null,
        namespace text not null,
        key text not null,
        value text not null,
        schema_version integer not null,
        time_created integer not null,
        time_updated integer not null,
        primary key(scope, scope_id, namespace, key)
      );

      create index if not exists local_setting_scope_idx
        on local_setting(scope, scope_id);

      create index if not exists local_setting_namespace_key_idx
        on local_setting(namespace, key);
    `},{appVersion:"0.2.0",id:"0003_backfill_permission_local_setting",sql:`
      insert or ignore into local_setting (
        scope,
        scope_id,
        namespace,
        key,
        value,
        schema_version,
        time_created,
        time_updated
      )
      select
        'project',
        project_id,
        'permission',
        'ruleset',
        data,
        1,
        time_created,
        time_updated
      from permission
      where data is not null;
    `},{appVersion:"0.7.0",id:"0004_session_target",sql:`
      create table if not exists session_target (
        session_id text primary key references session(id) on delete cascade,
        target_id text not null,
        objective text not null,
        status text not null check(status in ('active', 'paused', 'complete')),
        time_created integer not null,
        time_updated integer not null
      );
    `},{appVersion:"0.7.0",id:"0005_session_target_accounting",sql:`
      create table if not exists session_target_next (
        session_id text primary key references session(id) on delete cascade,
        target_id text not null,
        objective text not null,
        status text not null check(status in ('active', 'paused', 'budget_limited', 'complete')),
        token_budget integer,
        tokens_used integer not null default 0,
        time_used_seconds integer not null default 0,
        time_created integer not null,
        time_updated integer not null
      );

      insert into session_target_next (
        session_id,
        target_id,
        objective,
        status,
        token_budget,
        tokens_used,
        time_used_seconds,
        time_created,
        time_updated
      )
      select
        session_id,
        target_id,
        objective,
        status,
        null,
        0,
        0,
        time_created,
        time_updated
      from session_target;

      drop table session_target;
      alter table session_target_next rename to session_target;
    `},{appVersion:"0.11.0",id:"0006_input_history_attachments",sql:`
      alter table input_history add column attachments text;
    `},{appVersion:"0.13.0",id:"0007_workflow_script_runtime",sql:`
      alter table session add column task_type text not null default 'interactive';

      create index if not exists session_task_type_idx on session(task_type);

      create table if not exists workflow_definition (
        id text primary key,
        name text not null,
        source text not null check(source in ('builtin', 'user')),
        trusted integer not null default 0 check(trusted in (0, 1)),
        enabled integer not null default 1 check(enabled in (0, 1)),
        script_path text,
        script_hash text not null,
        meta_json text not null,
        time_created integer not null,
        time_updated integer not null
      );

      create index if not exists workflow_definition_source_idx
        on workflow_definition(source, enabled);

      create table if not exists workflow_run (
        id text primary key,
        definition_id text,
        name text not null,
        kind text not null default 'script',
        parent_session_id text references session(id) on delete set null,
        cwd text not null,
        script_path text,
        script_hash text not null,
        args_json text,
        args_hash text,
        status text not null check(status in (
          'pending',
          'running',
          'paused',
          'completed',
          'failed',
          'cancelled'
        )),
        current_phase text,
        budget_total integer,
        budget_spent integer not null default 0,
        stats_json text,
        failure_json text,
        time_created integer not null,
        time_started integer,
        time_updated integer not null,
        time_completed integer
      );

      create index if not exists workflow_run_parent_session_idx
        on workflow_run(parent_session_id);
      create index if not exists workflow_run_cwd_status_idx
        on workflow_run(cwd, status, time_updated desc);
      create index if not exists workflow_run_definition_idx
        on workflow_run(definition_id);

      create table if not exists workflow_activity (
        id text primary key,
        run_id text not null references workflow_run(id) on delete cascade,
        parent_activity_id text,
        call_index integer not null,
        call_path text not null,
        attempt integer not null default 1,
        type text not null,
        phase text,
        label text,
        input_hash text not null,
        prompt text,
        opts_json text,
        status text not null check(status in (
          'queued',
          'running',
          'completed',
          'failed',
          'skipped',
          'cancelled',
          'cached',
          'lost'
        )),
        child_session_id text references session(id) on delete set null,
        result_json text,
        error_json text,
        time_created integer not null,
        time_started integer,
        time_updated integer not null,
        time_completed integer,
        unique(run_id, call_path, attempt)
      );

      create index if not exists workflow_activity_run_status_idx
        on workflow_activity(run_id, status, call_index);
      create index if not exists workflow_activity_child_session_idx
        on workflow_activity(child_session_id);

      create table if not exists workflow_event (
        id text primary key,
        run_id text not null references workflow_run(id) on delete cascade,
        sequence integer not null,
        type text not null,
        phase text,
        activity_id text references workflow_activity(id) on delete set null,
        payload_json text,
        time_created integer not null,
        unique(run_id, sequence)
      );

      create index if not exists workflow_event_run_sequence_idx
        on workflow_event(run_id, sequence);

      create table if not exists session_task_link (
        id text primary key,
        root_workflow_run_id text references workflow_run(id) on delete cascade,
        parent_link_id text references session_task_link(id) on delete cascade,
        activity_id text references workflow_activity(id) on delete set null,
        parent_session_id text references session(id) on delete set null,
        child_session_id text not null references session(id) on delete cascade,
        role text not null,
        depth integer not null default 0,
        path text not null,
        phase text,
        label text,
        agent_type text,
        model text,
        status text not null,
        time_created integer not null,
        time_updated integer not null,
        unique(child_session_id)
      );

      create index if not exists session_task_link_root_workflow_idx
        on session_task_link(root_workflow_run_id, depth, path);
      create index if not exists session_task_link_parent_idx
        on session_task_link(parent_link_id);
      create index if not exists session_task_link_activity_idx
        on session_task_link(activity_id);
    `},{appVersion:"0.13.0",id:"0008_workflow_definition_scope",sql:`
      alter table workflow_definition
        add column scope text not null default 'explicit'
        check(scope in ('builtin', 'explicit', 'project', 'user'));
    `},{appVersion:"0.14.0",id:"0009_session_title_metadata",sql:`
      alter table session
        add column title_source text not null default 'first_input'
        check(title_source in ('default', 'first_input', 'generated', 'custom'));

      alter table session
        add column title_message_id text;

      alter table session
        add column time_title_updated integer;
    `},{appVersion:"0.15.0",id:"0010_usage_observability",sql:`
      create table if not exists model_usage (
        id text primary key,
        logical_request_id text not null,
        attempt_index integer not null default 0,
        session_id text not null references session(id) on delete cascade,
        turn_id text,
        trace_id text,
        span_id text,
        assistant_message_id text,
        parent_user_message_id text,
        query_source text not null,
        provider_id text not null,
        model_id text not null,
        variant text,
        agent text,
        mode text,
        task_type text,
        status text not null check(status in ('running', 'completed', 'error', 'cancelled')),
        started_at integer not null,
        first_token_at integer,
        completed_at integer,
        duration_ms integer,
        time_to_first_token_ms integer,
        finish_reason text,
        tool_call_count integer not null default 0,
        input_tokens integer not null default 0,
        output_tokens integer not null default 0,
        reasoning_tokens integer not null default 0,
        cache_creation_input_tokens integer not null default 0,
        cache_read_input_tokens integer not null default 0,
        provider_total_tokens integer,
        computed_total_tokens integer not null default 0,
        retry_count integer not null default 0,
        retryable integer not null default 0 check(retryable in (0, 1)),
        cancelled_by_user integer not null default 0 check(cancelled_by_user in (0, 1)),
        context_exceeded integer not null default 0 check(context_exceeded in (0, 1)),
        error_type text,
        error_code text,
        error_message text,
        raw_usage_json text,
        provider_metadata_json text
      );

      create index if not exists model_usage_started_model_idx
        on model_usage(started_at, provider_id, model_id);
      create index if not exists model_usage_session_turn_idx
        on model_usage(session_id, turn_id);
      create index if not exists model_usage_trace_idx
        on model_usage(trace_id);
      create index if not exists model_usage_query_source_idx
        on model_usage(query_source);

      create table if not exists turn_usage (
        session_id text not null references session(id) on delete cascade,
        turn_id text not null,
        trace_id text,
        user_message_id text,
        status text not null check(status in ('running', 'completed', 'error', 'cancelled')),
        started_at integer not null,
        first_model_start_at integer,
        first_token_at integer,
        completed_at integer,
        duration_ms integer,
        time_to_first_token_ms integer,
        model_request_count integer not null default 0,
        model_retry_count integer not null default 0,
        tool_call_count integer not null default 0,
        tool_error_count integer not null default 0,
        input_tokens integer not null default 0,
        output_tokens integer not null default 0,
        reasoning_tokens integer not null default 0,
        cache_creation_input_tokens integer not null default 0,
        cache_read_input_tokens integer not null default 0,
        computed_total_tokens integer not null default 0,
        retryable integer not null default 0 check(retryable in (0, 1)),
        cancelled_by_user integer not null default 0 check(cancelled_by_user in (0, 1)),
        context_exceeded integer not null default 0 check(context_exceeded in (0, 1)),
        error_type text,
        error_code text,
        primary key(session_id, turn_id)
      );

      create index if not exists turn_usage_started_idx
        on turn_usage(started_at);

      create table if not exists tool_usage (
        id text primary key,
        session_id text not null references session(id) on delete cascade,
        turn_id text,
        trace_id text,
        tool_call_id text not null,
        tool_name text not null,
        side_effect_scope text,
        read_only integer check(read_only in (0, 1)),
        destructive integer check(destructive in (0, 1)),
        approval_status text,
        status text not null check(status in ('running', 'completed', 'error', 'cancelled')),
        started_at integer not null,
        first_output_at integer,
        completed_at integer,
        duration_ms integer,
        time_to_first_output_ms integer,
        exit_code integer,
        output_bytes integer not null default 0,
        stdout_bytes integer not null default 0,
        stderr_bytes integer not null default 0,
        truncated integer not null default 0 check(truncated in (0, 1)),
        retry_count integer not null default 0,
        retryable integer not null default 0 check(retryable in (0, 1)),
        cancelled_by_user integer not null default 0 check(cancelled_by_user in (0, 1)),
        error_type text,
        error_code text,
        error_message text
      );

      create unique index if not exists tool_usage_session_tool_call_idx
        on tool_usage(session_id, tool_call_id);
      create index if not exists tool_usage_started_tool_idx
        on tool_usage(started_at, tool_name);
      create index if not exists tool_usage_session_turn_idx
        on tool_usage(session_id, turn_id);
    `},{appVersion:"0.15.0",id:"0011_session_target_summary_title",sql:`
      alter table session_target add column summary_title text;
    `},{appVersion:"0.15.0",id:"0012_session_trace_id",sql:`
      alter table session add column trace_id text;

      create index if not exists session_trace_idx on session(trace_id);
    `},{appVersion:"0.15.0",id:"0013_session_target_active_run_accounting",sql:`
      alter table session_target add column active_input_id text;
      alter table session_target add column active_run_started_at integer;
      alter table session_target add column active_run_last_seen_at integer;
    `},{appVersion:"0.15.0",id:"0014_message_part_sequence",sql:`
      alter table message add column sequence integer;
      alter table part add column sequence integer;

      with ordered_message as (
        select
          id,
          row_number() over (
            partition by session_id
            order by time_created, rowid
          ) - 1 as stable_sequence
        from message
      )
      update message
      set sequence = (
        select stable_sequence
        from ordered_message
        where ordered_message.id = message.id
      )
      where sequence is null;

      with ordered_part as (
        select
          id,
          row_number() over (
            partition by message_id
            order by time_created, rowid
          ) - 1 as stable_sequence
        from part
      )
      update part
      set sequence = (
        select stable_sequence
        from ordered_part
        where ordered_part.id = part.id
      )
      where sequence is null;

      create index if not exists message_session_sequence_idx
        on message(session_id, sequence, time_created, id);

      create index if not exists part_message_sequence_idx
        on part(message_id, sequence, time_created, id);

      create index if not exists part_session_message_sequence_idx
        on part(session_id, message_id, sequence);
    `},{appVersion:"0.15.2",id:"0015_message_part_sequence_backfill_and_guard",sql:`
      with session_max as (
        select session_id, coalesce(max(sequence), -1) as max_sequence
        from message
        group by session_id
      ),
      ordered_null_message as (
        select
          m.id as id,
          sm.max_sequence + row_number() over (
            partition by m.session_id
            order by m.time_created, m.rowid
          ) as stable_sequence
        from message m
        join session_max sm on sm.session_id = m.session_id
        where m.sequence is null
      )
      update message
      set sequence = (
        select stable_sequence
        from ordered_null_message
        where ordered_null_message.id = message.id
      )
      where sequence is null;

      with message_max as (
        select message_id, coalesce(max(sequence), -1) as max_sequence
        from part
        group by message_id
      ),
      ordered_null_part as (
        select
          p.id as id,
          mm.max_sequence + row_number() over (
            partition by p.message_id
            order by p.time_created, p.rowid
          ) as stable_sequence
        from part p
        join message_max mm on mm.message_id = p.message_id
        where p.sequence is null
      )
      update part
      set sequence = (
        select stable_sequence
        from ordered_null_part
        where ordered_null_part.id = part.id
      )
      where sequence is null;

      create trigger if not exists message_sequence_autofill
      after insert on message
      when new.sequence is null
      begin
        update message
        set sequence = (
          select coalesce(max(sequence), -1) + 1
          from message
          where session_id = new.session_id
        )
        where id = new.id;
      end;

      create trigger if not exists part_sequence_autofill
      after insert on part
      when new.sequence is null
      begin
        update part
        set sequence = (
          select coalesce(max(sequence), -1) + 1
          from part
          where message_id = new.message_id
        )
        where id = new.id;
      end;
    `},{appVersion:"0.15.2",id:"0016_session_input_ledger",sql:`
      create table if not exists session_input (
        id text primary key,
        session_id text not null references session(id) on delete cascade,
        kind text not null,
        delivery text not null check(delivery in ('guide', 'queue')),
        payload text not null,
        admitted_sequence integer not null,
        promoted_sequence integer,
        promoted_message_id text,
        status text not null check(status in ('admitted', 'promoted', 'cancelled', 'discarded')),
        status_reason text,
        time_created integer not null,
        time_updated integer not null
      );

      create index if not exists session_input_session_admitted_idx
        on session_input(session_id, admitted_sequence);
      create index if not exists session_input_session_status_idx
        on session_input(session_id, status);
    `},{appVersion:"0.15.2",id:"0017_session_input_start_now_delivery",sql:`
      alter table session_input rename to session_input_before_start_now;

      create table session_input (
        id text primary key,
        session_id text not null references session(id) on delete cascade,
        kind text not null,
        delivery text not null check(delivery in ('startNow', 'guide', 'queue')),
        payload text not null,
        admitted_sequence integer not null,
        promoted_sequence integer,
        promoted_message_id text,
        status text not null check(status in ('admitted', 'promoted', 'cancelled', 'discarded')),
        status_reason text,
        time_created integer not null,
        time_updated integer not null
      );

      insert into session_input (
        id, session_id, kind, delivery, payload, admitted_sequence,
        promoted_sequence, promoted_message_id, status, status_reason,
        time_created, time_updated
      )
      select
        id, session_id, kind, delivery, payload, admitted_sequence,
        promoted_sequence, promoted_message_id, status, status_reason,
        time_created, time_updated
      from session_input_before_start_now;

      drop table session_input_before_start_now;

      create index session_input_session_admitted_idx
        on session_input(session_id, admitted_sequence);
      create index session_input_session_status_idx
        on session_input(session_id, status);
    `},{appVersion:"0.15.2",id:"0018_session_input_failed_status",sql:`
      alter table session_input rename to session_input_before_failed_status;

      create table session_input (
        id text primary key,
        session_id text not null references session(id) on delete cascade,
        kind text not null,
        delivery text not null check(delivery in ('startNow', 'guide', 'queue')),
        payload text not null,
        admitted_sequence integer not null,
        promoted_sequence integer,
        promoted_message_id text,
        status text not null check(status in ('admitted', 'promoted', 'cancelled', 'discarded', 'failed')),
        status_reason text,
        time_created integer not null,
        time_updated integer not null
      );

      insert into session_input (
        id, session_id, kind, delivery, payload, admitted_sequence,
        promoted_sequence, promoted_message_id, status, status_reason,
        time_created, time_updated
      )
      select
        id, session_id, kind, delivery, payload, admitted_sequence,
        promoted_sequence, promoted_message_id, status, status_reason,
        time_created, time_updated
      from session_input_before_failed_status;

      drop table session_input_before_failed_status;

      create index session_input_session_admitted_idx
        on session_input(session_id, admitted_sequence);
      create index session_input_session_status_idx
        on session_input(session_id, status);
    `}]});
```

### A.5 tasks-index.sqlite full schema

```sql
CREATE TABLE automation_runs (
        run_id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL,
        workspace_key TEXT NOT NULL,
        scheduled_at INTEGER,
        trigger TEXT NOT NULL DEFAULT 'schedule',
        dispatch_status TEXT NOT NULL DEFAULT 'claimed',
        outcome TEXT,
        session_id TEXT,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )

CREATE TABLE automations (
        automation_id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        cron_expr TEXT NOT NULL,
        prompt TEXT NOT NULL,
        model TEXT,
        provider TEXT,
        mode TEXT,
        thought_level TEXT,
        workspace_key TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        workspace_identity TEXT,
        target_task_id TEXT,
        bot_delivery_target TEXT,
        location_kind TEXT NOT NULL DEFAULT 'local',
        recurring INTEGER NOT NULL DEFAULT 1,
        max_runs INTEGER,
        end_at INTEGER,
        schedule_rule TEXT,
        schedule_edited_by_user INTEGER NOT NULL DEFAULT 0,
        run_count INTEGER NOT NULL DEFAULT 0,
        scheduled_run_count INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        lifecycle_status TEXT NOT NULL DEFAULT 'active',
        next_run_at INTEGER,
        last_run_at INTEGER,
        running INTEGER NOT NULL DEFAULT 0,
        claimed_at INTEGER,
        dispatch_status TEXT NOT NULL DEFAULT 'idle',
        dispatch_attempts INTEGER NOT NULL DEFAULT 0,
        retry_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )

CREATE TABLE off_peak_tasks (
        off_peak_task_id   TEXT PRIMARY KEY,
        server_ticket_id   TEXT,
        title              TEXT NOT NULL DEFAULT '',
        conversation_id    TEXT,
        session_id         TEXT,
        prompt             TEXT NOT NULL,
        permission_mode    TEXT NOT NULL,
        model              TEXT,
        thought_level      TEXT,
        workspace_key      TEXT NOT NULL,
        workspace_path     TEXT NOT NULL,
        workspace_identity TEXT,
        status             TEXT NOT NULL,
        queued_at          INTEGER NOT NULL,
        started_at         INTEGER,
        ended_at           INTEGER,
        failure_reason     TEXT,
        files_changed      INTEGER,
        settled_at         INTEGER,
        history_deleted_at INTEGER,
        registered_at      INTEGER,
        schedulable        INTEGER NOT NULL DEFAULT 0,
        queue_position     INTEGER,
        next_poll_at       INTEGER,
        claim_running      INTEGER NOT NULL DEFAULT 0,
        claimed_at         INTEGER,
        attempt_count      INTEGER NOT NULL DEFAULT 0,
        last_error         TEXT,
        created_at         INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL
      )

CREATE TABLE task_group_members (
        group_id TEXT NOT NULL,
        workspace_key TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        workspace_identity TEXT,
        task_id TEXT NOT NULL,
        sort_order INTEGER,
        added_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_key, task_id),
        FOREIGN KEY (group_id) REFERENCES task_groups(group_id) ON DELETE CASCADE
      )

CREATE TABLE task_group_view_node_orders (
        node_type TEXT NOT NULL,
        node_key TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (node_type, node_key)
      )

CREATE TABLE task_group_workspace_bootstraps (
        workspace_key TEXT PRIMARY KEY,
        group_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )

CREATE TABLE task_groups (
        group_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT 'gray',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )

CREATE TABLE tasks (
        workspace_key TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        workspace_identity TEXT,
        task_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        task_status TEXT,
        provider TEXT,
        mode TEXT NOT NULL DEFAULT 'build',
        model TEXT,
        migration_source TEXT,
        forked_from_task_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        unread_at INTEGER,
        last_unread_at INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        deleted INTEGER NOT NULL DEFAULT 0,
        title_overridden INTEGER NOT NULL DEFAULT 0,
        meta_json TEXT NOT NULL DEFAULT '{}', searchable_text TEXT NOT NULL DEFAULT '', cron_automation_id TEXT, off_peak_task_id TEXT,
        PRIMARY KEY (workspace_key, task_id)
      )

CREATE INDEX idx_automation_runs_by_automation
      ON automation_runs (automation_id, created_at DESC)

CREATE INDEX idx_automations_due
      ON automations (enabled, next_run_at)

CREATE INDEX idx_automations_retry
      ON automations (enabled, retry_at)

CREATE INDEX idx_automations_target_task
      ON automations (target_task_id)
      WHERE target_task_id IS NOT NULL

CREATE INDEX idx_automations_workspace
      ON automations (workspace_key)

CREATE INDEX idx_off_peak_pick
      ON off_peak_tasks (status, queued_at)

CREATE INDEX idx_off_peak_ws
      ON off_peak_tasks (workspace_key, status)

CREATE INDEX idx_task_group_members_group_order
      ON task_group_members (group_id, sort_order, added_at)

CREATE INDEX idx_task_group_view_node_orders_order
      ON task_group_view_node_orders (sort_order, created_at)

CREATE INDEX idx_tasks_cron_automation
      ON tasks (cron_automation_id, updated_at DESC)
      WHERE cron_automation_id IS NOT NULL AND deleted = 0

CREATE INDEX idx_tasks_off_peak_task
      ON tasks (off_peak_task_id, updated_at DESC)
      WHERE off_peak_task_id IS NOT NULL AND deleted = 0

CREATE INDEX idx_tasks_workspace_archived_updated
      ON tasks (workspace_key, archived, updated_at DESC)
      WHERE deleted = 0

CREATE INDEX idx_tasks_workspace_pinned_updated
      ON tasks (workspace_key, pinned, updated_at DESC)
      WHERE deleted = 0

```

