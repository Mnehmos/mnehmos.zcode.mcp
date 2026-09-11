# Contract: `zcode_files`

**Purpose**: inspect what a turn changed, preview a rewind, and move attachments.
Replaces the requested `zcode.diff.list` (partially), `zcode.diff.accept` (as a fork),
`zcode.diff.reject`, `zcode.file.read` (as attachment read).

**Read-only** except `rewind_apply`, which is explicitly confirmed. Rating **B**.

## Actions

| Action | Arguments | Underlying interface | Mutates? |
|---|---|---|---|
| `changes` | `session_id`, `row_id` | `v4/conversation/fileChanges` | no |
| `rewind_preview` | `session_id`, `row_id` | `v4/conversation/fileRewindPreview` | no |
| `rewind_apply` | `session_id`, `checkpoint_id?`, `confirm: true` | `session/fork` (safe) or confirmed rewind | **yes** |
| `read_attachment` | `session_id`, `ref`, `mime?`, `max_bytes?≤31457280`, `message_id?`, `attachment_index?` | `v4/attachment/read` | no |
| `put_attachment` | `path`, `session_id?` | `v4/attachment/begin\|chunk\|commit` | no (stages) |

## Non-capabilities (declared, not hidden)

CONFIRMED by the reverse-engineering audit: **ZCode has no editor document service.** There is no
protocol method for reading or writing a file as the editor sees it, no "active editor", no selection,
and no document-tab model. This is a deliberate architectural fact, not a gap in this server.

Consequently:

| Requested capability | Status | Substitute |
|---|---|---|
| `zcode.file.read` (as the editor) | **not buildable** | `read_attachment` for conversation attachments; otherwise have the agent read it via a turn with `tool_allowlist:['Read']` |
| `zcode.file.create` / `.edit` / `.save` | **not buildable as a document op** | `zcode_chat send` with `tool_allowlist:['Write'\|'Edit'\|'ApplyPatch']` |
| `zcode.editor.active` / `.selection` / `.replace_selection` | **not buildable** | `zcode_status sessions` for "which sessions are running where"; `changes` for "what did this turn touch" |
| `zcode.diff.accept` | partial | `rewind_apply` (fork) is the safe form |
| `zcode.diff.reject` | partial | not doing the edit in the first place, or `rewind_apply` to a prior checkpoint |
| `zcode.command.list` | elsewhere | see `zcode_command.md` |

**Why this is the right call**: only the agent's own `Write`/`Edit`/`ApplyPatch` path emits
`checkpoint.created`, records a file change against the conversation row, and participates in
`rewind.triggered`. A direct filesystem write from this server would produce no checkpoint, be
invisible to rewind, and be unreviewable — exactly the "faster but worse" shortcut the constitution
forbids.

## Failure modes

| Condition | Result |
|---|---|
| Host lacks the capability | `ok:false`, `fault.fileChanges.unsupported` / `fault.fileRewindPreview.unsupported` |
| Stale tokens | one retry, then degraded (see `zcode_conversation.md`) |
| Attachment is not media | `ok:false`, `fault.attachment.previewNotMedia` |
| Attachment over the read cap | `ok:false`, `fault.attachment.previewTooLarge` |
| `rewind_apply` without `confirm:true` | `ok:false`, `errors:['rewind_apply requires confirm:true']` — the only destructive action here |
| Attachment upload over 20 MiB / 64 chunks | `ok:false` before staging completes |

## Permissions

`rewind_apply` is the only filesystem-mutating action in the whole server. It requires explicit
`confirm: true` and is reported with the file list it restored, read back from disk. It is never
invoked implicitly by another tool.

## Read-back

`rewind_apply` re-reads the restored files (existence and size) and reports what it observed.

## Notes

- `put_attachment` stages a file for a later `zcode_chat send`; it does not send anything.
- Attachments are TTL'd (5 min upload, 24 h unreferenced) — stage immediately before sending.
