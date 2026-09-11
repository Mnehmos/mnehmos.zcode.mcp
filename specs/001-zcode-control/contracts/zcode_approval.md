# Contract: `zcode_approval`

**Purpose**: answer the agent's approval, input and elicitation requests.
Replaces the requested `zcode.agent.approve` / `zcode.agent.reject`.

Rating **B** (depends on being the attached client).

## Why this tool must exist

Owning a runtime makes this server the runtime's **only** client. ZCode sends it *client requests*:

```
{"id":"server-1","method":"interaction/requestPermission","params":{sessionId,requestId,…}}
{"id":"…","method":"interaction/requestUserInput", …}
{"id":"…","method":"interaction/requestProviderRuntimeHeaders", …}
{"id":"…","method":"interaction/requestOfficialMcpAuthHeaders", …}
{"id":"…","method":"session/requestRuntimePreferences", …}
{"id":"…","method":"interaction/browserList" | "interaction/browserExecute", …}
```

Unanswered, they block the turn. This is the single most likely cause of a "hung" MCP, so the policy
module is implemented in the same phase as `zcode_chat`, not later.

## Actions

| Action | Arguments | Notes |
|---|---|---|
| `policy` | — | current mode, effective allowlist, counters |
| `list` | `session_id?` | pending requests with their details |
| `respond` | `request_id`, `decision`, `reason?`, `modified_input?`, `persist_rule?` | resolves one request |

```ts
zcode_approval({ action: 'policy' })
zcode_approval({ action: 'list', session_id: 'sess_…' })
zcode_approval({ action: 'respond', request_id: 'req_…', decision: 'allow',
                 persist_rule: { behavior: 'allow', rules: [{ tool_name: 'Bash',
                                                              rule_content: 'git *' }] } })
```

## Decision enum

`allow` | `deny` | `escalate` | `modify` — with optional `reason`, `modified_input`, and
`persist_rule: {behavior: allow|deny|ask, rules: [{tool_name, rule_content?}]}`.
The `persist_rule` form is exactly ZCode's own `permissionUpdates:[{type:"addRules",…}]`, so an
approval can carry a durable rule — this is how "always allow this" works in the desktop.

## Policy modes

| `ZCODE_MCP_APPROVAL` | Behaviour |
|---|---|
| `deny` (**default**) | auto-deny; every denial is recorded and visible via `list`/`policy` |
| `allow` | auto-allow — intended only for a sandboxed workspace |
| `ask` | hold pending; a caller resolves it via `respond` |
| allowlist file (`ZCODE_MCP_APPROVAL_ALLOWLIST`) | allow only listed `toolName` / `toolName(ruleContent)` patterns; deny the rest |

Always answered immediately, regardless of mode (they are not authority questions):

| Request | Canned response |
|---|---|
| `session/requestRuntimePreferences` | `{askUserQuestionAutoResolutionEnabled, nativeSearchEnhancementsEnabled, memoryEnabled}` from config |
| `interaction/requestProviderRuntimeHeaders` | headers derived from the configured provider |
| `interaction/browserList` | `{browsers: []}` unless a browser backend is configured |
| `interaction/browserExecute` | `{ok:false, error:{code:"backend_unavailable"}}` unless configured |
| `interaction/requestOfficialMcpAuthHeaders` | `{ok:false, reason:"official_auth_unavailable"}` — this server has no desktop trust validator |

## Failure modes

| Condition | Result |
|---|---|
| `respond` with an unknown/expired `request_id` | `ok:false`, `errors:['request not pending']` — the agent may have cancelled it |
| `persist_rule` without `ZCODE_MCP_ALLOW_PERSIST_RULES=1` | `ok:false`, `reasonCode:'mcp.persist_rules.disabled'` |
| Response send fails (transport closed) | `ok:false`, `errors:['ZCode agent stdio transport is closed']`, runtime marked dead |
| Request answered twice | second call is `ok:false`, `errors:['already resolved']` — requests are single-owner |

## Read-back

After `respond`, the tool confirms the request left the pending set and returns the session's resulting
projection. Because ZCode dedupes pending requests by `(workspace, session, requestId)` and emits
`permission.request` once, a successful respond is observable.

## Permissions

This tool **is** the permission surface. Two guards protect it:

1. The default policy is **deny** (Constitution Article V) — an MCP server does not silently acquire
   the approvals a human would have been asked for in the desktop.
2. `persist_rule` is the only action that changes *future* authority, so it has its own opt-in.

## Notes

- A session observed in status `waiting` with a pending request that nobody answers is a bug in the
  policy module, and the integration suite asserts it does not happen.
- Denied tool calls appear as `tool.updated status:"denied"`, so a caller can see denials in the
  `zcode_chat` result's `tool_calls.denied` count without reading the approval log.
