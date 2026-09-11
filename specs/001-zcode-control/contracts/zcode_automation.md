# Contract: `zcode_automation`

**Purpose**: manage ZCode's scheduled agent runs (cron / interval).

Rating **A**.

## Actions

| Action | Arguments | Underlying interface | Read-back |
|---|---|---|---|
| `list` | — | `automation/list` | — |
| `create` | see below | `automation/create` | `automation/list` |
| `update` | `automation_id`, patch | `automation/update` | `automation/list` |
| `delete` | `automation_id` | `automation/delete` | `automation/list` (absent) |
| `check_binding` | `target_task_id` | `automation/checkTaskBinding` | — |

## `create` arguments

```ts
{
  prompt: string,                       // required
  title?: string,
  cron_expr?: string,                   // either this…
  relative_delay_minutes?: int,         // …or a one-shot delay
  interval_unit?: 'minute'|'hourly'|'daily'|'weekly'|'monthly'|'yearly',  // …or an interval
  interval?: int (1..200),              //   with interval_unit
  model?: string, provider?: string,
  mode?: 'plan'|'build'|'edit'|'yolo'|'auto',
  thought_level?: string,
  target_task_id?: string,
  recurring?: boolean,                  // default true
  max_runs?: int                        // only meaningful with recurring:false
}
```

Exactly one scheduling form must be supplied: `cron_expr`, `relative_delay_minutes`, or
`interval_unit` + `interval`. Supplying none or several is `ok:false` before send.

Model/mode/reasoning are captured **at creation time** — a scheduled run uses the settings recorded in
the automation, not the workspace's current defaults.

## The 20-automation cap

ZCode retains **at most 20** automations and raises its own error beyond that:

```
AutomationCreateLimitError: [<code>] At most 20 automations may be retained.
Delete an existing automation before creating another.
```

This is passed through **verbatim** in `errors[0]`, and `create` additionally reports
`result.retained` and `result.capacity: 20` so a caller can plan.

## Output for `list`

Each automation includes `automationId`, `title`, `cronExpr`, `prompt`, `model`, `provider`, `mode`,
`thoughtLevel`, `workspaceKey`, `workspacePath`, `workspaceIdentity`, `targetTaskId`, `locationKind`
(`local` | `remote`), and the schedule fields.

## Failure modes

| Condition | Result |
|---|---|
| Over the 20 cap | `ok:false`, the runtime's message verbatim |
| No scheduling form, or several | `ok:false` before send |
| `interval` outside 1..200 | `ok:false` before send |
| `cron_expr` unparseable | `ok:false`, ZCode's message verbatim |
| `update` on a missing id | `ok:false`, `errors:['Scheduled task not found in the current workspace.']` |
| `delete` of an already-deleted id | `ok:true`, `result.deleted:false`, advisory warning |
| Read-back disagrees | `ok:false`, read-back mismatch |

## Permissions

Creating an automation grants **standing, scheduled authority** — it will run prompts unattended. The
`mode` recorded at creation is the authority it will use, so a `yolo` automation is effectively
unattended repository write access. Tool descriptions state this, and callers are advised to create
automations with `mode: 'plan'` or `'build'` and narrow `target_task_id` unless they specifically want
unattended edits.

## Notes

- Scheduled runs appear in ZCode's own logs with `queryId: "automation-<uuid>:<epochMs>"`, so an
  automation's runs can be traced end-to-end through the log join described in
  `data-model.md` §B3.
- Automations are scoped by `workspace_key`, so `list` reflects the workspace of the runtime the call
  resolved to.
