# Contract: `zcode_session`

**Purpose**: session lifecycle and per-session settings. Replaces the requested `zcode.workspace.list`,
`zcode.agent.list`, `zcode.agent.state`, `zcode.session.*`.

**Mutating actions require a read-back.** Rating **A**.

## Actions

| Action | Arguments | Underlying interface | Read-back |
|---|---|---|---|
| `list` | `workspace?`, `limit?≤200` | `session/list` | — (read) |
| `get` | `session_id` | `session/read` | — (read) |
| `create` | `workspace` (req), `mode?`, `model?`, `thought_level?`, `mcp_servers?[]`, `title_generation?`, `persistence?` | `session/create` | `session/read` |
| `resume` | `session_id`, `model?`, `thought_level?` | `session/resume` | `session/read` |
| `close` | `session_id` | `session/close` | `session/list` (absent) |
| `fork` | `session_id`, `checkpoint_id?` | `session/fork` | `session/read` on the new id |
| `compact` | `session_id`, `instructions?` | `session/compact` | `session/read` |
| `set_model` | `session_id`, `model` | `session/setModel` | `session/read` → asserts model |
| `set_mode` | `session_id`, `mode` | `session/setMode` | `session/read` → asserts mode |
| `set_thought_level` | `session_id`, `thought_level` | `session/setThoughtLevel` | `session/read` → asserts level |
| `goal` | `session_id`, `goal_action: show\|set\|pause\|resume\|clear`, `objective?` | `session/goal` | `session/read` → projection.target |
| `subagents` | `session_id` | `session/subagents` | — (read) |
| `usage` | `session_id` | `session/usage` | — (read) |

```ts
zcode_session({ action: 'create', workspace: 'F:\\Github\\proj', mode: 'edit' })
zcode_session({ action: 'set_model', session_id: 'sess_…', model: 'builtin:zai/GLM-5.3' })
zcode_session({ action: 'goal', session_id: 'sess_…', goal_action: 'set',
                objective: 'fix the failing build' })
```

## Argument constraints

- `mode ∈ {plan, build, edit, yolo, auto}`; `thought_level` is a provider-declared variant
  (`low`/`max`/`high` observed) and is validated by ZCode, not by us.
- `model` must exist in the workspace's provider registry. If ZCode rejects reuse of a removed model
  it surfaces as `impact:'unreliable'`, because the model catalogue may have changed under us.
- `mcp_servers` restricts the session to named servers.

## Failure modes

| Condition | Result |
|---|---|
| Unknown `session_id` | `ok:false`, `-32004 sessionUnavailable` |
| Model not in registry | `ok:false`, `impact:'unreliable'`, ZCode's message verbatim |
| Invalid `mode`/`thought_level` | `ok:false`, `-32602` path-qualified |
| `set_*` accepted but read-back differs | `ok:false`, `errors:['read-back mismatch: requested X, observed Y']` — **never `ok:true`** |
| `create` without a resolvable `workspace` | `ok:false` before any spawn |

## Read-back rule (Constitution Article II)

For every mutating action the tool re-issues `session/read` and compares the specific field it
changed. A mismatch is a **failure**, not a warning. This is what makes `set_model` trustworthy when
the provider registry is being mutated concurrently by the desktop.

## Permissions

`close`, `fork`, `compact`, `goal` and `set_*` change agent behaviour but touch no files and spend no
tokens. They do not require the approval policy. `fork` and `compact` are the only ones that can
invalidate conversation row identifiers — callers are told the new `logEpoch` in the result.

## Notes

- `create` returns the new `sessionId` **and** the `workspaceKey` echo; callers should use that key for
  subsequent calls rather than re-deriving it.
- `close` on an already-closed session is idempotent and reports the observed absence.
