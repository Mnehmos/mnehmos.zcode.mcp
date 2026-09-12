## Every tool is now loadable, models switch live, and a key only has to be entered once

**The headline is a defect that made the whole server unusable.** 13 of the 15 declared tools
published an `inputSchema` with no root `type: "object"`. MCP requires it, and a conforming client
rejects the entire tool list when it sees one — so **no tool could be called at all**, including the
two that were well-formed. Our own SDK's validator rejects the same payload, so this was never a quirk
of one client. `zcodeToJsonSchema` renders a discriminated union as a bare `anyOf`, and one union per
tool is this codebase's design; the list handler hid it behind an `as { type: 'object' }` cast — a type
assertion that describes a shape without producing it.

This release is the first in which any tool is callable.

### Provider keys no longer have to be entered twice

A runtime spawned over stdio reads **no config of its own** — not even ZCode's provider registry. So
the server reads that registry itself and copies the matching provider's key into the runtime's
environment. **Setup is now: configure your model in ZCode.** Environment variables still win when set;
`credentials.json` is never opened; a borrowed key is reported as `provider_key_from_registry` naming
the provider, so which credential is being spent is never a mystery.

### Models switch live, with no respawn

A runtime spawned from the environment knows exactly one model. `zcode_settings upsert_provider` widens
that list on a **running** runtime and `zcode_models select` switches between them:

```
before   available=1  ["deepseek-v4.1-flash-expires-on-0910"]
upsert   ok=true  selectable_models=["deepseek-v4-flash","deepseek-v4-pro"]
after    available=2  ["deepseek-v4-flash","deepseek-v4-pro"]
switch   select scope=server -> deepseek/deepseek-v4-pro
turn     outcome=completed  text="deepseek-v4-pro"
```

The last line is the model naming itself after the switch.

### Withheld: `zcode_command`

It was advertised in `tools/list` with no dispatcher anywhere behind it, so every call returned
`unknown tool`. Its schema and protocol methods exist, and it returns to the surface when it has a
dispatcher, a contract and tests. `.re/verify_dispatch_coverage.mjs` now calls every published tool
with empty arguments and asserts each one is refused *by its own schema* — proof the call arrived.

### Five defects fixed, all of one shape

A claim about the runtime that was never tested against it:

| defect | what it looked like |
|---|---|
| `session/setModel` sent a string | the protocol wants a `ModelRef` object — session-scoped switching could never work |
| `session/resume` read `after.status` | the record is nested under `session`, so a **successful** resume reported failure |
| `upsert_provider` had an invented shape | the runtime requires `{providerId, kind, models:[…]}` and is strict, so no input could succeed |
| `select scope=server` resolved no key hint | reported a missing key for a provider whose key was configured |
| `zcode_plugins overview` returned 227 KB | two marketplaces in full; now ~2.6 KB with the installed plugins kept and a warning naming what was withheld |

Plus two generators of Windows-unaddressable backup names: a stamp built as
`iso.replace(/[-:T]/g,'').slice(0,15)` ends in the millisecond dot, and NTFS accepts a name that every
Win32 path API then strips — the backup is created once and can never be opened. `takeBackup()` now
verifies the copy is byte-identical before the caller may write.

### Verified

- **232 tests**, including the opt-in integration suite against a real runtime; `--self-test` OK; the
  secret scan clean.
- A real turn **through ZCode's own client**: `outcome: completed`, `text: "END_TO_END_OK"`.
- The real server's `tools/list` accepted by the MCP SDK's `ListToolsResultSchema`, on the wire.
- Every published tool reaches a dispatcher.

### Still unproven, or limited

- `zcode_automation` and `zcode_files changes`/`rewind_preview` remain host-tier gaps: `automation/*`
  answers `-32601`, and `v4/conversation/fileChanges` needs an unobtainable `baseRevision`.
- **A workspace that already remembers a model keeps it.** `select scope=server` applies to runtimes
  spawned afterwards in a workspace with no stronger persisted state, and does not yet say so.
- **The recorded tool budget was measured while these tools were being rejected**, so it is about 14
  too low. Re-measure before trimming; the 89–94 ceiling is a GLM limit and does not apply elsewhere.
- The provider-edit actions stay behind `ZCODE_MCP_ALLOW_PROVIDER_EDIT=1`, off by default.

**Full detail, including what was measured and how:** [`CHANGELOG.md`](https://github.com/Mnehmos/mnehmos.zcode.mcp/blob/v0.4.0/CHANGELOG.md), and `.re/findings_ADDENDUM.md` §A24–A31.
