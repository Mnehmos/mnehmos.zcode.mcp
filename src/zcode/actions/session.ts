/**
 * `zcode_session` — lifecycle and per-session settings.
 *
 * Every mutating action re-reads the session and compares the field it changed. A mismatch FAILS the
 * call: `set_model` that did not change the model must not be reported as success, because the caller
 * will otherwise build on a false premise.
 */
import { join } from 'node:path';

import type { ServerContext } from '../../context.js';
import { Outcome, localEnvelope, type Envelope } from '../../envelope.js';
import { AuditDb } from '../../storage/db.js';
import { describe, resolveWorkspace, workspaceRequired } from './status.js';
import type { RuntimeContext } from '../../context.js';
import type { Runtime } from '../registry.js';

interface SessionRecord {
  sessionId?: string;
  status?: string;
  mode?: string;
  model?: unknown;
  thoughtLevel?: string;
  title?: string;
  titleSource?: string;
  sessionKind?: string;
  workspace?: { workspaceKey?: string; workspacePath?: string };
}

const MUTATING = new Set([
  'create', 'resume', 'close', 'fork', 'compact', 'set_model', 'set_mode', 'set_thought_level', 'goal',
]);

/** Read-only actions do not need a workspace; mutating ones do. */
const NEEDS_WORKSPACE = new Set([...MUTATING, 'list']);

