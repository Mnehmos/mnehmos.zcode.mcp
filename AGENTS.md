# AGENTS.md — working in this repo

Written for an agent that has never seen this project. Read this file, then `README.md`, then
`specs/001-zcode-control/plan.md`, then `.re/findings_ADDENDUM.md`.

The repo is the memory: if you learn something that changes how the next agent should work, put it in
one of these files in the same commit.

## What this is

Two things in one repository:

1. A **reverse-engineering audit** of ZCode Desktop 3.11.2 (`ZCODE_*.md`) — evidence about someone
   else's software.
2. A **Spec Kit specification** for `mnehmos.zcode.mcp` (`specs/001-zcode-control/`) — a plan to control
   that software through its own protocol.

The audit came first and constrains the spec. If they ever disagree, the audit wins; fix the spec.

## The one rule that matters

**A tool must never report success for something that did not happen.**

Concretely: every mutating action must read the new state back from ZCode and report *that*, not the
request. `v4/command` returns **admission**, not completion — a chat tool must observe a terminal
`turn.completed` / `turn.failed` event before claiming success, and `status:"noop"` is not success.
If a read-back is unavailable, the envelope carries `warn(..., impact:'degraded')` or the call fails.

This is Constitution Article II and it is the reason the project exists in its current shape.

## Where things are

```
ZCODE_*.md                       the audit (13 documents). Start with ZCODE_ARCHITECTURE.md.
.re/findings_ADDENDUM.md         CORRECTIONS to the audit from a second pass. Authoritative over the above.
.re/asar.py                      ASAR reader (list | cat | extract | sizes)
.re/channels.py                  IPC channel-map extractor
.re/probe.js                     the ZCode Protocol prober — spawns app-server and speaks NDJSON
.re/x/                           extracted bundles (main, preload, host, scheduler, chunks)
.re/findings_cli_bundle.md       raw deep report on zcode.cjs (55 KB, byte-offset indexed)
.specify/memory/constitution.md  the eight articles. Every plan must pass a Constitution Check.
specs/001-zcode-control/         spec → plan → research → data-model → contracts/ → quickstart → tasks
```

## Key ZCode facts you will need

| Fact | Value |
|---|---|
| ZCode desktop version | 3.11.2 (Electron 41.0.3) |
| Agent runtime version | **0.16.5** — the version that matters for the protocol |
| Runtime bundle | `E:\zcode\resources\glm\zcode.cjs` (12.6 MB, 3264 lines, minified but **not** mangled) |
| Spawn | `node <zcode.cjs> app-server --stdio --cwd <workspace>` |
| `--stdio` | **a declared no-op** — framing is unconditional; `app-server` sends its logs to stderr |
| Protocol | `"ZCode Protocol"` v1; v4 wire version **3** |
| Envelope | `{id,method,params}` / `{id,result}` / `{id,error:{code,message,data}}` — **no `jsonrpc` field** |
| Method counts | 65 `v1` + 21 `v4`; `v4/command` has **30** command types |
| Frame limit | 1 MiB inline; larger logical frames are **fragmented** (crc32, ≤1024 fragments, ≤16 MiB) |
| Accepted CLI flags | exactly **21** + a `--disallowed-tools` pre-pass (see addendum §A2) |
| Advertised-but-unparsed flags | `--settings`, `--max-turns`, `--allowed-tools`, `--permission-mode`, `--allow-main-worktree-yolo` |
| Headless output | `-p "…" --output-format text\|json\|stream-json`; `stream-json` ends with a `{"type":"result",…}` line |
| Provider config | top-level `model` key; project config beats user config; key via env (`ZCODE_API_KEY`, `ANTHROPIC_API_KEY`, …) |
| No local listener on the desktop | The desktop opens **no** HTTP/WS server. Web Remote Control is an outbound `ws` client to `wss://zcode.z.ai/ws`; the desktop↔host channel is tunnelled through that relay in **binary** `rpc-frame` fragments — a different protocol from ZCode Protocol v4. Stdio to an owned runtime is the only local control boundary (addendum §A16) |
| Remote *server* surface | a real network-reachable ZCode Protocol host RPC exists, but only for remote ZCode servers: `GET /api/server-info` → `POST /api/rpc-host-capability` → `wss://<base>/ws/host?token=…` with `Authorization: Bearer` + `x-zcode-rpc-host-capability`. Out of scope for v1 |
| Credential cipher is weak | `~/.zcode/v2/credentials.json` is AES-256-GCM, but with `ZCODE_CREDENTIAL_SECRET` unset the key falls back to a value **derived from the machine's own identity** rather than from a user secret — reproducible by anyone holding a copy of the file. **Report it; never use it.** `config.json` provider keys are plaintext |

## Things that will cost you an hour each

- **The runtime must be launched as `node <zcode.cjs>`.** Executing the `.cjs` directly fails with
  `EFTYPE`.
- **`--settings` does not parse**, despite being in `--help`. `util.parseArgs` runs `strict:true`, so an
  unknown flag is a hard usage error, not a warning. Never emit a flag you have not verified.
- **A bare runtime has no credentials.** `model.current` is `{modelId:"missing-model", providerId:"zcode-unconfigured"}`
  until you provision a provider. This is expected, not a bug.
