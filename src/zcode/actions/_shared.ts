/**
 * Shared dispatcher scaffolding.
 *
 * Factored out after the third dispatcher repeated it. The interesting logic belongs in each tool;
 * acquiring a runtime, wiring the envelope and recording the audit row does not.
 */
import { join } from 'node:path';

import type { ServerContext, RuntimeContext } from '../../context.js';
import { Outcome, localEnvelope, type Envelope } from '../../envelope.js';
import { AuditDb } from '../../storage/db.js';
import { describe, resolveWorkspace, workspaceRequired } from './status.js';

export { describe, resolveWorkspace, workspaceRequired };

/** Start an Outcome with the usual child/protocol defaults. */
export function outcome(tool: string, action: string, mutates = false): Outcome {
  return new Outcome({ tool, action, mode: 'child', payloadSource: 'protocol', mutates });
}

/** Record the finished envelope and return it. Always call this, even on failure. */
export function finish(ctx: ServerContext, o: Outcome, runId: string): Envelope {
  const env = o.finalise();
  ctx.record(env, runId);
  return env;
}

export function newRunId(tool: string, action: string): string {
  return AuditDb.newRunId(tool, action);
}

/**
 * Acquire a runtime, wiring the envelope's runtime identity and run locations.
 * Returns null after recording a failure, so callers can `if (!acq) return finish(...)`.
 */
export async function acquireOrFail(
  ctx: ServerContext,
  o: Outcome,
  workspace: string,
  runId: string,
): Promise<RuntimeContext | null> {
  const t0 = Date.now();
  try {
    const acq = await ctx.acquire({ workspacePath: workspace });
    o.method('runtime/acquire', true, Date.now() - t0);
    o.setRuntime(ctx.runtimeIdentity(acq.runtime));
    o.setRun({
      wire: join(ctx.dirs.wire, '*.ndjson'),
      settings: acq.runtime.settings.configPath,
      command: acq.runtime.commandLine,
    });
    for (const w of acq.runtime.settings.warnings) o.warn(w.code, w.detail, w.impact);
    if (acq.runtime.keyMismatch) {
      o.warn(
        'workspace_key_mismatch',
        `computed ${acq.runtime.keyMismatch.computed} but ZCode reported ${acq.runtime.keyMismatch.reported}; ZCode is authoritative`,
        'advisory',
      );
    }
    if (!ctx.db) o.warn('audit_db_unavailable', ctx.dbError ?? 'unavailable', 'degraded');
    return acq;
  } catch (err) {
    o.method('runtime/acquire', false, Date.now() - t0, describe(err));
    o.fail(err instanceof Error ? err.message : String(err));
    finish(ctx, o, runId);
    return null;
  }
}

/** A single read-only protocol call, with the method recorded for diagnostics. */
export async function read<T = unknown>(
  o: Outcome,
  runtime: RuntimeContext['runtime'],
  method: string,
  params?: unknown,
): Promise<T> {
  const t = Date.now();
  try {
    const v = await runtime.client.request<T>(method, params ?? {});
    o.method(method, true, Date.now() - t);
    return v;
  } catch (err) {
    o.method(method, false, Date.now() - t, describe(err));
    throw err;
  }
}

/** A single mutating protocol call. Read-back is the caller's responsibility. */
export async function write(
  o: Outcome,
  runtime: RuntimeContext['runtime'],
  method: string,
  params?: unknown,
): Promise<unknown> {
  const t = Date.now();
  try {
    const v = await runtime.client.request(method, params ?? {});
    o.method(method, true, Date.now() - t);
    return v;
  } catch (err) {
    o.method(method, false, Date.now() - t, describe(err));
    throw err;
  }
}

/** A workspace ref built from a live runtime, which is the only source we trust. */
export function refOf(runtime: RuntimeContext['runtime']): { workspacePath: string; workspaceKey: string } {
  return { workspacePath: runtime.workspacePath, workspaceKey: runtime.workspaceKey };
}

/** An envelope for an action that touches nothing — a bad action name, a missing argument. */
export function refuse(tool: string, action: string, error: string, warnCode?: string): Envelope {
  return localEnvelope({ tool, action }, null, {
    ok: false,
    ...(warnCode ? { warnings: [] } : {}),
    errors: [error],
  });
}
