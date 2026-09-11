# mnehmos.zcode.mcp

An MCP server that controls **ZCode** (the Z.ai / Zhipu desktop AI coding agent) programmatically.

> **Status: specification complete, implementation not started.**
> This repository currently contains (a) a full reverse-engineering audit of ZCode Desktop 3.11.2 and
> (b) the Spec Kit specification, plan, contracts and task list for the server. Start with
> `specs/001-zcode-control/quickstart.md`, then `tasks.md`.

---

## What was found

ZCode is not a monolith and not a VS Code fork. It is three tiers: an Electron shell, a host/broker
process, and a **separate headless agent runtime**. That third tier is the discovery that makes this
project possible:

```sh
printf '{"id":1,"method":"session/list","params":{}}\n' \
  | node "E:/zcode/resources/glm/zcode.cjs" app-server --stdio
# → {"id":1,"result":{"sessions":[ … real sessions … ]}}
```

`zcode app-server` is documented in ZCode's own `--help` as *"Run the ZCode Protocol stdio app
server"*. It speaks a named, versioned, zod-validated protocol (**"ZCode Protocol"**, v1; v4 wire
version 3) over newline-delimited JSON on stdin/stdout, exposing **65 methods** plus **21 v4
methods**, including `v4/command` with **30 command types**.

**The whole design rests on this**: control ZCode by owning one of its agent runtimes and speaking its
own protocol — never by simulating a user.

### The five findings that shaped the design

| # | Finding | Consequence |
|---|---|---|
| 1 | The agent runtime is spawnable and scriptable by an unrelated process, over stdio | Rating **A** control surface; no UI automation anywhere |
| 2 | The runtime needs **its own** model-provider config and does not inherit the desktop's | The MCP must provision a provider — and can pass the API key by **environment**, so no secret touches disk |
| 3 | Owning the runtime makes us its **only client**, so it sends *us* the approval requests | A default-**deny** policy module is mandatory, not a nicety, or turns deadlock |
| 4 | `v4/command` returns **admission**, not completion | The chat tool must observe a terminal turn event before claiming success |
| 5 | **ZCode has no editor document service** | "get active editor" / "replace selection" are not buildable; file mutation goes through the agent's own tools, which is the only path that produces checkpoints and participates in rewind |

---

## Repository contents

### The reverse-engineering audit

| Document | What it covers |
|---|---|
| [`ZCODE_ARCHITECTURE.md`](./ZCODE_ARCHITECTURE.md) | three-tier architecture, processes, flows, boundaries — the main reconstruction |
| [`ZCODE_COMPONENT_MAP.md`](./ZCODE_COMPONENT_MAP.md) | every process, service, module and dependency, with the process diagram |
| [`ZCODE_API_CATALOG.md`](./ZCODE_API_CATALOG.md) | every communication surface: 66 protocol methods, 129 IPC channels, host RPC, HTTP endpoints, env vars |
| [`ZCODE_COMMAND_CATALOG.md`](./ZCODE_COMMAND_CATALOG.md) | all six command/event registries, the 25 session-event types, the 30+ agent tools |
| [`ZCODE_UI_MAP.md`](./ZCODE_UI_MAP.md) | UI surfaces → internal actions, and the editor-API non-capability |
| [`ZCODE_STATE_MODEL.md`](./ZCODE_STATE_MODEL.md) | the split state model, every entity, persistence map, safe-write rules |
| [`ZCODE_AGENT_ARCHITECTURE.md`](./ZCODE_AGENT_ARCHITECTURE.md) | model providers, registry sync, turn lifecycle, tools, permissions, subagents, MCP |
| [`ZCODE_CONTROL_SURFACES.md`](./ZCODE_CONTROL_SURFACES.md) | surfaces ranked A–F, and the full control-surface matrix per operation |
| [`ZCODE_RE_FINDINGS.md`](./ZCODE_RE_FINDINGS.md) | the evidence log: what was run, what was seen, labelled CONFIRMED / INFERRED / HYPOTHESIS |
| [`ZCODE_UNKNOWNS.md`](./ZCODE_UNKNOWNS.md) | open questions, each with the experiment that settles it |
| [`ZCODE_MCP_SPEC.md`](./ZCODE_MCP_SPEC.md) | the proposed MCP architecture and tool surface |
| [`ZCODE_MCP_IMPLEMENTATION_PLAN.md`](./ZCODE_MCP_IMPLEMENTATION_PLAN.md) | staged build order from smallest proof of control |
| [`.re/findings_ADDENDUM.md`](./.re/findings_ADDENDUM.md) | **corrections** from the second deep CLI pass — read this alongside the above |

Working artifacts (ASAR reader, protocol prober, extracted bundles, raw agent reports) are in `.re/`.

### The specification (Spec Kit)

```
.specify/memory/constitution.md        the eight articles every design decision must pass
specs/001-zcode-control/
├── spec.md                            user stories P1–P5, 45 functional requirements, 12 success criteria
├── plan.md                            technical context, Constitution Check, project structure
├── research.md                        the decision record, each decision with its alternatives
├── data-model.md                      external entities + internal entities + state transitions
├── contracts/                         15 files: the shared envelope + one per tool
├── quickstart.md                      clone → first successful call, with checkpoints
└── tasks.md                           85 tasks in 8 phases, grouped by user story
```

---

## The tool surface

14 tools with discriminated-union actions — deliberately not one tool per operation, because the model
provider rejects requests above roughly 89–94 registered tools.