- **`mcp/list` starts the MCP servers.** It is not a pure read. `ZCODE_MCP` reads the config file instead.
- **Owning a runtime makes you its only client.** If you do not answer `interaction/*` requests, turns
  hang in status `waiting`. The policy module is not optional.
- **`session/stop` bypasses the runtime's serial processing queue.** That is why cancellation works
  while the agent is busy.
- **Conversation reads carry `logEpoch` + `revision`.** Compaction and fork change `logEpoch` and
  invalidate row ids. Re-read the tokens; never cache rows across an epoch change.
- **17 of the 30 v4 command types require `baseRevision` + `baseLogEpoch`.** A mutating v4 command is a
  compare-and-swap, so it is a read-modify-write, not a fire-and-forget.
- **ZCode's own `--help` and its parser disagree.** Trust the parser, and trust the byte offsets in
  `.re/findings_cli_bundle.md` over any prose.
- **Minified identifiers are not a contract.** Handler names like `l3e`, `Q3e`, `j3e` appear in ZodError
  stacks and were useful for *finding* code; never depend on them in the MCP.
- **`~/.zcode/v2/config.json` contains plaintext API keys.** Never print it, never copy it into the
  repo, and always redact. The audit deliberately redacted every observed value.

## Adding a tool action

1. Add the variant to the tool's discriminated union in `src/schema/tools.ts`. Keep the vocabulary
   closed: enums, bounded numbers, bounded arrays. No free-form code.
2. Write the contract first in `specs/001-zcode-control/contracts/<tool>.md`: the underlying protocol
   method, the arguments, the failure modes, the permission implications, and **the read-back**.
   If you cannot write a read-back for a mutating action, do not ship it as a typed action — put it
   behind `zcode_protocol` where it is explicitly marked `unreliable`.
3. Implement the dispatcher in `src/zcode/actions/<tool>.ts`.
4. Add a schema case to `test/schema.test.ts` and a unit test for any pure logic.
5. If the action mutates, extend the opt-in integration suite and prove the read-back.
6. Update the tool table in `README.md`.

## Git flow

`main` is release-only and always green. `develop` is the integration branch.
Work happens on short-lived branches off `develop`.

```
main      ●────────────●──────────────●        tags only, no direct commits
           \          / \            /
develop     ●──●──●──●────●──●──●───●          integration, always building
             \    /      \    /
feature/*     ●──●          ●──●               one concern, merged when its gate passes
```

| Branch | From | Merges into | Purpose |
|---|---|---|---|
| `feature/<task-id>-<slug>` | `develop` | `develop` | one task or a small cluster from `tasks.md` |
| `release/<version>` | `develop` | `main` **and** `develop` | stabilise, bump version, update CHANGELOG |
| `hotfix/<slug>` | `main` | `main` **and** `develop` | fix a shipped release |

Rules:

1. **Never commit to `main` directly.** A release is merged from `release/*` and tagged.
2. **Name feature branches after the task id** from `specs/001-zcode-control/tasks.md`, so the
   branch, the commit and the task list stay legible together — e.g. `feature/T015-transport`.
3. **A merge needs its gate.** For a feature branch that is the relevant gate in the table below;
   for a release branch it is the full gate set plus `ZCODE_MCP_IT=1`.
4. **Tag releases with an annotated tag** and write real release notes: what changed, what was
   verified, what is still unproven. `CHANGELOG.md` and the tag must agree.
5. **Merge `release/*` back into `develop`.** A fix that only lands on `main` will be undone by the
   next release.

## Gates (all must pass before you call anything done)

```sh
npm run scan:secrets              # no real credential anywhere in git history. FIRST, always.
npm run typecheck
npm test                          # typecheck + unit tests
npm run smoke                     # node dist/index.js --self-test
ZCODE_MCP_IT=1 npm test           # real runtime; asserts a real turn and zero orphans
```

**Run `npm run scan:secrets` before every push.** A real API key was once committed inside a test
fixture because it *looked* synthetic — 32 hex chars, a dot, 16 base64ish characters, which is exactly
the shape of a fake token and exactly the shape of a real one. Shape-plausible is not synthetic, and a
test fixture is still a committed file. The scanner reads the machine's real secret stores and searches
every git object and commit message for those values, so the check is mechanical rather than a
judgement call. Removing a leaked value from HEAD does not un-expose it; only rotation does that.

## Style

Match what is here and in the sibling repos (`mnehmos.unreal.mcp`): sparse comments that state a
constraint the code cannot show, no comments that restate the line. Envelope keys are lower snake_case
and are the stable contract — do not rename them without updating tests, contracts and README.

Evidence labels are mandatory in the audit documents: **CONFIRMED** / **STRONGLY INFERRED** /
**HYPOTHESIS**. Never upgrade a label without new evidence, and never let a hypothesis reach the spec
as if it were confirmed.

## Scope discipline

This server controls ZCode. It does not re-implement ZCode's agent loop, prompt construction, tool
dispatch or context management — those exist, are versioned, and are the reason the protocol is the
right boundary. If you find yourself writing a prompt, stop.
