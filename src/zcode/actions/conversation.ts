/**
 * `zcode_conversation` — read a conversation: rows, messages, events, plans, usage.
 *
 * The row is the addressable unit, not the message. `rowsRange` returns a window (default 60, max
 * 200) and is the only source that carries row ids, which is what the diff tools need.
 *
 * `events` reads the notification buffer this server has collected. **That buffer is only
 * populated for sessions this server subscribed to** — see A21/A22. Reading events for a session
 * the desktop is driving will legitimately return nothing, and the result says so rather than
 * implying the session is quiet.
 */
import type { ServerContext } from '../../context.js';
import type { Envelope } from '../../envelope.js';
import { acquireOrFail, describe, finish, newRunId, outcome, read, resolveWorkspace, workspaceRequired } from './_shared.js';
import { withStaleRetry, isStale, tokensFromRowWindow } from '../logtokens.js';
import { isMethodNotFound } from '../protocol.js';

export async function conversationDispatch(ctx: ServerContext, args: Record<string, unknown>): Promise<Envelope> {
  const action = String(args.action);
  const runId = newRunId('zcode_conversation', action);
  const o = outcome('zcode_conversation', action);

  const sessionId = typeof args.session_id === 'string' ? args.session_id : '';
  if (!sessionId) {
    o.fail('session_id is required');
    return finish(ctx, o, runId);
  }
  const workspace = resolveWorkspace(ctx, args);
  if (!workspace) return workspaceRequired('zcode_conversation', action);

  const acq = await acquireOrFail(ctx, o, workspace, runId);
  if (!acq) return finish(ctx, o, runId);
  const { runtime, buffer } = acq;

  try {
    switch (action) {
      case 'rows': {
        const limit = typeof args.limit === 'number' ? args.limit : 60;
        const params: Record<string, unknown> = { sessionId, limit };
        if (typeof args.before_row_id === 'string') params.beforeRowId = args.before_row_id;

        const { value, recoveredFromStale } = await withStaleRetry(
          o,
          runtime,
          'rowsRange',
          () => read<{ rows?: unknown[]; atLogEpoch?: string; atSeq?: number; hasMore?: boolean }>(o, runtime, 'v4/conversation/rowsRange', params),
          async () => null,
        );
        // The runtime's own names, verbatim. `atLogEpoch`/`atSeq` are what the diff tools need as
        // `baseLogEpoch`/`baseRevision`, so a caller can thread them through without guessing.
        o.result({
          rows: value?.rows ?? [],
          count: (value?.rows ?? []).length,
          limit,
          at_log_epoch: value?.atLogEpoch ?? null,
          at_seq: value?.atSeq ?? null,
          has_more: value?.hasMore ?? false,
          tokens: tokensFromRowWindow(value),
          recovered_from_stale: recoveredFromStale,
        });
        o.readOnly();
        break;
      }

      case 'messages': {
        const value = await read(o, runtime, 'session/messages', { sessionId });
        o.result(value);
        o.readOnly();
        break;
      }

      case 'plans': {
        const params: Record<string, unknown> = { sessionId };
        if (typeof args.row_id === 'string') params.target = { rowId: args.row_id };
        const value = await read(o, runtime, 'v4/conversation/plans', params);
        o.result(value);
        o.readOnly();
        break;
      }

      case 'usage': {
        const value = await read(o, runtime, 'v4/conversation/usage', { sessionId });
        o.result(value);
        o.readOnly();
        break;
      }

      case 'events': {
        const limit = typeof args.limit === 'number' ? args.limit : 200;
        const all = buffer.eventsFor(sessionId);
        const warned = buffer.stats.buffered > 0;
        o.result({
          events: all.slice(-limit),
          count: Math.min(all.length, limit),
          total_buffered_for_session: all.length,
          // Stated because "no events" and "we were not listening" are different answers, and a
          // caller cannot tell them apart from an empty array.
          subscribed_by_this_server: warned,
          note: warned
            ? 'events are those this server observed; it subscribes when it sends or waits on a session'
            : 'this server has observed no events for any session yet, so it was probably not subscribed',
        });
        if (all.length === 0) {
          o.warn(
            'no_events_observed',
            'this server only sees events for sessions it subscribed to. If the desktop is driving ' +
              'this session, its events do not pass through here.',
            'degraded',
          );
        }
        o.readOnly();
        break;
      }

      default:
        o.fail(`unknown action: ${action}`);
    }
  } catch (err) {
    if (isMethodNotFound(err)) {
      o.warn(
        'method_not_supported',
        `${action} is not implemented on a bare app-server (this build answers -32601). ` +
          'Conversation reads appear to be a host-side capability on this surface.',
        'unreliable',
      );
    } else if (isStale(err)) {
      o.warn(
        'stale_after_retry',
        'the read is still stale after a retry; re-read the session and retry with fresh state',
        'degraded',
      );
    }
    o.fail(describe(err));
  }
  return finish(ctx, o, runId);
}
