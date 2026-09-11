# Contract: `zcode_conversation`

**Purpose**: read a conversation's history, live events, plans and usage.
Replaces part of `zcode.agent.state` and `zcode.diagnostics.list`.

**Read-only.** Rating **B** (guarded by version tokens).

## Actions

| Action | Arguments | Underlying interface |
|---|---|---|
| `rows` | `session_id`, `before_row_id?`, `limit?≤200` | `v4/conversation/rowsRange` |
| `messages` | `session_id` | `session/messages` |
| `events` | `session_id`, `limit?≤2000` | `session/events` |
| `plans` | `session_id`, `row_id?` | `v4/conversation/plans` |
| `usage` | `session_id` | `v4/conversation/usage` |

## Version-token protocol (the whole point of this contract)

`rows`, `plans` — and the `zcode_files` actions — require `log_epoch` and `revision`. The tool obtains
them itself and:

1. reads the current tokens,
2. issues the request,
3. on `proto.staleLogEpoch` or `proto.staleRevision` **re-reads the tokens and retries once**,
4. if it is still stale, returns `ok:false` with
   `warnings:[{code:'stale_after_retry', impact:'degraded'}]` and **both** the stale and current tokens.

The result always echoes the tokens it was read at:

```ts
{ rows: [...], log_epoch: string, revision: number, truncated: boolean }
```

**Invariant**: row identifiers MUST NOT be cached across a `logEpoch` change. Compaction and fork both
change it. A caller holding a `rowId` across an epoch change will get a stale-row error from ZCode;
that error is passed through, not hidden.

## Argument constraints

- `limit` default 60 (the snapshot tail window), maximum 200 (`rowsRangeMaxLimit`).
- `before_row_id` pages backwards; it must come from the same epoch.

## Failure modes

| Condition | Result |
|---|---|
| `proto.staleLogEpoch` / `proto.staleRevision` | one automatic retry, then `ok:false` degraded |
| `-32004` | `ok:false`, session unavailable |
| `row_id` unknown in the current epoch | `ok:false`, ZCode's reason code verbatim |
| `events` limit above 2000 | clamped to 2000 with `warnings:[{code:'limit_clamped', impact:'advisory'}]` |

## Permissions

None. Reads only.

## Notes

- `events` reads the buffered notification ring for the session (bound 2000, matching ZCode's own
  `eventRetentionPerSession`). It is a *recent* view, not a full history; for durable history use
  `rows`/`messages`.
- `state.updated` notifications carry the session projection; a caller wanting "what is happening now"
  should prefer `zcode_status workspace` or `zcode_session get` over replaying events.
