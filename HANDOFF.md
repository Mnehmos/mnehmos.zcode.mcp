# HANDOFF.md

State of this repository and what the next agent should do.

**Date**: 2026-09-11 · **Repo state**: audit complete, specification complete, **no implementation**

---

## What exists

| Artifact | Status |
|---|---|
| Reverse-engineering audit (13 `ZCODE_*.md`) | ✅ complete, evidence-labelled |
| Deep CLI-bundle report (`.re/findings_cli_bundle.md`, 55 KB) | ✅ complete, byte-offset indexed |
| Addendum with corrections (`.re/findings_ADDENDUM.md`) | ✅ complete — **authoritative over the audit where they conflict** |
| Constitution (`.specify/memory/constitution.md`) | ✅ ratified |
| Spec, plan, research, data-model, 15 contracts, quickstart, tasks | ✅ complete |
| MCP server source | ❌ not started |
| Tests | ❌ not started |

## What is proven vs. planned

**Proven by execution** (CONFIRMED):

- `node zcode.cjs app-server --stdio` answers NDJSON requests on stdin/stdout.
  `{"id":1,"method":"bogus/method","params":{}}` → `{"error":{"code":-32601,"message":"Method not found: bogus/method"},"id":1}` in ~1.1 s.
- `session/list` works with empty params and returns real session data.
- `workspace/readState`, `mcp/list`, `plugins/list` require a `workspace` object; `usage/stats`
  requires a range; `v4/commands/query` requires ≥1 entry with a string `commandId`.
- A bare runtime has no provider: `modelId: "missing-model"`, `providerId: "zcode-unconfigured"`.
- `--settings` and `--max-turns` are advertised in `--help` but rejected by the parser.

**Proven by static analysis, byte-offset indexed** (CONFIRMED):

- 66 protocol methods and their handler functions; 4 method enums.
- The `v4/command` envelope, its 30 command types, and the CAS requirement on 17 of them.
- The runtime's model-config schema and the environment-variable key order.
- The accepted flag set (21 flags; `util.parseArgs` with `strict:true`).
- The fragment protocol for logical frames over 1 MiB.

**Designed, not proven** (the remaining risk):

- That a generated model config is picked up reliably (three candidate delivery mechanisms; the
  manual `config.json` edit is the fallback and is sufficient by itself).
- That the typed tool surface maps cleanly onto the 30 v4 command types (the command catalog was
  discovered *after* the contracts were written — see below).

## The most important next actions

1. **Prove the transport in the MCP's own code.** Port `.re/probe.js` into
   `src/zcode/transport.ts` + `src/zcode/protocol.ts` and make `tasks.md` T015 pass. Everything
   downstream depends on it and nothing downstream can be validated without it.
2. **Prove provider bootstrap.** T027, using the addendum's env-var key order. If all three delivery
   mechanisms fail, document the manual edit and move on — the design does not depend on automation.
3. **Reconcile the contracts with the 30-command catalog.** The contracts were written when only
   `createSession` / `sendText` / `sendGoalCommand` / `compact` were known. The addendum's §A6 lists 30
   types. Concretely:
   - `zcode_files` should use `applyFileRewind` (a v4 command) instead of the fork workaround.
   - `zcode_approval` should use `resolveInteraction` (a v4 command) as its primary path.
   - Consider typed actions for `retryTurn`, `renameSession`, `deleteSession`, `switchModelConfig`,
     `switchCollaborationMode`, `setFollowupMode`, `editUserQuery`, and the queue family
     (`sendQueuedNow`, `editQueueItem`, `reorderQueueItem`, `deleteQueueItem`, `setAutoDrain`).
   - Every mutating v4 command needs the CAS tokens — route them through `logtokens.ts`.
4. **Handle the five command statuses.** `zcode_chat` must distinguish `rejected`, `stale` and
   `duplicate` from `accepted`/`noop`/`failed`. `stale` means wrong CAS tokens; `duplicate` means the
   idempotency key worked. Neither is success.

