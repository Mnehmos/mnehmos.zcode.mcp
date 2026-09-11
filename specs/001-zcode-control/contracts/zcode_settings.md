# Contract: `zcode_settings`

**Purpose**: read and change configuration. Replaces `zcode.settings.get` / `zcode.settings.set`.

**Two backends, and the tool always says which one it used.** Rating **A** for protocol actions,
**B** for file actions.

## Actions

| Action | Backend | Arguments | Underlying interface | Read-back |
|---|---|---|---|---|
| `read_state` | protocol | `workspace` | `workspace/readState` | — |
| `get` | filesystem | `file: agent_config\|desktop_settings\|provider_registry` | config files, **redacted** | — |
| `set_desktop` | filesystem | `patch` | `~/.zcode/v2/setting.json` | re-read file |
| `set_default_model` | protocol | `workspace`, `model` | `workspace/setDefaultModel` | `workspace/readState` |
| `set_default_mode` | protocol | `workspace`, `mode` | `workspace/setDefaultMode` | `workspace/readState` |
| `set_default_thought_level` | protocol | `workspace`, `thought_level` | `workspace/setDefaultThoughtLevel` | `workspace/readState` |
| `update_interaction_prefs` | protocol | `workspace`, `ask_user_question_auto_resolution` | `workspace/updateInteractionPreferences` | `workspace/readState` |
| `update_model_io_prefs` | protocol | `workspace`, `full_retention` | `workspace/updateModelIoPreferences` | `workspace/readState` |
| `upsert_provider` | protocol 🔒 | `workspace`, `provider` | `workspace/upsertModelProvider` | `workspace/readState` |
| `remove_provider` | protocol 🔒 | `workspace`, `provider_id` | `workspace/removeModelProvider` | `workspace/readState` |
| `update_provider_registry` | protocol 🔒 | `workspace`, `registry` | `workspace/updateProviderRegistry` | revision echo |
| `hook_trust_grant` | protocol | `workspace` | `workspace/hooks/trustGrant` | `{accepted}` |

🔒 = requires `ZCODE_MCP_ALLOW_PROVIDER_EDIT=1`, else refuses with
`reasonCode:'mcp.provider_edit.disabled'`.

## Backend disclosure

- Protocol actions take effect immediately.
- File actions are read by ZCode **at startup**, so the envelope carries
  `warnings:[{code:'restart_required', impact:'advisory',
   detail:'desktop settings are read at startup; restart ZCode for this to take effect'}]`.
  File actions NEVER imply the change is live.

## Secret handling (Constitution Article IV)

`get` returns a **redacted** view: every `apiKey`, `*token*`, `*secret*`, `*password*` field becomes
`"[REDACTED]"`.

> ⚠ **Documented hazard**: `~/.zcode/v2/config.json` stores provider API keys in **plaintext**
> (CONFIRMED during the audit). The redaction is therefore not cosmetic — an unredacted read would
> leak live credentials into a model's context. `ZCODE_MCP_REDACT=0` does **not** disable this
> specific redaction; it only relaxes wire-log scrubbing.

## `set_desktop` safety

Writes are **additive patches**, never wholesale replacement, because ZCode maintains
`*MigrationInitialized` flags and forward-migrates settings. The tool:

1. reads the current file, records its hash,
2. applies the patch keys only,
3. writes atomically,
4. re-reads and reports the observed values,
5. writes the previous version to `work/settings/<ts>-setting.json.bak`.

## Failure modes

| Condition | Result |
|---|---|
| Provider action without opt-in | `ok:false`, `reasonCode:'mcp.provider_edit.disabled'` |
| Read-back disagrees | `ok:false`, `errors:['read-back mismatch: …']` |
| File action, file absent | `ok:true` with the defaults ZCode would use, `warnings:[{code:'file_absent', impact:'advisory'}]` |
| Malformed patch (non-object, or unknown top-level key) | `ok:false` before write |
| `hook_trust_grant` rejected | `ok:false`, `{accepted:false}` verbatim |

## Permissions

Provider edits are the highest-blast-radius operation available: a bad registry can silently break
model access for the user's desktop. Hence the separate opt-in. Everything else is scoped to
preferences.

## Notes

- `read_state` is the cheapest way to answer "what model/mode is this workspace using".
- Desktop settings keys are enumerated in `ZCODE_STATE_MODEL.md` §2.2 of the RE archive.