| Tool | Actions | Read-only? | Rating |
|---|---|---|---|
| `zcode_status` | `runtimes`, `workspace`, `sessions`, `probe`, `doctor`, `runs` | ✅ | A |
| `zcode_session` | `list`, `get`, `create`, `resume`, `close`, `fork`, `compact`, `set_model`, `set_mode`, `set_thought_level`, `goal`, `subagents`, `usage` | mixed | A |
| `zcode_chat` ★ | `send`, `steer`, `stop`, `cancel_background`, `wait` | ❌ | A |
| `zcode_conversation` | `rows`, `messages`, `events`, `plans`, `usage` | ✅ | B |
| `zcode_files` | `changes`, `rewind_preview`, `rewind_apply`, `read_attachment`, `put_attachment` | mostly | B |
| `zcode_command` | `catalog`, `query`, `execute` | mixed | A |
| `zcode_settings` | `read_state`, `get`, `set_desktop`, `set_default_*`, `update_*_prefs`, `upsert_provider`, `remove_provider`, `update_provider_registry`, `hook_trust_grant` | mixed | A/B |
| `zcode_plugins` | `list`, `overview`, `describe`, `set_enabled`, `configure`, `reset_config`, `validate`, `install`, `update`, `uninstall`, `marketplace`, `cancel_operation` | mixed | A/B |
| `zcode_mcp` | `list`, `status`, `servers`, `add_server`, `remove_server` | mixed | A/B |
| `zcode_automation` | `list`, `create`, `update`, `delete`, `check_binding` | mixed | A |
| `zcode_usage` | `stats` | ✅ | A |
| `zcode_approval` | `policy`, `list`, `respond` | mixed | B |
| `zcode_headless` | `prompt` | ❌ | A |
| `zcode_protocol` | `methods`, `call` | gated | C |

★ = the P1 journey. Everything else is prerequisite plumbing or convenience.

### Non-capabilities, stated plainly

These were requested but **cannot be built on any stable interface**, because ZCode has no editor
document service (CONFIRMED, not inferred):

`zcode.editor.active` · `zcode.editor.selection` · `zcode.editor.replace_selection` ·
`zcode.file.read` (as the editor sees it) · `zcode.file.save` · `zcode.diff.accept`/`.reject` (only
partially, via rewind)

The substitutes are documented per tool in `specs/001-zcode-control/contracts/`, and the reasoning is
in `ZCODE_UI_MAP.md` §7.

---

## Design principles

From `.specify/memory/constitution.md`:

1. **Semantic control only.** Every tool resolves to a named protocol method, a parser-verified CLI
   flag, or a documented config file. No clicks. No minified identifiers. No live-DB writes.
2. **No success without read-back.** Every mutating action re-reads and fails on contradiction.
   Admission is not completion. `noop` is not success.
3. **Schemas are contracts.** zod before spawn; protocol version asserted at first contact; loud on drift.
4. **Secret handling.** API keys travel by environment, never a generated file; redaction is on by
   default; ZCode's credential store is never read or written.
5. **Deny by default.** The approval policy defaults to deny; blanket auto-approval is prohibited.
6. **Bounded resources.** Timeouts, owned process groups, hard kill on every path, no orphans.
7. **The repo is the memory.** Audit row per call, hashed artifacts, evidence labels on every claim.
8. **Tests are reflexes.** Codec, schemas, redaction, policy and log-token retry are unit-tested; a
   real turn, a denied write with no side effect (verified by hash), and zero orphans are integration-tested.

---

## Safety: what this server will not do

- Simulate mouse or keyboard input.
- Write to ZCode's live SQLite databases.
- Read, write or relocate `~/.zcode/v2/credentials.json`.
- Auto-approve tool use.
- Report a mutation as successful without reading the result back from ZCode.
- Expose arbitrary protocol methods by default (the escape hatch is off, allowlisted, and kill-switchable).

## Known hazards, disclosed in the tools themselves

| Hazard | Where |
|---|---|
| `mcp/list` **starts** the configured MCP servers | `zcode_mcp` description + `evidence.warnings` |
| Desktop settings changes need a ZCode restart | `zcode_settings` file actions |
| Enabling plugins consumes the model's tool budget (`[1210]` above ~89–94 tools) | `zcode_plugins` budget warning |
| Creating an automation grants **standing unattended authority** at the recorded mode | `zcode_automation` description |
| `~/.zcode/v2/config.json` stores provider API keys in **plaintext** | `zcode_settings` redaction is mandatory |

## Open items

`ZCODE_UNKNOWNS.md` — 9 of 14 questions are resolved. What remains is low-impact except U-14 (the
un-analysed `hooks trust` family). The two that mattered most resolved decisively:

- **U-1** — Web Remote Control. There is **no local network surface**: the desktop opens no listener
  and is an outbound `ws` client to a Z.ai relay. This ruled out the "attach to the running desktop"
  design entirely, which is why stdio to an owned runtime is the only boundary.
- **U-4** — credential protection. Provider keys in `config.json` are **plaintext**;
  `credentials.json` is AES-256-GCM but with a key **derived from the machine's own identity** when
  `ZCODE_CREDENTIAL_SECRET` is unset, so it is obfuscated rather than truly encrypted.

## Two things worth doing on your machine

1. **Set `ZCODE_CREDENTIAL_SECRET`.** Without it, the key protecting `~/.zcode/v2/credentials.json` is
   derived from the machine's own identity rather than from a secret you hold — so the file is
   obfuscated, not really encrypted, and anyone with a copy of it can read your tokens.
2. **Treat provider keys in `~/.zcode/v2/config.json` as plaintext secrets**, because they are. They sit
   in a JSON file, not a keychain.

Neither is something this MCP uses; both are reported because the audit found them. The Web Remote
Control QR is also a bearer secret (`hash=<passHash>`), so a photographed QR stays live until
`reset-pairing` is run.

## License

MIT. See `LICENSE`.