## Deliberately out of scope

- **Attaching to the running desktop — now proven IMPOSSIBLE, not merely deferred.** The desktop opens
  no local listener; Web Remote Control is an outbound `ws` client to `wss://zcode.z.ai/ws` and the
  desktop↔host channel is tunnelled through that relay in binary fragments. A genuine
  network-reachable ZCode Protocol surface exists for *remote ZCode servers*
  (`wss://<base>/ws/host`, bearer + capability auth) but that is a different product surface and is
  explicitly not v1. See `.re/findings_ADDENDUM.md` §A16.
- **UI automation.** Prohibited by the constitution.
- **Editor document operations.** They do not exist in ZCode; declared as non-capabilities.
- **Configuring the user's ZCode installation.** The MCP provisions a provider for *its own* child
  runtime, and nothing else.

## Unresolved questions

See `ZCODE_UNKNOWNS.md`. **Open: U-1 only** (Web Remote Control — gates Tier B), plus the equally
low-impact U-6, U-7, U-9, U-10, and newly-opened U-14 (the `hooks trust` family and hidden
subcommands). **Resolved during the audit: U-2, U-3, U-4, U-5 (mostly), U-8, U-11, U-12, U-13.**

## Background investigations — both landed

Both parallel deep-dives completed and their reports are on disk:

- `.re/findings_cli_bundle.md` (55 KB, byte-offset indexed) — invocation contract, the exact 21-flag
  parse set, headless output formats, the 30-type `v4/command` catalog, the fragment protocol, the
  28-tool registry, SQLite DDL, provider ids, OAuth flows, ~90 env vars. Digest in
  `.re/findings_ADDENDUM.md` §A1–A12.
- `.re/findings_state_model.md` (98 KB, with a verbatim DDL appendix) — the full 19-table agent schema
  and 8-table desktop schema, the config priority stack, every zod state object, the 25-event union,
  the persistence inventory, the credential ciphers, and the workspace-key rule. Digest in
  `.re/findings_ADDENDUM.md` §A13–A15.

**Two findings from those reports change the plan. Read them before writing code:**

1. **§A13 — the credential cipher key is not protected by a user secret.** `credentials.json` is
   AES-256-GCM, but with `ZCODE_CREDENTIAL_SECRET` unset the key falls back to a value derived from the
   machine's own identity, so it is reproducible by anyone holding a copy of the file. Tell the user so
   they can set the variable; **do not** use it. The constitution forbids it explicitly.
2. **§A14 — provider bootstrap has a supported mechanism.** The CLI resolves config through a priority
   stack, and **project-level config (priority 20)** is walk-up discovered from the git root reading
   `zcode.json` *and* `.zcode/config.json`. Use that for the generated `model` block; it beats the
   `HOME`-redirection hack and needs no unparsed flag.

Also worth knowing before writing the chat tool: `turn.completed` carries a **`resultType`**
(`success | cancelled | error_max_turns | error_max_budget | error_during_execution |
error_max_tool_calls`). Surface it verbatim — it distinguishes a user cancellation from an execution
error, which a bare `outcome` boolean would flatten (§A15).

## Environment notes for whoever picks this up

- ZCode install: `E:\zcode` (runtime at `E:\zcode\resources\glm\zcode.cjs`).
- Agent runtime version **0.16.5** — this is the version the protocol depends on, not the desktop's 3.11.2.
- The runtime must be spawned as `node <path>`, never executed directly (`EFTYPE`).
- Analysis tooling in `.re/`: `asar.py` (ASAR reader), `channels.py` (channel extractor),
  `probe.js` (protocol prober). All three were used to produce the audit and are reusable after a
  ZCode upgrade.
- **Do not commit anything from `.re/x/`** (extracted bundles, ~50 MB) or any file containing real
  credentials. The audit deliberately redacted every observed key; keep it that way.
