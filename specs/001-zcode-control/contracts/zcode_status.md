# Contract: `zcode_status`

**Purpose**: report the state of the server and of ZCode itself, without disturbing anything.
Replaces the requested `zcode.status`, `zcode.workspace.current`, and (partially) `zcode.editor.active`.

**Read-only.** Rating **A**.

## Actions

| Action | Arguments | Underlying interface | Returns |
|---|---|---|---|
| `runtimes` | — | local registry | `[{workspace_key, pid, uptime_ms, transport_state, version, pending_requests, buffered_notifications}]` |
| `workspace` | `workspace` | `workspace/readState` | the payload verbatim: `{modelCatalog, settings:{mode,model,permission,thoughtLevel}, slashCommands[], workspace}` |
| `sessions` | `workspace?`, `limit?≤200` | `session/list` | `sessions[]` (id, kind, status, mode, title, title_source, timestamps, workspace) |
| `probe` | `workspace?` | `zcode version`, `zcode doctor`, `session/list`, `mcp/list` | `{version, doctor, protocol:{name,version}, session_count, mcp:{connected, failed, total_tools}}` |
| `doctor` | `workspace?` | `zcode doctor` | raw stdout lines |
| `runs` | `limit?≤200` | local audit DB | recent `runs` rows |

```ts
zcode_status({ action: 'runtimes' })
zcode_status({ action: 'workspace', workspace: 'F:\\Github\\proj' })
zcode_status({ action: 'sessions',  workspace: 'F:\\Github\\proj', limit: 50 })
zcode_status({ action: 'probe' })
zcode_status({ action: 'runs', limit: 20 })
```

## Arguments

- `workspace` — absolute path, or a `workspaceKey` previously returned by ZCode. **Never synthesised.**
  If omitted, `ZCODE_MCP_WORKSPACE` is used; if that is unset, the action fails.

## Failure modes

| Condition | Result |
|---|---|
| Runtime not discovered | `ok:false`, error names `ZCODE_MCP_CLI` and the discovery order tried |
| No workspace and no default | `ok:false`, `errors:['workspace is required']` |
| `-32602` from a drifted schema | `ok:false`, `impact:'unreliable'` — the schema is the contract |
| Registry empty | `ok:true` with `result:[]` (a legitimately idle server, not an error) |

## Evidence and read-back

Read-only; no read-back required. `evidence.payload_source` distinguishes `protocol` from
`filesystem` (`runs`, `doctor`).

## Permissions

None. Starts no turn, mutates nothing, spawns a runtime only if one does not already exist for that
workspace and the action needs one (`workspace`, `sessions`, `probe`).

## Notes

- `probe` is the intended first call for diagnostics: it establishes runtime identity, protocol
  version and MCP health in one round trip.
- `mcp.list` inside `probe` has the side effect documented in `zcode_mcp.md`.
