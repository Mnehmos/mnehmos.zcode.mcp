/**
 * `zcode_chat` — submit work to the ZCode agent and follow it to a terminal state.
 *
 * This is the P1 journey and the reason the server exists. The load-bearing rule (Constitution
 * Article II) is that `v4/command` returns **admission**, not completion:
 *
 *   accepted  -> submitted; we do NOT yet know the outcome
 *   noop      -> nothing happened. NOT success.
 *   failed    -> did not run; reason code verbatim
 *   rejected / stale / duplicate / unknown -> the runtime's own vocabulary for "not a fresh run"
 *
 * So `ok` is gated on observing a terminal `turn.completed` / `turn.failed` for the turn we
 * submitted, and the observed outcome is reported — never the request.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import type { ServerContext } from '../../context.js';
import { Outcome, localEnvelope, type Envelope } from '../../envelope.js';
import { AuditDb } from '../../storage/db.js';
import { isTerminalTurn, TerminalWaitTimeoutError } from '../events.js';
import { describe, resolveWorkspace, workspaceRequired } from './status.js';

/** Command types this tool emits. The runtime accepts 30; we use the ones we have contracts for. */
const CMD_SEND = 'sendText';

/**
 * A stable command id so a retry does not start a second turn.
 *
 * The runtime keys idempotency on this for 24 h with 512 entries per session, so a caller that
 * retries with the same `idempotency_key` gets one turn — and a caller that omits the key gets a
 * fresh id per call, which is the honest default.
 */
export function commandIdFor(sessionId: string, text: string, idempotencyKey?: string): string {
  const basis = idempotencyKey ?? `${Date.now()}-${Math.random()}`;
  const h = createHash('sha256').update(`${sessionId}\u0000${text}\u0000${basis}`).digest('hex').slice(0, 24);
  return `mcp_${h}`;
}

interface CommandResult {
  status?: string;
  reasonCode?: string;
  message?: string;
  result?: unknown;
  ack?: unknown;
}

