# Contract: `zcode_mcp`

**Purpose**: inspect and manage ZCode's MCP client surface (ZCode as a *consumer* of MCP servers).

Rating **A** for reads; **B** for config edits (gated).

## Actions

| Action | Arguments | Underlying interface |
|---|---|---|
| `list` | `workspace` (req) | `mcp/list` |
| `status` | `workspace`, `server` | `mcp/list` filtered |
| `servers` | `scope?: agent\|desktop` | `~/.zcode/cli/config.json` (agent) / desktop config |
| `add_server` 🔒 | `name`, `spec: {command, args?, env?}` | config file write |
| `remove_server` 🔒 | `name` | config file write |

🔒 = requires `ZCODE_MCP_ALLOW_MCP_CONFIG_EDIT=1`.

## ⚠ Documented side effect

**Calling `list` or `status` starts the configured MCP servers.** CONFIRMED during the audit: the call
emits `process/mcpTelemetry {kind:"process_start", mcpId, mcpInstanceId, mcpIsolation, mcpSource}` for
each server. The envelope therefore:

- sets `evidence.mode: 'child'`,
- adds `warnings:[{code:'processes_started', impact:'advisory',
   detail:'N MCP server processes were started by this call'}]`,
- returns the spawned `mcp_instance_id`s in `result.started[]`.

A caller that only wants the *configuration* should use `servers`, which reads the config file and
starts nothing.

## Output for `list`

```ts
{
  statuses: {
    [key: string]: {                    // bare name, or "plugin:<pluginId>:<serverName>"
      status: 'connected' | 'failed';
      transport: 'stdio' | 'http' | 'sse';
      toolCount: number;
      updatedAt: string;                // ISO
      error?: string;
      failureKind?: 'network_unreachable' | 'process_start_failed';
      protocolEra?: string;             // "legacy" observed for every connected server
    }
  },
  started: string[];                     // mcpInstanceIds spawned by this call
  total_tools: number;
}
```

Real observed values (for calibration): comfyui 4, remcp 28, aseprite 5, blender 10, unreal 12; two
plugin servers failed with `network_unreachable` and `process_start_failed`.

## Failure modes

| Condition | Result |
|---|---|
| Missing `workspace` | `ok:false`, `-32602` |
| A server fails to start | `ok:true` with that entry `status:'failed'` and its `failureKind` — **a failing server is data, not a tool failure** |
| All servers fail | `ok:true`, `warnings:[{code:'all_servers_failed', impact:'degraded'}]` |
| Config edit without opt-in | `ok:false`, `reasonCode:'mcp.mcp_config_edit.disabled'` |
| Config edit with invalid `spec` | `ok:false` before write |

## Config edit safety

1. Read `~/.zcode/cli/config.json`, record its hash.
2. Write a timestamped backup `config.json.bak-<ts>` — the same convention ZCode itself uses.
3. Apply **only** the `mcp.servers.<name>` subtree; preserve `plugins` and every other key untouched.
4. Re-read and report the observed entry.
5. Emit `warnings:[{code:'restart_required', impact:'advisory',
   detail:'the agent reads MCP config at startup; restart the runtime or start a new session'}]`.

## Permissions

Adding an MCP server causes ZCode's agent to execute an arbitrary command. Hence the opt-in. The tool
never writes outside `mcp.servers`.

## Notes

- Tool names contributed by these servers appear to the model as `mcp__<server>__<tool>`.
- Servers are pooled inside the agent with per-session and per-workspace isolation and lease-based
  concurrency, so a server can be simultaneously connected for several sessions.
- The tool-count contribution from this tool's output feeds the budget warning in `zcode_plugins`.
