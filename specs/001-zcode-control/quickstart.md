# Quickstart: ZCode MCP control

**Phase 1 output** for `specs/001-zcode-control`.
Goal: from clone to a successful call against a real ZCode installation, with no prior knowledge of
ZCode's internals.

---

## 0. Prerequisites

| Requirement | How to check | Notes |
|---|---|---|
| ZCode installed | `ls "E:/zcode/resources/glm/zcode.cjs"` | Any path works; discovery is configurable |
| Node 22+ | `node --version` | The runtime is a Node bundle and must be launched **as** `node <bundle>` |
| A model provider | `node "E:/zcode/resources/glm/zcode.cjs" doctor` | `doctor` reports the resolved artifact |
| An API key | — | Supplied by environment; never written to disk |

> The runtime must be spawned as `node <zcode.cjs>` — executing the `.cjs` directly fails with
> `EFTYPE` (CONFIRMED).

---

## 1. Discover the runtime

```sh
node "E:/zcode/resources/glm/zcode.cjs" version      # → 0.16.5
node "E:/zcode/resources/glm/zcode.cjs" doctor       # → process: zcode-cli, node, platform
```

Discovery order used by the MCP (first hit wins):

1. `ZCODE_MCP_CLI`
2. `<install>/resources/glm/zcode.cjs`
3. `$GLM_BINARY_PATH` (ZCode's own override variable)
4. `~/.zcode/server/agents/glm/zcode.cjs`
5. `<install>/resources/glm/zcode-agent(.exe)`
6. bundled-resource search paths

---

## 2. Prove the transport (no MCP client needed)

This is the single most important smoke test. It is what the whole design rests on.

```sh
printf '{"id":1,"method":"session/list","params":{}}\n' \
  | node "E:/zcode/resources/glm/zcode.cjs" app-server --stdio --cwd "."
```

Expected: one line of NDJSON on stdout, beginning `{"id":1,"result":{"sessions":[...]}}`.
With an unknown method you get the error envelope instead:

```sh
printf '{"id":1,"method":"bogus/method","params":{}}\n' \
  | node "E:/zcode/resources/glm/zcode.cjs" app-server --stdio
# → {"error":{"code":-32601,"message":"Method not found: bogus/method"},"id":1}
```

If that works, the control plane is real. Everything below is plumbing.

---

## 3. Provision a model provider

A bare runtime has **no** credentials and reports
`model: {current: {modelId: "missing-model", providerId: "zcode-unconfigured"}}`.

The fix is **three environment variables** — no file, no editing ZCode's config:

```sh
export ZCODE_MODEL="<model>"                 # or "<provider>/<model>"
export ZCODE_BASE_URL="https://api.example.com/v1"   # see the hazard below
export ZCODE_API_KEY="..."                   # or ANTHROPIC_API_KEY / <PROVIDER>_API_KEY
```

The agent reads these as a config layer at priority 40 (`parseEnvConfig`), which outranks both the
project and user config files.

Verify it took effect — the sentinel must be gone:

```sh
printf '{"id":1,"method":"workspace/readState","params":{"workspace":{"workspacePath":"%s","workspaceKey":"%s"}}}
' "$PWD" "$PWD"   | node "<install>/resources/glm/zcode.cjs" app-server --stdio | head -c 400
```

Success looks like `model.current.modelId` being your model (not `missing-model`) and a **non-empty**
`modelCatalog.available`.

### Two things to know

⚠ **`ZCODE_BASE_URL` is dual-purpose.** The same variable is read by ZCode's endpoint resolver as the
control-plane origin (OAuth, plan, telemetry) *and* by the model-config parser as the model base URL.
For a local agent runtime the control-plane origin is unused, so this is safe in practice — but do not
point it at an endpoint you would not also accept as the API origin.

⚠ **This path pins the provider kind to `anthropic`.** A genuinely `openai-compatible` provider cannot
be expressed this way. If you need one, configure it yourself in `~/.zcode/cli/config.json` — see
`ZCODE_UNKNOWNS.md` U-3 for the shape and the caveat that a minimal block was rejected in testing.

## 4. Build and verify

```sh
npm install
npm run build
npm run smoke          # node dist/index.js --self-test
npm test               # typecheck + unit tests
ZCODE_MCP_IT=1 npm test   # opt-in: spawns the real runtime
```

At the time of writing nothing is implemented yet — `tasks.md` is the build order. The quickstart is
written first because it is the acceptance test for the whole project (spec SC-010).

---

## 5. First calls, in order

Each step is a checkpoint. Do not proceed past a failing step.

### Step 1 — identity and health

```jsonc
{ "tool": "zcode_status", "arguments": { "action": "probe" } }
```
Expect `ok:true`, `result.version` = the runtime version, `result.protocol` =
`{"name":"ZCode Protocol","version":1}`, and a session count.

### Step 2 — read-only inspection (proves nothing was disturbed)

```jsonc
{ "tool": "zcode_session", "arguments": { "action": "list", "limit": 10 } }
{ "tool": "zcode_usage",   "arguments": { "action": "stats", "range": "7d" } }
{ "tool": "zcode_mcp",     "arguments": { "action": "servers" } }   // config only — starts nothing
```
Expect real sessions, real token figures, and a server list. No turn has run.

### Step 3 — a non-mutating turn (the P1 acceptance test)

```jsonc
{ "tool": "zcode_chat",
  "arguments": {
    "action": "send",
    "session_id": "sess_…",
    "text": "List the top-level files and summarise the project in two sentences.",
    "tool_allowlist": ["Read", "Glob", "Grep"],
    "idempotency_key": "quickstart-1"
  } }
```
Expect `ok:true`, `result.turn.outcome === "completed"`, non-empty `result.text`, and
`result.turn.tool_calls.denied === 0`. `tool_allowlist` here makes the turn *incapable* of writing —
this is the safest possible first real call.

### Step 4 — prove the honesty rule

```jsonc
{ "tool": "zcode_chat",
  "arguments": { "action": "send", "session_id": "sess_…",
                 "text": "reply with OK", "wait": false } }
```
Expect `ok:true` **with** `warnings[0].code === "not_awaited"` and
`impact === "degraded"`. The server must not claim a result it did not observe. If this returns a
clean `ok:true`, Article II is not implemented.

### Step 5 — prove the authority boundary

Set `ZCODE_MCP_APPROVAL=deny` (the default) and run a turn that tries to write under
`tool_allowlist: ["Write"]`. Expect the write to be denied, `result.turn.tool_calls.denied >= 1`, and
— verified by hashing the target file before and after — **no modification**.

### Step 6 — prove no orphans

```sh
# after the suite finishes
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" |
  Where-Object { $_.CommandLine -like '*app-server*' }"
```
Expect an empty result. Any output is a Constitution Article VI violation.

---

## 6. Configuration reference

| Variable | Default | Purpose |
|---|---|---|
| `ZCODE_MCP_CLI` | auto-discovered | runtime bundle path |
| `ZCODE_MCP_NODE` | `process.execPath` | node used to launch the runtime |
| `ZCODE_MCP_WORKSPACE` | — | default workspace when a call omits one |
| `ZCODE_MCP_WORK_DIR` | `./work` | wire logs, stdout/stderr, reports |
| `ZCODE_MCP_DB` | `./data/audit.db` | provenance database |
| `ZCODE_MCP_TIMEOUT_MS` | 180000 | per-request protocol timeout |
| `ZCODE_MCP_STARTUP_MS` | 30000 | cold-start grace before declaring failure |
| `ZCODE_MCP_CHILD_IDLE_MS` | 900000 | idle eviction |
| `ZCODE_MCP_MAX_CHILDREN` | 2 | concurrent runtimes |
| `ZCODE_MCP_EVENT_BUFFER` | 2000 | notifications retained per session |
| `ZCODE_MCP_APPROVAL` | `deny` | `deny` \| `allow` \| `ask` |
| `ZCODE_MCP_APPROVAL_ALLOWLIST` | — | path to allow patterns |
| `ZCODE_MCP_DEFAULT_MODE` | `edit` | session mode when a call does not specify one |
| `ZCODE_MCP_TOOL_BUDGET` | 88 | warning threshold for registered tools |
| `ZCODE_MCP_REDACT` | `1` | secret scrubbing |
| `ZCODE_MCP_DISABLE_PROTOCOL` | — | kill switch for the raw passthrough |
| `ZCODE_MCP_PROTOCOL_ALLOW` | read-only set | method allowlist for the passthrough |
| `ZCODE_MCP_ALLOW_PROVIDER_EDIT` | — | gate for provider mutations |
| `ZCODE_MCP_ALLOW_PLUGIN_INSTALL` | — | gate for plugin install/update/uninstall |
| `ZCODE_MCP_ALLOW_MCP_CONFIG_EDIT` | — | gate for adding/removing MCP servers |
| `ZCODE_MCP_ALLOW_PERSIST_RULES` | — | gate for durable permission rules |

Client registration (example):

```jsonc
{
  "mcpServers": {
    "zcode": {
      "command": "node",
      "args": ["F:/Github/mcp/mnehmos.zcode.mcp/dist/index.js"],
      "env": { "ZCODE_MCP_WORKSPACE": "F:/Github/proj", "ZCODE_API_KEY": "…" }
    }
  }
}
```

> **Tool budget**: if you register this server *inside ZCode itself*, its 14 tools count against the
> model's accepted budget (GLM rejects above ~89–94 registered tools with `[1210] Invalid API
> parameter`). Register it in a different client, or keep the plugin profile trimmed.

---

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `spawn EFTYPE` | executed the `.cjs` directly | spawn `node <path>` |
| `Error: Model config is missing.` | no provider configured | §3 above |
| `Unknown option '--settings'` | that flag is advertised but not parsed | do not emit it; see `contracts/zcode_headless.md` |
| `modelId: "missing-model"` | provider config not picked up | check the config source ordering (project beats user) and the key env var |
| Tools hang, session status `waiting` | an unanswered `interaction/*` request | check `zcode_approval list`; the policy module should have answered |
| `proto.payloadTooLarge` | payload over 16 MiB | use the attachment path |
| Frame refused at 1 MiB | inline payload too large | attachments; the limit is ZCode's, not ours |
| `mcp/list` spawned processes | documented side effect | use `zcode_mcp servers` for config-only |
| Settings change had no effect | desktop settings are read at startup | restart ZCode |
| `[1210] Invalid API parameter` | too many registered tools | trim the plugin/MCP profile |
