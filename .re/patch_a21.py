"""Apply the A21 fixes: per-session subscribe, no hanging, and the deferred-row contract.

Run from the repo root:  python .re/patch_a21.py
"""
import io
import sys

def patch(path, pairs, required=True):
    s = io.open(path, encoding="utf-8").read()
    for old, new in pairs:
        if old not in s:
            if required:
                print(f"  !! pattern NOT FOUND in {path}: {old[:70]!r}")
                sys.exit(1)
            print(f"  -- skipped (absent) in {path}")
            continue
        s = s.replace(old, new)
    io.open(path, "w", encoding="utf-8", newline="").write(s)
    print(f"  patched {path}")

# ── events.ts: per-session subscribe is THE mechanism ────────────────────────
OLD_SUB = '''/**
 * Subscribe the CONNECTION, so session events flow at all.
 *
 * CONFIRMED by probe: without a subscription the runtime emits nothing — a turn can start and
 * complete while the client sees zero events. `v4/controller/subscribe` is the connection-level
 * form, which is the right one to use here: subscribing per-session after creating it would race
 * the turn, because the turn starts inside the create command.
 *
 * `clientMode` is required and accepts "desktop-continuous" (live) or "web-remote-replayable".
 * We are an attached client, so live is correct.
 */
export async function subscribeConnection(
  client: ZCodeProtocolClient,
  opts: { connectionId: string; workspace?: { workspacePath: string; workspaceKey: string }; clientMode?: 'desktop-continuous' | 'web-remote-replayable' },
): Promise<{ ack: unknown }> {
  return client.request<{ ack: unknown }>('v4/controller/subscribe', {
    connectionId: opts.connectionId,
    clientMode: opts.clientMode ?? 'desktop-continuous',
    ...(opts.workspace ? { workspace: opts.workspace } : {}),
  });
}

/** Subscribe to a session's events individually. Used to re-attach after a resume. */'''

NEW_SUB = '''/**
 * Subscribe to a session's events. **Nothing arrives without this.**
 *
 * CONFIRMED on two separate runs: with no subscription the runtime emits ZERO events — a turn can
 * start AND complete while the client sees nothing. That is the difference between "the turn
 * failed" and "we were not listening", and it cost real debugging time.
 *
 * `deliveryKind` is REQUIRED; the runtime's validator accepts exactly "desktop-continuous" or
 * "web-remote-replayable". Live is right for an attached client.
 *
 * On the connection-level form: the v4 enum lists `v4/controller/subscribe`, but this agent build
 * answers `-32601 Method not found` for it — it appears to be a HOST-side method. Per-session
 * subscribe is the mechanism that exists here, so it is the one used.
 */'''

# ── context.ts: drop the controller attempt ─────────────────────────────────
CTX_OLD = s = '''    // Subscribe the connection BEFORE returning, so no event can be missed between "runtime is
    // ready" and the first tool call. Without this the runtime emits nothing at all.
    void subscribeConnection(rt.client, {
      connectionId: `mcp-${rt.workspaceKey.replace(/[^A-Za-z0-9]/g, '').slice(-24)}`,
      workspace: { workspacePath: rt.workspacePath, workspaceKey: rt.workspaceKey },
    })
      .then(() => {
        rt.subscribed = true;
      })
      .catch((err: unknown) => {
        rt.subscribeError = err instanceof Error ? err.message : String(err);
      });
'''

CTX_NEW = '''    // Events require a PER-SESSION subscription, so there is nothing useful to do at connection
    // level: `v4/controller/subscribe` is in the v4 enum but this build answers -32601 for it.
    // `zcode_chat` subscribes the session it is about to use, before it waits on anything.
'''

patch("src/zcode/events.ts", [(OLD_SUB, NEW_SUB)])
patch("src/context.ts", [
    ("import { attachEventBuffer, EventBuffer, subscribeConnection } from './zcode/events.js';",
     "import { attachEventBuffer, EventBuffer } from './zcode/events.js';"),
    (CTX_OLD, CTX_NEW),
])

# ── chat.ts ─────────────────────────────────────────────────────────────────
chat = io.open("src/zcode/actions/chat.ts", encoding="utf-8").read()

chat = chat.replace(
    "import { isTerminalTurn, TerminalWaitTimeoutError } from '../events.js';",
    "import { isTerminalTurn, subscribeSession, TerminalWaitTimeoutError } from '../events.js';",
)

OLD_GUARD = '''  if (!runtime.subscribed) {
    o.warn(
      'not_subscribed',
      `the runtime's event subscription is not established${runtime.subscribeError ? ` (${runtime.subscribeError})` : ' (still pending)'}; ` +
        'streaming events and the terminal turn event may not be observed',
      'degraded',
    );
  }

  const beforeTurn = creating ? null : buffer.latestTurnId(sessionId);'''

