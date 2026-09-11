# Contract: `zcode_chat` ★

**Purpose**: submit work to the ZCode agent and follow it to a terminal state.
Replaces the requested `zcode.agent.chat`, `zcode.agent.cancel`.
This is the P1 journey and the reason the server exists.

**Mutating.** Rating **A**. Governing requirement: **FR-012 — admission is not completion.**

## Actions

| Action | Arguments | Underlying interface |
|---|---|---|
| `send` | `session_id`, `text`, `attachments?[]`, `delivery?`, `tool_allowlist?[]`, `tool_denylist?[]`, `idempotency_key?`, `collect?`, `wait?`, `wait_timeout_ms?` | `v4/command` (`type:"sendText"`) + `session/event` subscription |
| `steer` | `session_id`, `text` | `v4/command` with `delivery.requested = "guide"` |
| `stop` | `session_id` | `session/stop` (queue-bypassing) |
| `cancel_background` | `session_id`, `task_id` | `session/cancelBackgroundTask` |
| `wait` | `session_id`, `until?`, `timeout_ms?`, `collect?` | `session/read` + `session/event` |

```ts
zcode_chat({ action: 'send', session_id: 'sess_…', text: 'fix the failing test',
             tool_allowlist: ['Read','Edit','Bash'], idempotency_key: 'ticket-4821' })
zcode_chat({ action: 'stop', session_id: 'sess_…' })
```

### Argument details

- `attachments`: `{path?, ref?, mime?, name?}[]`. A local `path` is uploaded by this server through
  `v4/attachment/begin → chunk (≤512 KiB) → commit`; the resulting `ref` is placed in the payload.
  This keeps the call inside the 1 MiB protocol frame limit.
- `delivery ∈ {auto, startNow, queue, guide}` (default `auto`). `guide` steers a running turn.
- `tool_allowlist` / `tool_denylist`: per-turn tool restriction, passed as `toolAllowlist` /
  `toolDisallowlist`. This is how a caller gets a *narrow* agent — e.g. `['Read']` for a
  reconnaissance turn that cannot modify anything.
- `idempotency_key`: **required for safe retries.** The command id is derived from
  `(sessionId, hash(text), idempotency_key)`. The agent keys idempotency on it for 24 h
  (`commandPendingTtlMs`), with 512 entries per session. A retry with the same key does not start a
  second turn; a retry with a different key does.
- `collect ∈ {final, text, events, none}` (default `final`). `final` assembles the assistant text from
  `part.*` events for the turn and summarises tool calls.
- `wait` (default `true`), `wait_timeout_ms` (default 600 000).

## Output (`collect:'final'`)

```ts
{
  status: 'accepted' | 'noop' | 'failed',   // verbatim from v4/command
  reason_code?: string,                      // verbatim
  turn: { turn_id, turn_number, outcome: 'completed' | 'failed', duration_ms,
          tool_calls: { total, completed, failed, denied } },
  text: string,                              // assembled assistant text for the turn
  events: number,                            // notifications consumed
  usage?: { input_tokens, output_tokens, reasoning_tokens, cache_read_tokens },
  artifacts: string[],                       // paths resolved from tool results, if any
  steering: { queued: number, drained: number }
}
```

## The success rule (the core of this contract)

| Observation | `ok` | `warnings[]` |
|---|---|---|
| terminal `turn.completed` seen | `true` | — |
| terminal `turn.failed` seen | `false` | `errors[0]` = the agent's error model |
| `status:'noop'` | `false` | `errors[0]` = reason code. **Noop is not success.** |
| `status:'failed'` | `false` | `errors[0]` = reason code (`fault.command.notImplemented`, `fault.command.executionFailed`, `proto.payloadTooLarge`) |
| `status:'accepted'` but wait timed out before any terminal event | `true` | `{code:'no_terminal_event', impact:'degraded', detail:'admitted but no terminal turn event observed within <ms>'}` |
| `wait:false` | `true` | `{code:'not_awaited', impact:'degraded'}` — the caller opted out |
| terminal event for a **different** turn than the one submitted | `false` | `{code:'event_turn_mismatch', impact:'unreliable'}` |

The last two rows are the ones that keep this server honest: an accepted-but-unobserved command is
reported as incomplete, never as done.

## Failure modes

| Condition | Result |
|---|---|
| Approval request outstanding and policy is `ask`, never resolved | turn parks; `collect:'final'` returns degraded with the pending request ids so the caller can resolve them via `zcode_approval` |
| Approval denied under default policy | turn continues or fails; denied tool calls appear in `tool_calls.denied`; `ok` follows the terminal outcome |
| Attachment over 20 MiB or >64 chunks | `ok:false` before the command is admitted |
| `text` + attachments project over 16 MiB | `ok:false`, `proto.payloadTooLarge` |
| `session_id` from another workspace | `ok:false`, `-32004` |
| `stop` on an idle session | `ok:true`, `warnings:[{code:'already_idle', impact:'advisory'}]` |
| Duplicate submission with the same `idempotency_key` | `ok:true`, `warnings:[{code:'idempotent_replay', impact:'advisory'}]`, one turn |

## Permissions

This is the tool that spends tokens and can modify the repository. Its authority comes from the
session's `mode` (set by `zcode_session set_mode`) and from the per-call tool allow/deny lists.
The server's own approval policy governs anything the agent asks permission for.
`tool_allowlist:['Read']` is the documented way to make a turn guaranteed non-mutating.

## Notes

- Streaming deltas are coalesced by ZCode host-side (~1500 ms), so `collect:'events'` yields batched
  deltas, not per-token frames. This is expected, not a bug.
- The tool subscribes before sending, so no early events are lost.
- `stop` bypasses the agent's serial processing queue by design, so it works even while the agent is
  busy.