export async function sessionDispatch(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Envelope> {
  const action = String(args.action);
  const runId = AuditDb.newRunId('zcode_session', action);
  const o = new Outcome({
    tool: 'zcode_session',
    action,
    mode: 'child',
    payloadSource: 'protocol',
    mutates: MUTATING.has(action),
  });

  const workspace = resolveWorkspace(ctx, args);
  if (NEEDS_WORKSPACE.has(action) && !workspace) return workspaceRequired('zcode_session', action);
  if (!workspace) {
    return localEnvelope({ tool: 'zcode_session', action }, null, {
      ok: false,
      errors: [
        'a workspace is required to reach a runtime: pass `workspace`, or set ZCODE_MCP_WORKSPACE. ' +
          'A session id alone is not enough, because the runtime is per-workspace.',
      ],
    });
  }

  const acquired = await acquireOrFail(ctx, o, workspace, runId);
  if (!acquired) return finish(ctx, o, runId);
  const { runtime } = acquired;
  o.setRuntime(ctx.runtimeIdentity(runtime));
  o.setRun({
    wire: join(ctx.dirs.wire, '*.ndjson'),
    settings: runtime.settings.configPath,
    command: runtime.commandLine,
  });
  for (const w of runtime.settings.warnings) o.warn(w.code, w.detail, w.impact);

  try {
    switch (action) {
      case 'list':
        return await doList(ctx, o, runtime, args, runId);
      case 'get':
        return await doGet(ctx, o, runtime, sessionIdOf(args), runId);
      case 'create':
        return await doCreate(ctx, o, runtime, workspace, args, runId);
      case 'close':
        return await doSimple(ctx, o, runtime, 'session/close', { sessionId: sessionIdOf(args) }, runId, (after) =>
          readBackField(o, after, 'status', 'closed', (v) => v === undefined || v === 'completed' || v === 'error'),
        );
      case 'compact':
        return await doSimple(
          ctx,
          o,
          runtime,
          'session/compact',
          { sessionId: sessionIdOf(args), ...(typeof args.instructions === 'string' ? { instructions: args.instructions } : {}) },
          runId,
          () => o.readBackUnavailable('the runtime acknowledges compaction but exposes no compacted-token count here'),
        );
      case 'fork':
        return await doFork(ctx, o, runtime, args, runId);
      case 'set_mode':
        return await doSimple(ctx, o, runtime, 'session/setMode', { sessionId: sessionIdOf(args), mode: String(args.mode) }, runId, (after) =>
          readBackField(o, after, 'mode', String(args.mode)),
        );
      case 'set_model':
        return await doSimple(ctx, o, runtime, 'session/setModel', { sessionId: sessionIdOf(args), model: String(args.model) }, runId, (after) =>
          readBackModel(o, after, String(args.model)),
        );
      case 'set_thought_level':
        return await doSimple(
          ctx,
          o,
          runtime,
          'session/setThoughtLevel',
          { sessionId: sessionIdOf(args), thoughtLevel: String(args.thought_level) },
          runId,
          (after) => readBackField(o, after, 'thoughtLevel', String(args.thought_level)),
        );
      case 'resume':
        return await doSimple(
          ctx,
          o,
          runtime,
          'session/resume',
          {
            sessionId: sessionIdOf(args),
            workspace: workspaceRef(runtime),
            ...(typeof args.model === 'string' ? { model: args.model } : {}),
            ...(typeof args.thought_level === 'string' ? { thoughtLevel: args.thought_level } : {}),
          },
          runId,
          (after) => readBackField(o, after, 'status', undefined, (v) => typeof v === 'string'),
        );
      case 'goal':
        return await doGoal(ctx, o, runtime, args, runId);
      case 'subagents':
        return await doSimple(ctx, o, runtime, 'session/subagents', { sessionId: sessionIdOf(args) }, runId, null);
      case 'usage':
        return await doSimple(ctx, o, runtime, 'session/usage', { sessionId: sessionIdOf(args) }, runId, null);
      default:
        o.fail(`unknown action: ${action}`);
        return finish(ctx, o, runId);
    }
  } catch (err) {
    o.fail(describe(err));
    o.setStderrTail(runtime.transport.stderrLines);
    return finish(ctx, o, runId);
  }
}

/**
 * Pull a session id out of a create/fork response.
 *
 * ZCode wraps results inconsistently across methods, so accept the shapes we have actually seen
 * rather than assuming one — and the caller is told the raw response when none of them match.
 */
export function extractSessionId(res: unknown): string | null {
  if (!res || typeof res !== 'object') return null;
  const r = res as Record<string, unknown>;
  const direct = ['sessionId', 'session_id', 'id'];
  for (const k of direct) if (typeof r[k] === 'string') return r[k] as string;
  for (const k of ['session', 'result', 'data']) {
    const nested = r[k];
    if (nested && typeof nested === 'object') {
      const got = extractSessionId(nested);
      if (got) return got;
    }
  }
  return null;
}

function sessionIdOf(args: Record<string, unknown>): string {
  return typeof args.session_id === 'string' ? args.session_id : '';
}

function workspaceRef(runtime: Runtime): { workspacePath: string; workspaceKey: string } {
  return { workspacePath: runtime.workspacePath, workspaceKey: runtime.workspaceKey };
}

async function doList(
  ctx: ServerContext,
  o: Outcome,
  runtime: Runtime,
  args: Record<string, unknown>,
  runId: string,
): Promise<Envelope> {
  const t = Date.now();
  const res = await runtime.client.request<{ sessions?: SessionRecord[] }>('session/list', {});
  o.method('session/list', true, Date.now() - t);
  const all = res.sessions ?? [];
  const limit = typeof args.limit === 'number' ? args.limit : 50;
  const filtered = all.filter((s) => !s.workspace?.workspaceKey || s.workspace.workspaceKey === runtime.workspaceKey);
  o.result(filtered.slice(0, limit));
  return finish(ctx, o, runId);
}

async function doGet(
  ctx: ServerContext,
  o: Outcome,
  runtime: Runtime,
  sessionId: string,
  runId: string,
): Promise<Envelope> {
  if (!sessionId) {
    o.fail('session_id is required');
    return finish(ctx, o, runId);
  }
  const t = Date.now();
  const res = await runtime.client.request('session/read', { sessionId });
  o.method('session/read', true, Date.now() - t);
  o.result(res);
  return finish(ctx, o, runId);
}

async function doCreate(
  ctx: ServerContext,
  o: Outcome,
  runtime: Runtime,
  workspace: string,
  args: Record<string, unknown>,
  runId: string,
): Promise<Envelope> {
  const params: Record<string, unknown> = { workspace: { workspacePath: workspace, workspaceKey: runtime.workspaceKey } };
  if (typeof args.mode === 'string') params.mode = args.mode;
  if (typeof args.model === 'string') params.model = args.model;
  if (typeof args.thought_level === 'string') params.thoughtLevel = args.thought_level;
  if (Array.isArray(args.mcp_servers)) params.mcpServers = args.mcp_servers;
  if (typeof args.title_generation === 'boolean') params.titleGenerationEnabled = args.title_generation;
  // This is where an allowlist belongs — it is session-scoped, unlike the per-command denylist.
  if (Array.isArray(args.tool_allowlist)) params.toolAllowlist = args.tool_allowlist;
  // CONFIRMED by probing the runtime's own validator: this field accepts "immediate" | "deferred".
  // Omitting it left the session unpersisted, so the FIRST turn failed with a SQLite
  // "FOREIGN KEY constraint failed" — session_input references session(id), and there was no row.
  // Defaulting to "immediate" makes the session exist on disk before anything is sent to it.
  params.persistence = typeof args.persistence === 'string' ? args.persistence : 'immediate';

  const t = Date.now();
  const created = await runtime.client.request<SessionRecord>('session/create', params);
  o.method('session/create', true, Date.now() - t);

  const newId = extractSessionId(created);
  if (!newId) {
    // Report what actually came back rather than only that we could not read it: the response shape
    // is the thing a reader needs, and hiding it turns a schema question into a mystery.
    o.fail(
      `session/create returned no sessionId, so the session cannot be confirmed. ` +
        `Response was: ${JSON.stringify(created).slice(0, 500)}`,
    );
    o.result(created);
    return finish(ctx, o, runId);
  }

  // Read back by LISTING rather than by reading the session.
  //
  // `session/read` returns a snapshot whose sessionId is nested (and whose projection reports
  // "unknown" for a session that has not run a turn yet), so comparing against its top level
  // produced a false mismatch on a create that had actually succeeded. Appearing in the list is
  // shape-independent and is the thing that matters: the session was persisted and is addressable.
  try {
    const t2 = Date.now();
    const listed = await runtime.client.request<{ sessions?: Array<Record<string, unknown>> }>('session/list', {});
    o.method('session/list', true, Date.now() - t2);
    const found = (listed?.sessions ?? []).some((x) => extractSessionId(x) === newId);
    o.readBack(found, found ? undefined : `created ${newId} but it does not appear in session/list`);

    // Mode is reported, not asserted: the snapshot's projection carries defaults until a turn runs,
    // so a difference here is not evidence the create failed.
    const rec = (listed?.sessions ?? []).find((x) => extractSessionId(x) === newId);
    const observedMode = typeof rec?.mode === 'string' ? rec.mode : null;
    o.result({ session_id: newId, mode: observedMode, requested_mode: params.mode ?? null, session: rec ?? null });
    if (params.mode && observedMode && observedMode !== params.mode) {
      o.warn(
        'mode_not_applied',
        `requested mode "${String(params.mode)}" but the session reports "${observedMode}". The session ` +
          'exists; set the mode explicitly with zcode_session set_mode if it matters.',
        'degraded',
      );
    }
  } catch (err) {
    o.method('session/list', false, 0, describe(err));
    o.fail(`session ${newId} was created but could not be confirmed: ${describe(err)}`);
    o.result({ session_id: newId });
  }
  return finish(ctx, o, runId);
}

async function doFork(
  ctx: ServerContext,
  o: Outcome,
  runtime: Runtime,
  args: Record<string, unknown>,
  runId: string,
): Promise<Envelope> {
  const params: Record<string, unknown> = { sessionId: sessionIdOf(args) };
  if (typeof args.checkpoint_id === 'string') params.checkpointId = args.checkpoint_id;
  const t = Date.now();
  const res = await runtime.client.request<SessionRecord>('session/fork', params);
  o.method('session/fork', true, Date.now() - t);
  const newId = typeof res?.sessionId === 'string' ? res.sessionId : null;
  if (newId) {
    o.readBack(true, `forked to ${newId}`);
    o.result(res);
  } else {
    o.readBackUnavailable('fork returned no sessionId; the fork may or may not have been created');
    o.result(res);
  }
  return finish(ctx, o, runId);
}

async function doGoal(
  ctx: ServerContext,
  o: Outcome,
  runtime: Runtime,
  args: Record<string, unknown>,
  runId: string,
): Promise<Envelope> {
  const goalAction = String(args.goal_action);
  const params: Record<string, unknown> = { sessionId: sessionIdOf(args), action: goalAction };
  if (typeof args.objective === 'string') params.objective = args.objective;

  const t = Date.now();
  const res = await runtime.client.request('session/goal', params);
  o.method('session/goal', true, Date.now() - t);
  o.result(res);

  // Read the projection back: `target` is where the goal actually lives.
  try {
    const read = await runtime.client.request<{ projection?: { target?: unknown } }>('session/read', {
      sessionId: sessionIdOf(args),
    });
    const target = read?.projection?.target ?? null;
    if (goalAction === 'clear') {
      o.readBack(target === null, target === null ? undefined : 'goal still present after clear');
    } else {
      o.readBack(target !== null, target === null ? 'goal not present after set' : undefined);
    }
  } catch (err) {
    o.readBackUnavailable(`could not read the projection back: ${describe(err)}`);
  }
  return finish(ctx, o, runId);
}

/** One request plus an optional read-back callback. */
async function doSimple(
  ctx: ServerContext,
  o: Outcome,
  runtime: Runtime,
  method: string,
  params: Record<string, unknown>,
  runId: string,
  readBack: ((after: SessionRecord) => void) | null,
): Promise<Envelope> {
  if (!params.sessionId) {
    o.fail('session_id is required');
    return finish(ctx, o, runId);
  }
  const t = Date.now();
  let ack: unknown;
  try {
    ack = await runtime.client.request(method, params);
    o.method(method, true, Date.now() - t);
  } catch (err) {
    o.method(method, false, Date.now() - t, describe(err));
    o.fail(describe(err));
    return finish(ctx, o, runId);
  }
  o.result(ack);

  if (readBack) {
    try {
      const t2 = Date.now();
      const after = await runtime.client.request<SessionRecord>('session/read', { sessionId: params.sessionId });
      o.method('session/read', true, Date.now() - t2);
      readBack(after);
    } catch (err) {
      o.method('session/read', false, 0, describe(err));
      o.readBackUnavailable(`the action was accepted but could not be read back: ${describe(err)}`);
    }
  } else {
    o.readBackUnavailable('this action has no read-back; ZCode acknowledges it without echoing state');
  }
  return finish(ctx, o, runId);
}

/** Compare one field after a mutation. `expected === undefined` means "any value of the right type". */
function readBackField(
  o: Outcome,
  after: SessionRecord,
  field: keyof SessionRecord,
  expected: string | undefined,
  predicate?: (v: unknown) => boolean,
): void {
  const observed = after?.[field];
  if (expected === undefined) {
    const ok = predicate ? predicate(observed) : observed !== undefined;
    o.readBack(ok, ok ? undefined : `${String(field)} was not observable after the change`);
    return;
  }
  const ok = observed === expected;
  o.readBack(ok, ok ? undefined : `requested ${String(field)}=${expected}, observed ${JSON.stringify(observed)}`);
}

/** Model is nested in some responses, so compare its stringified form. */
function readBackModel(o: Outcome, after: SessionRecord, requested: string): void {
  const seen = JSON.stringify(after?.model ?? null);
  const ok = seen.includes(requested);
  o.readBack(ok, ok ? undefined : `requested model ${requested}, observed ${seen.slice(0, 200)}`);
}

async function acquireOrFail(
  ctx: ServerContext,
  o: Outcome,
  workspace: string,
  runId: string,
): Promise<RuntimeContext | null> {
  const t0 = Date.now();
  try {
    const acquired = await ctx.acquire({ workspacePath: workspace });
    o.method('runtime/acquire', true, Date.now() - t0);
    return acquired;
  } catch (err) {
    o.method('runtime/acquire', false, Date.now() - t0, describe(err));
    o.fail(err instanceof Error ? err.message : String(err));
    finish(ctx, o, runId);
    return null;
  }
}

function finish(ctx: ServerContext, o: Outcome, runId: string): Envelope {
  const env = o.finalise();
  ctx.record(env, runId);
  return env;
}
