/**
 * `zcode_approval` — the caller's control over the authority boundary.
 *
 * With `ZCODE_MCP_APPROVAL=ask`, permission and user-input requests are parked here rather than
 * answered by policy. `list` shows what is waiting; `respond` resolves one.
 *
 * `respond` is the only action that can change FUTURE authority (`persist_rule`), which is why it is
 * gated separately by ZCODE_MCP_ALLOW_PERSIST_RULES.
 */
import type { ServerContext } from '../../context.js';
import { Outcome, localEnvelope, type Envelope } from '../../envelope.js';
import { AuditDb } from '../../storage/db.js';
import { describe, resolveWorkspace, workspaceRequired } from './status.js';

export async function approvalDispatch(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Envelope> {
  const action = String(args.action);

  // `policy` can answer without a runtime: it is a statement about configuration.
  if (action === 'policy') {
    const runtimes = ctx.liveRuntimes();
    const policies = runtimes.map((r) => {
      const p = ctx.peek(r.workspace_key)?.policy;
      return { workspace_key: r.workspace_key, ...(p ? p.config : {}) };
    });
    return localEnvelope({ tool: 'zcode_approval', action }, {
      // The default mode is stated even before any runtime exists, because it is the answer to
      // "what happens if something asks for permission right now".
      default_mode: ctx.env.ZCODE_MCP_APPROVAL,
      allow_persist_rules: ctx.env.ZCODE_MCP_ALLOW_PERSIST_RULES === '1',
      configured_allow_patterns:
        (ctx.env.ZCODE_MCP_APPROVAL_ALLOWLIST ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      runtimes: policies,
    });
  }

  const workspace = resolveWorkspace(ctx, args);
  if (!workspace) return workspaceRequired('zcode_approval', action);

  const runId = AuditDb.newRunId('zcode_approval', action);
  const o = new Outcome({
    tool: 'zcode_approval',
    action,
    mode: 'child',
    payloadSource: 'protocol',
    mutates: action === 'respond',
  });

  const t0 = Date.now();
  let acquired;
  try {
    acquired = await ctx.acquire({ workspacePath: workspace });
    o.method('runtime/acquire', true, Date.now() - t0);
  } catch (err) {
    o.method('runtime/acquire', false, Date.now() - t0, describe(err));
    o.fail(err instanceof Error ? err.message : String(err));
    const env = o.finalise();
    ctx.record(env, runId);
    return env;
  }
  const { runtime, policy } = acquired;
  o.setRuntime(ctx.runtimeIdentity(runtime));
  o.setRun({ wire: null, settings: runtime.settings.configPath, command: runtime.commandLine });

  try {
    if (action === 'list') {
      const sessionFilter = typeof args.session_id === 'string' ? args.session_id : null;
      const pending = policy.pending().filter((p) => !sessionFilter || p.sessionId === sessionFilter);
      o.result({ mode: policy.config.mode, pending, counters: policy.config.counters });
      o.readBackUnavailable('pending requests are read from the live policy, not from ZCode state');
      return finish(ctx, o, runId);
    }

    if (action === 'respond') {
      const requestId = typeof args.request_id === 'string' ? args.request_id : '';
      if (!requestId) {
        o.fail('request_id is required');
        return finish(ctx, o, runId);
      }
      const decision = String(args.decision) as 'allow' | 'deny' | 'escalate' | 'modify';
      const persist = args.persist_rule as
        | { behavior: 'allow' | 'deny' | 'ask'; rules: Array<{ tool_name: string; rule_content?: string }> }
        | undefined;

      const before = policy.pending().length;
      const res = await policy.resolve(requestId, decision, runtime.client, {
        ...(typeof args.reason === 'string' ? { reason: args.reason } : {}),
        ...(args.modified_input !== undefined ? { modifiedInput: args.modified_input } : {}),
        ...(persist ? { persistRule: persist } : {}),
      });
      o.method('policy/respond', res.ok, 0, res.error);

      if (!res.ok) {
        o.fail(res.error ?? 'the policy refused to resolve the request');
        return finish(ctx, o, runId);
      }

      // Read back: the request must have left the pending set.
      const after = policy.pending().length;
      o.readBack(after < before, after < before ? undefined : 'request is still pending after responding');
      o.result({ request_id: requestId, decision, pending_before: before, pending_after: after });
      if (persist) {
        o.warn(
          'durable_rule_persisted',
          'a durable permission rule was written into the runtime; it will apply to future turns, not just this one',
          'advisory',
        );
      }
      return finish(ctx, o, runId);
    }

    o.fail(`unknown action: ${action}`);
    return finish(ctx, o, runId);
  } catch (err) {
    o.fail(describe(err));
    return finish(ctx, o, runId);
  }
}

function finish(ctx: ServerContext, o: Outcome, runId: string): Envelope {
  const env = o.finalise();
  ctx.record(env, runId);
  return env;
}
