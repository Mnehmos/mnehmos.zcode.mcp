/**
 * `zcode_status` — the state of this server and of ZCode. Read-only.
 *
 * `probe` is the diagnostic entry point and is deliberately cheap: it establishes runtime identity,
 * protocol version, and session count in one round trip without starting a turn.
 */
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';

import type { ServerContext } from '../../context.js';
import { Outcome, localEnvelope, type Envelope } from '../../envelope.js';
import { AuditDb } from '../../storage/db.js';
import { resolveNode, type Discovery } from '../../schema/env.js';
import { discoverRuntime, discoveryFailure } from '../../schema/env.js';
import { warn } from '../../warnings.js';

const execFileAsync = promisify(execFile);

interface SessionListResult {
  sessions?: Array<Record<string, unknown>>;
}

export async function statusDispatch(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Envelope> {
  const action = String(args.action);

  switch (action) {
    case 'runtimes': {
      const runtimes = ctx.liveRuntimes();
      return localEnvelope({ tool: 'zcode_status', action }, runtimes, {
        extra: {
          cap: ctx.env.ZCODE_MCP_MAX_CHILDREN,
          idle_evict_ms: ctx.env.ZCODE_MCP_CHILD_IDLE_MS,
        },
      });
    }

    case 'runs': {
      const limit = typeof args.limit === 'number' ? args.limit : 50;
      if (!ctx.db) {
        return localEnvelope({ tool: 'zcode_status', action }, [], {
          ok: false,
          errors: [ctx.dbError ?? 'audit database unavailable'],
        });
      }
      return localEnvelope({ tool: 'zcode_status', action }, ctx.db.recentRuns(limit));
    }

    case 'doctor': {
      const discovery = discoverRuntime();
      if (!discovery.cli) {
        return localEnvelope({ tool: 'zcode_status', action }, null, {
          ok: false,
          errors: [discoveryFailure(discovery)],
        });
      }
      const runId = AuditDb.newRunId('zcode_status', 'doctor');
      const o = new Outcome({
        tool: 'zcode_status',
        action,
        mode: 'local',
        payloadSource: 'stdout',
        run: { wire: null, settings: null, command: `${resolveNode()} ${discovery.cli} doctor` },
      });
      try {
        const { stdout, stderr } = await execFileAsync(resolveNode(), [discovery.cli, 'doctor'], {
          timeout: 60_000,
          windowsHide: true,
        });
        o.result({ stdout: stdout.trim(), stderr: stderr.trim() });
      } catch (err) {
        o.fail(err instanceof Error ? err.message : String(err));
      }
      const env = o.finalise();
      ctx.record(env, runId);
      return env;
    }

    case 'workspace':
    case 'sessions':
    case 'probe': {
      const workspace = resolveWorkspace(ctx, args);
      if (!workspace) return workspaceRequired('zcode_status', action);

      const runId = AuditDb.newRunId('zcode_status', action);
      const o = new Outcome({
        tool: 'zcode_status',
        action,
        mode: 'child',
        payloadSource: 'protocol',
      });

      let acquired;
      const t0 = Date.now();
      try {
        acquired = await ctx.acquire({ workspacePath: workspace });
      } catch (err) {
        o.fail(err instanceof Error ? err.message : String(err));
        o.method('runtime/acquire', false, Date.now() - t0);
        const env = o.finalise();
        ctx.record(env, runId);
        return env;
      }
      o.method('runtime/acquire', true, Date.now() - t0);
      o.setRuntime(ctx.runtimeIdentity(acquired.runtime));
      o.setRun({
        wire: join(ctx.dirs.wire, '*.ndjson'),
        settings: acquired.runtime.settings.configPath,
        command: acquired.runtime.commandLine,
      });
      for (const w of acquired.runtime.settings.warnings) o.warn(w.code, w.detail, w.impact);
      if (acquired.runtime.keyMismatch) {
        o.warn(
          'workspace_key_mismatch',
          `computed ${acquired.runtime.keyMismatch.computed} but ZCode reported ` +
            `${acquired.runtime.keyMismatch.reported}; ZCode is authoritative`,
          'advisory',
        );
      }
      if (!ctx.db) o.warn('audit_db_unavailable', ctx.dbError ?? 'unavailable', 'degraded');

      const { client } = acquired.runtime;

      if (action === 'workspace' || action === 'probe') {
        const ref = { workspacePath: workspace, workspaceKey: acquired.runtime.workspaceKey };
        const t1 = Date.now();
        try {
          const state = await client.request('workspace/readState', { workspace: ref });
          o.method('workspace/readState', true, Date.now() - t1);
          o.result(state);
        } catch (err) {
          o.method('workspace/readState', false, Date.now() - t1, describe(err));
          o.fail(describe(err));
        }
      }

      if (action === 'sessions' || action === 'probe') {
        const limit = typeof args.limit === 'number' ? args.limit : 50;
        const t2 = Date.now();
        try {
          const res = await client.request<SessionListResult>('session/list', {});
          o.method('session/list', true, Date.now() - t2);
          const sessions = res.sessions ?? [];
          if (action === 'sessions') o.result(sessions.slice(0, limit));
          else {
            const current = (o as unknown as { value?: unknown }).value;
            o.result({
              ...(current && typeof current === 'object' ? (current as object) : {}),
              session_count: sessions.length,
              sessions_sample: sessions.slice(0, Math.min(limit, 5)),
            });
          }
        } catch (err) {
          o.method('session/list', false, Date.now() - t2, describe(err));
          // In probe mode a failed session list is not fatal: workspace state may still be useful.
          if (action === 'sessions') o.fail(describe(err));
          else o.warn('session_list_failed', describe(err), 'degraded');
        }
      }

      o.setStderrTail(acquired.runtime.transport.stderrLines);
      const env = o.finalise();
      ctx.record(env, runId);
      return env;
    }

    default:
      return localEnvelope({ tool: 'zcode_status', action }, null, {
        ok: false,
        errors: [`unknown action: ${action}`],
      });
  }
}

export function resolveWorkspace(ctx: ServerContext, args: Record<string, unknown>): string | null {
  const fromArgs = typeof args.workspace === 'string' ? args.workspace.trim() : '';
  if (fromArgs) return fromArgs;
  const fallback = ctx.env.ZCODE_MCP_WORKSPACE?.trim();
  return fallback && fallback.length > 0 ? fallback : null;
}

export function workspaceRequired(tool: string, action: string): Envelope {
  return localEnvelope({ tool, action }, null, {
    ok: false,
    warnings: [
      warn(
        'provider_not_configured',
        'no workspace was supplied and ZCODE_MCP_WORKSPACE is unset',
        'unreliable',
      ),
    ],
    errors: ['workspace is required: pass `workspace`, or set ZCODE_MCP_WORKSPACE'],
  });
}

// Imported (so the local calls below bind) and re-exported (so the many dispatchers that already
// import it from here keep working). A bare `export ... from` would not create the local binding.
import { describe } from '../errors.js';
export { describe };

/** Re-exported for the self-test so it reports the same discovery outcome as the tools. */
export function discoveryForSelfTest(): Discovery {
  return discoverRuntime();
}

export { existsSync as _existsSync };
