# Contract: `zcode_plugins`

**Purpose**: enumerate and manage the extension surface. Replaces `zcode.extension.list`.

Rating **A** for read/`set_enabled`/`configure`; **B** for install/update/uninstall (gated).

## Actions

| Action | Arguments | Underlying interface | Read-back |
|---|---|---|---|
| `list` | `workspace` (req) | `plugins/list` | — |
| `overview` | `workspace` | `plugins/overview` | — |
| `describe` | `workspace`, `plugin_id` | `plugins/describe` | — |
| `set_enabled` | `workspace`, `plugin_id`, `enabled` | `plugins/setEnabled` | `plugins/list` |
| `configure` | `workspace`, `plugin_id`, `config` | `plugins/configure` | `plugins/describe` |
| `reset_config` | `workspace`, `plugin_id` | `plugins/resetConfig` | `plugins/describe` |
| `validate` | `workspace`, `plugin_id?` | `plugins/validate` | — |
| `install` 🔒 | `workspace`, `plugin_id` | `plugins/install` | `plugins/list` |
| `update` 🔒 | `workspace`, `plugin_id` | `plugins/update` | `plugins/list` |
| `uninstall` 🔒 | `workspace`, `plugin_id` | `plugins/uninstall` | `plugins/list` |
| `marketplace` 🔒 | `marketplace_action: add\|remove\|update`, `target` | `plugins/marketplace/*` | `plugins/list` |
| `cancel_operation` | `operation_id` | `plugins/cancelOperation` | — |

🔒 = requires `ZCODE_MCP_ALLOW_PLUGIN_INSTALL=1`.

## Argument constraints

- `workspace` is **required** for every action (CONFIRMED: `plugins/list` returns `-32602` without it).
- `config` is validated against the plugin's own declared `userConfig` schema, which `list`/`describe`
  return. The tool surfaces that schema in the error when `config` fails validation, so a caller can
  self-correct.

## Output for `list`

Each plugin: `id` (`<name>@<marketplace>`), `name`, `description`, `version`, `enabled`, `source`,
`marketplace`, `author`, `skillCount`, `skillRootCount`, `commandRootCount`,
`components: [{kind: command|skill|mcp|hook, items: [{name, description}]}]`,
`declaredMcpServerNames`, `mcpServerNames`, `hookDetails`, `rootPath`, `userConfig`.

## The tool-budget warning (CONFIRMED operational hazard)

Every connected MCP server and enabled plugin contributes tools to the model's request. The user's own
`mcp-profile.cmd` documents that GLM rejects requests above a ceiling between **89 and 94** registered
tools with `[1210] Invalid API parameter` (full profile ≈116 tools, trimmed ≈63).

After any enablement change, `set_enabled` / `install` / `uninstall` / `configure` compute the
resulting registered-tool count and, past `ZCODE_MCP_TOOL_BUDGET` (default 88), add:

```json
{"code":"tool_budget","impact":"degraded",
 "detail":"registered tools would reach N (budget 88); the model provider may reject requests with [1210] Invalid API parameter"}
```

## Long-running operations

`install` / `update` / `uninstall` / `marketplace` subscribe to `plugins/operationProgress`. The result
carries `{operation_id, last_progress}` so a caller can `cancel_operation` if it takes too long.

## Failure modes

| Condition | Result |
|---|---|
| Missing `workspace` | `ok:false`, `-32602` |
| Install without opt-in | `ok:false`, `reasonCode:'mcp.plugin_install.disabled'` |
| `config` fails the plugin's schema | `ok:false` with the schema and the zod issues |
| Unknown `plugin_id` | `ok:false`, ZCode's message verbatim |
| Operation cancelled | `ok:false`, `reasonCode` from the progress stream |
| `set_enabled` accepted, read-back shows old value | `ok:false`, read-back mismatch |

## Permissions

Installing a plugin executes third-party code with the agent's authority — hence the opt-in. Plugin
enablement is otherwise a normal configuration change. `list`/`overview`/`describe`/`validate` are
read-only.

## Notes

- Plugin format is **Claude Code-compatible** (CONFIRMED: a `claude-plugins-official` marketplace cache
  with a `.claude-plugin/` directory), so an MCP bridge *could* later be shipped as a plugin. It is not
  the chosen design — see `ZCODE_MCP_SPEC.md` §7 — because a plugin cannot be loaded by a non-ZCode
  client and would inherit plugin-format churn.
