# Contract: shared response envelope

Every tool returns this shape. Envelope keys are the stable contract (Constitution Article III).

```ts
interface Envelope {
  ok: boolean;                       // did the WHOLE operation succeed, as evidenced by a read-back
  tool: string;
  action: string;
  mode: 'local' | 'child' | 'headless';
  runtime: {
    version: string;                 // e.g. "0.16.5"
    protocol: { name: 'ZCode Protocol'; version: 1 };
    transport: 'stdio' | 'websocket';
    workspace_key: string;
  } | null;
  evidence: {
    payload_source: 'protocol' | 'filesystem' | 'stdout' | 'local';
    exit_code: number | null;
    duration_ms: number;
    timed_out: boolean;
    warnings: { code: string; detail: string; impact: 'advisory' | 'degraded' | 'unreliable' }[];
    errors: string[];
  };
  diagnostics: {
    methods: { method: string; ok: boolean; ms: number; error?: string }[];
    stderr_tail: string[];
  };
  result: unknown;                   // the action's own data, verbatim from ZCode where possible
  run: { wire: string; settings: string | null; command: string } | null;
}
```

## Rules

1. **`ok:true` requires evidence.** The tool called a read-back and it agreed with the request
   (Constitution Article II). If no read-back was possible, `ok` MAY still be `true` **only** with a
   `warnings[]` entry whose `impact` is `degraded` or `unreliable`.
2. **`warnings[].impact` is the routing key.** `advisory` — proceed, note it. `degraded` — result is
   usable but incomplete. `unreliable` — do not act on this result.
3. **Protocol outcomes are preserved verbatim** in `result` (`status`, `reasonCode`, `message`), never
   paraphrased. `status:"noop"` is **not** success.
4. **`run` is always populated** for actions that spawned or spoke to a process; `wire` and `command`
   point at real files/strings on disk and are recorded in the audit row.
5. **Secrets are redacted** before the envelope is built (`ZCODE_MCP_REDACT`, default on).
6. `diagnostics.methods` lists every protocol method attempted with its own success flag and latency —
   so a partially-failing composite action is diagnosable.

## Error mapping

| Upstream | `ok` | `evidence.errors[0]` | Extra |
|---|---|---|---|
| `-32700` parse | false | `parse error` | — |
| `-32600` invalid message | false | `invalid protocol message` | `diagnostics` |
| `-32601` method not found | false | `method not found: <m>` | `impact:'degraded'` if from catalog, else `'unreliable'` |
| `-32602` invalid params | false | path-qualified zod message | `impact:'unreliable'` — schema drift, surface loudly |
| `-32603` handler error | false | handler message | zod details preserved |
| `-32004` session unavailable | false | `session unavailable` | — |
| spawn failure / startup timeout | false | transport error | `diagnostics.stderr_tail` |
| transport closed | false | `ZCode agent stdio transport is closed` | runtime marked dead, respawned next call |
| policy refusal | false | `mcp.<guard>.disabled` | — |
| frame limit | false | `payload exceeds 1 MiB; use the attachment path` | no process touched |