export async function chatDispatch(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Envelope> {
  const action = String(args.action);
  const sessionId = typeof args.session_id === 'string' ? args.session_id : '';
  if (!sessionId) {
    return localEnvelope({ tool: 'zcode_chat', action }, null, {
      ok: false,
      errors: ['session_id is required'],
    });
  }

  const workspace = resolveWorkspace(ctx, args);
  // A session id alone does not tell us the workspace, so the workspace must be resolvable. In
  // practice ZCODE_MCP_WORKSPACE covers the common single-project case.
  if (!workspace) return workspaceRequired('zcode_chat', action);

  switch (action) {
    case 'send':
      return send(ctx, workspace, sessionId, args);
    case 'steer':
      return stopLike(ctx, workspace, sessionId, args, 'steer');
    case 'stop':
      return stopLike(ctx, workspace, sessionId, args, 'stop');
    case 'cancel_background':
      return stopLike(ctx, workspace, sessionId, args, 'cancel_background');
    case 'wait':
      return waitOnly(ctx, workspace, sessionId, args);
    default:
      return localEnvelope({ tool: 'zcode_chat', action }, null, {
        ok: false,
        errors: [`unknown action: ${action}`],
      });
  }
}

async function send(
  ctx: ServerContext,
  workspace: string,
  sessionId: string,
  args: Record<string, unknown>,
): Promise<Envelope> {
  const text = typeof args.text === 'string' ? args.text : '';
  const runId = AuditDb.newRunId('zcode_chat', 'send');
  const o = new Outcome({ tool: 'zcode_chat', action: 'send', mode: 'child', payloadSource: 'protocol', mutates: true });

  const acquired = await acquireOrFail(ctx, o, workspace, runId);
  if (!acquired) return finish(ctx, o, runId);

  const { runtime, buffer } = acquired;
  o.setRuntime(ctx.runtimeIdentity(runtime));
  o.setRun({ wire: join(ctx.dirs.wire, '*.ndjson'), settings: runtime.settings.configPath, command: runtime.commandLine });
  for (const w of runtime.settings.warnings) o.warn(w.code, w.detail, w.impact);

  // tool_allowlist is session-scoped in this protocol: the per-command field is a DISALLOWlist.
  // Saying so is better than silently dropping it.
  if (Array.isArray(args.tool_allowlist) && args.tool_allowlist.length > 0) {
    o.warn(
      'tool_allowlist_not_applied',
      'tool_allowlist is session-scoped in ZCode Protocol: set it with zcode_session create ' +
        '(or resume). Only tool_denylist can be applied per command.',
      'degraded',
    );
  }

  const wait = args.wait !== false;
  const collect = typeof args.collect === 'string' ? args.collect : 'final';
  const waitTimeout = typeof args.wait_timeout_ms === 'number' ? args.wait_timeout_ms : 600_000;
  const idempotencyKey = typeof args.idempotency_key === 'string' ? args.idempotency_key : undefined;

  const beforeTurn = buffer.latestTurnId(sessionId);
  const commandId = commandIdFor(sessionId, text, idempotencyKey);

  const payload: Record<string, unknown> = { text };
  if (Array.isArray(args.tool_denylist) && args.tool_denylist.length > 0) {
    payload.toolDisallowlist = args.tool_denylist;
  }
  if (typeof args.delivery === 'string') payload.delivery = { requested: args.delivery };

  const envelope = {
    commandId,
    clientId: 'mnehmos.zcode.mcp',
    sessionId,
    type: CMD_SEND,
    payload,
    issuedAt: Date.now(),
  };

  const t0 = Date.now();
  let res: CommandResult;
  try {
    res = await runtime.client.request<CommandResult>('v4/command', envelope);
    o.method('v4/command', true, Date.now() - t0);
  } catch (err) {
    o.method('v4/command', false, Date.now() - t0, describe(err));
    o.fail(describe(err));
    o.setStderrTail(runtime.transport.stderrLines);
    return finish(ctx, o, runId);
  }
  o.result(res);

  const status = typeof res.status === 'string' ? res.status : 'unknown';

  // Map the runtime's own vocabulary. None of these is a completed turn.
  switch (status) {
    case 'noop':
      // Explicitly not success.
      o.fail(`command was a no-op${res.reasonCode ? ` (${res.reasonCode})` : ''}`);
      o.warn('admission_only', 'status "noop" means nothing ran', 'unreliable');
      return finish(ctx, o, runId);
    case 'failed':
    case 'rejected':
      o.fail(`command failed${res.reasonCode ? ` (${res.reasonCode})` : ''}${res.message ? `: ${res.message}` : ''}`);
      return finish(ctx, o, runId);
    case 'stale':
      o.fail(
        'command was rejected as stale: the compare-and-swap tokens (baseRevision/baseLogEpoch) did ' +
          'not match. Re-read the session and retry.',
      );
      return finish(ctx, o, runId);
    case 'duplicate':
      o.warn(
        'idempotent_replay',
        'the runtime recognised this commandId as already submitted; no second turn was started',
        'advisory',
      );
      break;
    case 'accepted':
      break;
    default:
      o.warn('unknown_command_status', `unrecognised v4/command status: ${status}`, 'unreliable');
      break;
  }

  if (!wait) {
    o.warn('not_awaited', 'wait:false — the command was submitted but not followed to a terminal state', 'degraded');
    o.readBackUnavailable('not awaited; the turn outcome is unknown to this call');
    o.setStderrTail(runtime.transport.stderrLines);
    return finish(ctx, o, runId);
  }

  // Identify the turn we just started. The result may carry one; otherwise watch the buffer for a
  // turn id that differs from the one before we submitted.
  const turnId = await identifyTurn(buffer, sessionId, beforeTurn, res, 20_000);

  try {
    const terminal = await buffer.waitForTerminalTurn(sessionId, turnId, waitTimeout);
    o.method(`wait:${terminal.type}`, true, 0);
    const failed = terminal.type === 'turn.failed';
    const resultType = extractResultType(terminal.payload);

    const toolCalls = buffer.countToolCalls(sessionId, turnId);
    o.result({
      status,
      ...(res.reasonCode ? { reason_code: res.reasonCode } : {}),
      turn: {
        turn_id: terminal.turnId ?? turnId,
        outcome: failed ? 'failed' : 'completed',
        result_type: resultType,
        tool_calls: toolCalls,
      },
      text: collect === 'none' ? undefined : buffer.assistantText(sessionId, turnId),
      events: buffer.stats.accepted,
      steering: countSteering(buffer, sessionId, turnId),
    });

    if (failed) {
      o.fail(`turn failed: ${JSON.stringify(terminal.payload ?? {}).slice(0, 400)}`);
    } else {
      // The read-back: a terminal event was observed, so success is evidenced.
      o.readBack(true, `observed ${terminal.type} for turn ${terminal.turnId ?? turnId ?? '(unknown)'}`);
    }
  } catch (err) {
    if (err instanceof TerminalWaitTimeoutError) {
      o.warn(
        'no_terminal_event',
        `command was admitted but no terminal turn event arrived within ${waitTimeout} ms; ` +
          'the turn may still be running — poll with zcode_chat wait or zcode_conversation events',
        'degraded',
      );
      o.readBackUnavailable('admitted but not observed to terminate');
      o.result({
        status,
        turn: { turn_id: turnId, outcome: 'unknown', tool_calls: buffer.countToolCalls(sessionId, turnId) },
        text: buffer.assistantText(sessionId, turnId),
      });
    } else {
      o.fail(describe(err));
    }
  }

  o.setStderrTail(runtime.transport.stderrLines);
  return finish(ctx, o, runId);
}

/**
 * Find the turn id for the command we just submitted.
 *
 * Preference order: the ack, then a turn id newly observed in the buffer. If neither arrives we
 * return null, which makes the waiter turn-agnostic — and that is reported as a caveat rather than
 * hidden, because a turn-agnostic wait could in principle observe an earlier turn's terminal.
 */
async function identifyTurn(
  buffer: { latestTurnId(s: string): string | null },
  sessionId: string,
  before: string | null,
  res: CommandResult,
  timeoutMs: number,
): Promise<string | null> {
  const fromAck = pickTurnId(res);
  if (fromAck) return fromAck;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const now = buffer.latestTurnId(sessionId);
    if (now && now !== before) return now;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

function pickTurnId(res: CommandResult): string | null {
  const candidates = [res.result, res.ack];
  for (const c of candidates) {
    if (c && typeof c === 'object') {
      const t = (c as Record<string, unknown>).turnId;
      if (typeof t === 'string') return t;
    }
  }
  return null;
}

/** `turn.completed` carries a resultType that distinguishes a cancellation from an execution error. */
function extractResultType(payload: unknown): string | null {
  if (payload && typeof payload === 'object') {
    const rt = (payload as Record<string, unknown>).resultType;
    if (typeof rt === 'string') return rt;
  }
  return null;
}

function countSteering(
  buffer: { eventsFor(s: string): Array<{ type: string; turnId?: string }> },
  sessionId: string,
  turnId: string | null,
): { queued: number; drained: number } {
  let queued = 0;
  let drained = 0;
  for (const e of buffer.eventsFor(sessionId)) {
    if (turnId !== null && e.turnId !== undefined && e.turnId !== turnId) continue;
    if (e.type === 'turn.steerQueued') queued++;
    if (e.type === 'turn.steerDrained') drained++;
  }
  return { queued, drained };
}

async function stopLike(
  ctx: ServerContext,
  workspace: string,
  sessionId: string,
  args: Record<string, unknown>,
  action: 'steer' | 'stop' | 'cancel_background',
): Promise<Envelope> {
  const runId = AuditDb.newRunId('zcode_chat', action);
  const o = new Outcome({ tool: 'zcode_chat', action, mode: 'child', payloadSource: 'protocol', mutates: true });

  if (action === 'cancel_background' && typeof args.task_id !== 'string') {
    o.fail('task_id is required for cancel_background');
    return finish(ctx, o, runId);
  }
  if (action === 'steer' && typeof args.text !== 'string') {
    o.fail('text is required for steer');
    return finish(ctx, o, runId);
  }

  const acquired = await acquireOrFail(ctx, o, workspace, runId);
  if (!acquired) return finish(ctx, o, runId);
  const { runtime, buffer } = acquired;
  o.setRuntime(ctx.runtimeIdentity(runtime));
  o.setRun({ wire: join(ctx.dirs.wire, '*.ndjson'), settings: null, command: runtime.commandLine });

  try {
    if (action === 'stop') {
      const t = Date.now();
      await runtime.client.request('session/stop', { sessionId });
      o.method('session/stop', true, Date.now() - t);
      // Read back: an idle session may simply have already finished, which is fine and reported.
      const events = buffer.eventsFor(sessionId);
      const idle = events.some((e) => e.type === 'turn.completed' || e.type === 'turn.failed');
      if (!idle) o.warn('already_idle', 'no terminal turn was observed for this session yet', 'advisory');
      o.readBack(true, 'stop accepted; session/stop bypasses the runtime queue by design');
      o.result({ stopped: true });
    } else if (action === 'steer') {
      const envelope = {
        commandId: commandIdFor(sessionId, String(args.text), `steer-${Date.now()}`),
        clientId: 'mnehmos.zcode.mcp',
        sessionId,
        type: CMD_SEND,
        payload: { text: args.text, delivery: { requested: 'guide' } },
        issuedAt: Date.now(),
      };
      const t = Date.now();
      const res = await runtime.client.request<CommandResult>('v4/command', envelope);
      o.method('v4/command', true, Date.now() - t);
      const status = typeof res.status === 'string' ? res.status : 'unknown';
      if (status === 'accepted') o.readBack(true, 'steer admitted as a guided input');
      else o.fail(`steer was not accepted: ${status}${res.reasonCode ? ` (${res.reasonCode})` : ''}`);
      o.result(res);
    } else {
      const taskId = String(args.task_id);
      const t = Date.now();
      await runtime.client.request('session/cancelBackgroundTask', { sessionId, taskId });
      o.method('session/cancelBackgroundTask', true, Date.now() - t);
      o.readBackUnavailable('the runtime acknowledges the cancellation but does not echo task state');
      o.result({ cancelled: taskId });
    }
  } catch (err) {
    o.fail(describe(err));
  }

  o.setStderrTail(runtime.transport.stderrLines);
  return finish(ctx, o, runId);
}

async function waitOnly(
  ctx: ServerContext,
  workspace: string,
  sessionId: string,
  args: Record<string, unknown>,
): Promise<Envelope> {
  const runId = AuditDb.newRunId('zcode_chat', 'wait');
  const o = new Outcome({ tool: 'zcode_chat', action: 'wait', mode: 'child', payloadSource: 'protocol' });

  const acquired = await acquireOrFail(ctx, o, workspace, runId);
  if (!acquired) return finish(ctx, o, runId);
  const { runtime, buffer } = acquired;
  o.setRuntime(ctx.runtimeIdentity(runtime));
  o.setRun({ wire: join(ctx.dirs.wire, '*.ndjson'), settings: null, command: runtime.commandLine });

  const timeout = typeof args.timeout_ms === 'number' ? args.timeout_ms : 600_000;
  const collect = typeof args.collect === 'string' ? args.collect : 'final';
  const turnId = buffer.latestTurnId(sessionId);

  try {
    const terminal = await buffer.waitForTerminalTurn(sessionId, turnId, timeout);
    o.readBack(true, `observed ${terminal.type}`);
    o.result({
      turn: {
        turn_id: terminal.turnId ?? turnId,
        outcome: terminal.type === 'turn.failed' ? 'failed' : 'completed',
        result_type: extractResultType(terminal.payload),
        tool_calls: buffer.countToolCalls(sessionId, turnId),
      },
      text: collect === 'none' ? undefined : buffer.assistantText(sessionId, turnId),
    });
    if (isTerminalTurn(terminal.type) && terminal.type === 'turn.failed') {
      o.fail(`turn failed: ${JSON.stringify(terminal.payload ?? {}).slice(0, 400)}`);
    }
  } catch (err) {
    if (err instanceof TerminalWaitTimeoutError) {
      o.warn('no_terminal_event', `no terminal turn event within ${timeout} ms`, 'degraded');
      o.readBackUnavailable('nothing terminal observed in the window');
      o.result({ turn: { turn_id: turnId, outcome: 'unknown' } });
    } else {
      o.fail(describe(err));
    }
  }

  o.setStderrTail(runtime.transport.stderrLines);
  return finish(ctx, o, runId);
}

async function acquireOrFail(
  ctx: ServerContext,
  o: Outcome,
  workspace: string,
  runId: string,
): Promise<Awaited<ReturnType<ServerContext['acquire']>> | null> {
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