NEW_GUARD = '''  // For an EXISTING session, subscribe before sending: otherwise the send races the subscription
  // and every early event is lost. For a NEW one the id does not exist yet, so it is subscribed
  // below, the moment createSession returns it.
  let subscribed = false;
  if (!creating) subscribed = await trySubscribe(o, runtime, sessionId);

  const beforeTurn = creating ? null : buffer.latestTurnId(sessionId);'''

OLD_CREATE = '''  if (creating && status === 'accepted') {
    const created = (res.result as { sessionId?: unknown } | undefined)?.sessionId;
    if (typeof created === 'string') {
      sessionId = created;
    } else {
      o.fail('createSession was accepted but returned no sessionId, so the turn cannot be followed');
      return finish(ctx, o, runId);
    }
  }'''

NEW_CREATE = '''  if (creating && status === 'accepted') {
    const created = (res.result as { sessionId?: unknown } | undefined)?.sessionId;
    if (typeof created === 'string') {
      sessionId = created;
      subscribed = await trySubscribe(o, runtime, sessionId);
    } else {
      o.fail('createSession was accepted but returned no sessionId, so the turn cannot be followed');
      return finish(ctx, o, runId);
    }
  }'''

OLD_NOTWAIT = '''  if (!wait) {
    o.warn('not_awaited', 'wait:false — the command was submitted but not followed to a terminal state', 'degraded');
    o.readBackUnavailable('not awaited; the turn outcome is unknown to this call');
    o.setStderrTail(runtime.transport.stderrLines);
    return finish(ctx, o, runId);
  }'''

NEW_NOTWAIT = OLD_NOTWAIT + '''

  // Without a subscription no terminal event can ever arrive, so waiting would burn the entire
  // timeout to learn nothing. Return the admission honestly instead of hanging.
  if (!subscribed) {
    o.warn(
      'subscribe_failed',
      'could not subscribe to this session, so no turn events can be observed; returning the ' +
        'admission without waiting rather than blocking for the full timeout',
      'degraded',
    );
    o.readBackUnavailable('admitted but unobservable: the session subscription is not established');
    o.result({ status, session_id: sessionId, ...(creating ? { created: true } : {}), turn: { outcome: 'unknown' } });
    o.setStderrTail(runtime.transport.stderrLines);
    return finish(ctx, o, runId);
  }'''

OLD_WAITONLY = '''  const timeout = typeof args.timeout_ms === 'number' ? args.timeout_ms : 600_000;
  const collect = typeof args.collect === 'string' ? args.collect : 'final';
  const turnId = buffer.latestTurnId(sessionId);'''

NEW_WAITONLY = '''  const timeout = typeof args.timeout_ms === 'number' ? args.timeout_ms : 600_000;
  const collect = typeof args.collect === 'string' ? args.collect : 'final';

  if (!(await trySubscribe(o, runtime, sessionId))) {
    o.warn('subscribe_failed', 'could not subscribe to this session, so no events can be observed', 'degraded');
    o.readBackUnavailable('unobservable: the session subscription is not established');
    o.result({ turn: { session_id: sessionId, outcome: 'unknown' } });
    return finish(ctx, o, runId);
  }
  const turnId = buffer.latestTurnId(sessionId);'''

OLD_HELPER = "function finish(ctx: ServerContext, o: Outcome, runId: string): Envelope {"

NEW_HELPER = '''/**
 * Subscribe, reporting failure as a warning rather than throwing.
 *
 * Returns false when the subscription could not be established — which callers use to decide
 * whether waiting is even meaningful.
 */
async function trySubscribe(
  o: Outcome,
  runtime: Awaited<ReturnType<ServerContext['acquire']>>['runtime'],
  sessionId: string,
): Promise<boolean> {
  if (!sessionId) return false;
  const t = Date.now();
  try {
    await subscribeSession(runtime.client, sessionId);
    o.method('session/subscribe', true, Date.now() - t);
    return true;
  } catch (err) {
    o.method('session/subscribe', false, Date.now() - t, describe(err));
    return false;
  }
}

function finish(ctx: ServerContext, o: Outcome, runId: string): Envelope {'''

for old, new in [(OLD_GUARD, NEW_GUARD), (OLD_CREATE, NEW_CREATE),
                 (OLD_NOTWAIT, NEW_NOTWAIT), (OLD_WAITONLY, NEW_WAITONLY),
                 (OLD_HELPER, NEW_HELPER)]:
    if old not in chat:
        print(f"  !! chat.ts missing pattern: {old[:70]!r}")
        sys.exit(1)
    chat = chat.replace(old, new, 1)

io.open("src/zcode/actions/chat.ts", "w", encoding="utf-8", newline="").write(chat)
print("  patched src/zcode/actions/chat.ts")
print("done")
