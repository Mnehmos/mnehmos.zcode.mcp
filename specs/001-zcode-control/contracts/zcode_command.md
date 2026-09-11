# Contract: `zcode_command`

**Purpose**: resolve and execute ZCode's own command surface.
Replaces the requested `zcode.command.list` and `zcode.command.execute`.

**Mutating** for `execute`. Rating **A** for `query`/`catalog`, **A** for `execute` with the
admission caveat.

## Actions

| Action | Arguments | Underlying interface |
|---|---|---|
| `catalog` | — | local: protocol method catalog + slash-command list |
| `query` | `commands: [{command_id, session_id?}], session_id?` | `v4/commands/query` |
| `execute` | `session_id?`, `envelope: {command_id, type, payload}` | `v4/command` |

```ts
zcode_command({ action: 'catalog' })
zcode_command({ action: 'query', commands: [{ command_id: 'cmd_…', session_id: 'sess_…' }] })
zcode_command({ action: 'execute', session_id: 'sess_…',
                envelope: { command_id: 'cmd_…', type: 'sendText', payload: { text: 'hi' } } })
```

## Argument constraints

- `commands` must contain **at least one** entry (CONFIRMED: the runtime rejects an empty array with
  `too_small minimum 1`), and every entry must carry a **string `command_id`** (CONFIRMED: `-32603`
  `path:["commands",0,"commandId"]` when absent). Maximum 32 entries — matching the runtime's own
  pending-command display cap.
- `envelope.type ∈ {createSession, sendText, sendGoalCommand, compact}`.
- `envelope.command_id` must be stable across retries for idempotency.

## The honesty rule for `execute`

`v4/command` returns **admission**, not completion:

```ts
{ status: 'accepted', result?: unknown }
{ status: 'noop',     reasonCode: string }
{ status: 'failed',   reasonCode: 'fault.command.notImplemented'
                              | 'fault.command.executionFailed'
                              | 'proto.payloadTooLarge', message: string }
```

This tool returns that object **verbatim** in `result` and sets `ok` as follows:

| `status` | `ok` | Note |
|---|---|---|
| `accepted` | `true` | with `warnings:[{code:'admission_only', impact:'degraded', detail:'submitted but not awaited; use zcode_chat for turn completion'}]` |
| `noop` | `false` | reason code verbatim |
| `failed` | `false` | reason code verbatim |

`zcode_chat` is the correct tool when the caller wants to know the *outcome*. `zcode_command execute`
is for callers deliberately working at the admission layer, or exercising command types not yet
covered by a typed tool.

## Failure modes

| Condition | Result |
|---|---|
| Empty `commands` array | `ok:false` before send (schema-level) |
| Missing `command_id` | `ok:false` before send |
| `-32602` from the runtime | `ok:false`, `impact:'unreliable'` — the envelope shape drifted; surface it |
| `noop` | `ok:false`, reason code verbatim |
| `proto.payloadTooLarge` | `ok:false` with guidance to use the attachment path |

## Permissions

`execute` with `type:'sendText'` starts model work; with `createSession` it allocates a session.
`catalog` and `query` are read-only.

## Notes

- `catalog` returns the protocol method catalog (66 methods) annotated `read_only` / `mutating`, plus
  the workspace's slash commands and the CLI slash commands. It is the discovery surface for callers
  that want to go beyond the typed tools without enabling the raw passthrough.
- `query` is a lookup of *specific* commands by id (its input is a list of command descriptors, not a
  filter), so it is not a "list all commands" call.
