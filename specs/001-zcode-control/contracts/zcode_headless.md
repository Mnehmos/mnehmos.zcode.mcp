# Contract: `zcode_headless`

**Purpose**: run ZCode in one-shot headless mode with no protocol involvement.
The fallback that survives any protocol change. Rating **A**.

## Actions

| Action | Arguments |
|---|---|
| `prompt` | `text`, `workspace`, `output?: json\|text`, `mode?`, `resume?`, `continue?`, `target?`, `attach?[]`, `allowed_tools?[]`, `disallowed_tools?[]`, `timeout_ms?` |

```ts
zcode_headless({ action: 'prompt', text: 'summarise the README',
                 workspace: 'F:\\Github\\proj', output: 'json' })
```

## Flags — verified subset only

CONFIRMED during the audit: the `--help` text advertises flags the option parser **rejects**.

| Flag | Status | Evidence |
|---|---|---|
| `--prompt <text>` | **accepted** | live execution |
| `-p / --print` | accepted | live execution |
| `--json` | accepted | live execution |
| `--cwd <path>` | accepted | live execution |
| `--help`, `-v/--version` | accepted | live execution |
| `--settings <path>` | **REJECTED** | `Unknown option '--settings'` |
| `--max-turns <n>` | **REJECTED** | `Unknown option '--max-turns'` |
| others in `--help` | **unverified** | see `ZCODE_UNKNOWNS.md` U-13 |

**Rule (Constitution Article III):** this tool emits only flags from the verified table, and that table
is asserted by a test. The complete command line is returned in `run.command` and stored in the audit
row, so a surprising result is always attributable.

Until U-13 is resolved the tool therefore does **not** forward `mode`, `allowed_tools`,
`disallowed_tools`, `attach`, `target` or `resume`. Those arguments are accepted by the schema but
produce `warnings:[{code:'flag_unverified', impact:'degraded',
detail:'<flag> is not in the verified flag table and was not emitted'}]`. This is deliberate: emitting
a flag that fails to parse turns a working call into a usage error.

## Provider requirement

Headless mode needs a configured model provider, exactly like the protocol path (CONFIRMED: without one
it fails with `Error: Model config is missing. Create C:\Users\<user>\.zcode\cli\config.json with an
explicit model provider before running ZCode.`).

That message is passed through **verbatim** with
`warnings:[{code:'provider_not_configured', impact:'unreliable'}]`, so a caller can distinguish
"misconfigured" from "the tool is broken" without reading our source.

## Output

```ts
{
  output_format: 'json' | 'text',
  stdout_raw: string,        // always present — the ground truth
  parsed?: unknown,          // only when output:'json' and stdout parsed as JSON
  duration_ms: number
}
```

`stdout_raw` is always returned so a caller is never blocked by our JSON parsing being wrong about a
format we have not yet fully characterised (`ZCODE_UNKNOWNS.md` U-2). If parsing fails:
`warnings:[{code:'stdout_not_json', impact:'degraded'}]`.

## Failure modes

| Condition | Result |
|---|---|
| No provider configured | `ok:false`, ZCode's message verbatim, `impact:'unreliable'` |
| Non-zero exit | `ok:false`, `evidence.exit_code` set, `diagnostics.stderr_tail` populated |
| Timeout | `ok:false`, `evidence.timed_out:true`, child process tree killed |
| Runtime not discovered | `ok:false`, discovery guidance |
| `workspace` missing | `ok:false` before spawn |

## Permissions

`mode` is not forwardable yet, so headless runs use ZCode's own default (`yolo` for `--prompt`). That
is a **broad authority** for an unattended run. The tool's description says so explicitly, and callers
who need a narrow run should use `zcode_chat` with `tool_allowlist`, which does support restriction.

> This is the one place where the fallback path is *less* safe than the primary path. It is documented
> rather than hidden, and the eventual U-13 resolution is expected to allow `--mode` to be forwarded,
> closing the gap.

## Notes

- Use this tool when: the protocol version changed unexpectedly, the runtime will not start
  interactively, or the caller wants a single stateless answer with no session lifecycle.
- Do not use it for multi-turn work — it has no session continuity unless `--resume` is verified.
