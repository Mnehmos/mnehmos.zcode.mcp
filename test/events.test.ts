/**
 * Event-buffer tests, focused on the honesty rule: a chat tool may only report success after
 * observing a terminal event for ITS turn. The dangerous case is a terminal event belonging to a
 * different turn — that is how a caller ends up reporting someone else's result as its own.
 */
import { describe, expect, it } from '@jest/globals';

import {
  asSessionEvent,
  attachEventBuffer,
  EventBuffer,
  isTerminalTurn,
  TerminalWaitTimeoutError,
  type SessionEvent,
} from '../src/zcode/events.js';
import type { ZCodeProtocolClient } from '../src/zcode/protocol.js';

let seq = 0;
function ev(over: Partial<SessionEvent> & { sessionId: string; type: string }): SessionEvent {
  seq += 1;
  return {
    eventId: `e${seq}`,
    seq,
    timestamp: Date.now(),
    ...over,
  } as SessionEvent;
}

describe('isTerminalTurn', () => {
  it('recognises exactly the two terminal types', () => {
    expect(isTerminalTurn('turn.completed')).toBe(true);
    expect(isTerminalTurn('turn.failed')).toBe(true);
    expect(isTerminalTurn('turn.started')).toBe(false);
    expect(isTerminalTurn('turn.steerQueued')).toBe(false);
    expect(isTerminalTurn('message.upserted')).toBe(false);
  });
});

describe('asSessionEvent', () => {
  it('narrows a well-formed session/event', () => {
    const e = asSessionEvent('session/event', {
      eventId: 'e1',
      sessionId: 's1',
      type: 'turn.completed',
      seq: 4,
      turnId: 't1',
      timestamp: 123,
    });
    expect(e).toMatchObject({ eventId: 'e1', sessionId: 's1', type: 'turn.completed', seq: 4, turnId: 't1' });
  });

  it('rejects a different method, or one missing required fields', () => {
    expect(asSessionEvent('state.updated', { eventId: 'x', sessionId: 's', type: 't' })).toBeNull();
    expect(asSessionEvent('session/event', { sessionId: 's', type: 't' })).toBeNull();
    expect(asSessionEvent('session/event', { eventId: 'x', type: 't' })).toBeNull();
    expect(asSessionEvent('session/event', null)).toBeNull();
  });
});

describe('EventBuffer — acceptance and bounds', () => {
  it('accepts an event once and collapses a replay by eventId', () => {
    const b = new EventBuffer(10);
    const e = ev({ sessionId: 's', type: 'turn.started' });
    expect(b.accept(e)).toBe(true);
    expect(b.accept(e)).toBe(false);
    expect(b.eventsFor('s')).toHaveLength(1);
    expect(b.stats.duplicates).toBe(1);
  });

  it('enforces the ring bound and keeps the newest', () => {
    const b = new EventBuffer(3);
    const accepted = [];
    for (let i = 0; i < 6; i++) accepted.push(ev({ sessionId: 's', type: 'part.delta' }));
    for (const e of accepted) b.accept(e);
    const kept = b.eventsFor('s');
    expect(kept).toHaveLength(3);
    // The newest three survive, in order — asserted against the events themselves so the test does
    // not depend on how many sequence numbers earlier tests consumed.
    expect(kept.map((e) => e.eventId)).toEqual(accepted.slice(-3).map((e) => e.eventId));
  });

  it('inserts out-of-order events in seq order', () => {
    const b = new EventBuffer(10);
    const a = ev({ sessionId: 's', type: 'x' });
    const c = { ...ev({ sessionId: 's', type: 'x' }), seq: a.seq + 2, eventId: 'later' };
    const mid = { ...ev({ sessionId: 's', type: 'x' }), seq: a.seq + 1, eventId: 'middle' };
    b.accept(a);
    b.accept(c);
    b.accept(mid);
    expect(b.eventsFor('s').map((e) => e.eventId)).toEqual([a.eventId, 'middle', 'later']);
  });

  it('keeps sessions separate', () => {
    const b = new EventBuffer(10);
    b.accept(ev({ sessionId: 'a', type: 'x' }));
    b.accept(ev({ sessionId: 'b', type: 'x' }));
    expect(b.eventsFor('a')).toHaveLength(1);
    expect(b.eventsFor('b')).toHaveLength(1);
    expect(b.stats.sessions).toBe(2);
  });
});

describe('EventBuffer — terminal-turn detection', () => {
  it('resolves immediately when the terminal already arrived', async () => {
    const b = new EventBuffer(10);
    b.accept(ev({ sessionId: 's', type: 'turn.completed', turnId: 't1' }));
    const got = await b.waitForTerminalTurn('s', 't1', 1000);
    expect(got.type).toBe('turn.completed');
  });

  it('resolves when the terminal arrives later', async () => {
    const b = new EventBuffer(10);
    const p = b.waitForTerminalTurn('s', 't1', 2000);
    setTimeout(() => b.accept(ev({ sessionId: 's', type: 'turn.completed', turnId: 't1' })), 10);
    await expect(p).resolves.toMatchObject({ type: 'turn.completed', turnId: 't1' });
  });

  it('IGNORES a terminal belonging to a different turn', async () => {
    const b = new EventBuffer(10);
    const p = b.waitForTerminalTurn('s', 'mine', 300);
    b.accept(ev({ sessionId: 's', type: 'turn.completed', turnId: 'someone-elses' }));

    // The waiter must still be waiting: reporting another turn's outcome as ours would be a lie.
    await expect(p).rejects.toBeInstanceOf(TerminalWaitTimeoutError);
  });

  it('ignores a non-terminal event even for the right turn', async () => {
    const b = new EventBuffer(10);
    const p = b.waitForTerminalTurn('s', 't1', 200);
    b.accept(ev({ sessionId: 's', type: 'turn.started', turnId: 't1' }));
    b.accept(ev({ sessionId: 's', type: 'model.streaming', turnId: 't1' }));
    await expect(p).rejects.toBeInstanceOf(TerminalWaitTimeoutError);
  });

  it('rejects with a distinguishable timeout carrying the turn', async () => {
    const b = new EventBuffer(10);
    await expect(b.waitForTerminalTurn('s', 't9', 50)).rejects.toMatchObject({
      name: 'TerminalWaitTimeoutError',
      sessionId: 's',
      turnId: 't9',
    });
  });

  it('rejects on abort', async () => {
    const b = new EventBuffer(10);
    const ctl = new AbortController();
    const p = b.waitForTerminalTurn('s', 't1', 5000, ctl.signal);
    ctl.abort(new Error('caller gave up'));
    await expect(p).rejects.toThrow('caller gave up');
  });

  it('resolves a turn-agnostic wait on any terminal', async () => {
    const b = new EventBuffer(10);
    const p = b.waitForTerminalTurn('s', null, 1000);
    b.accept(ev({ sessionId: 's', type: 'turn.failed', turnId: 'whatever' }));
    await expect(p).resolves.toMatchObject({ type: 'turn.failed' });
  });

  it('does not let a terminal wake a waiter for another session', async () => {
    const b = new EventBuffer(10);
    const p = b.waitForTerminalTurn('mine', 't1', 200);
    b.accept(ev({ sessionId: 'other', type: 'turn.completed', turnId: 't1' }));
    await expect(p).rejects.toBeInstanceOf(TerminalWaitTimeoutError);
  });
});

describe('EventBuffer — assembly helpers', () => {
  it('assembles assistant text from text_delta parts of the requested turn', () => {
    const b = new EventBuffer(20);
    b.accept(ev({ sessionId: 's', type: 'model.streaming', turnId: 't1', payload: { kind: 'text_delta', delta: 'Hello ' } }));
    b.accept(ev({ sessionId: 's', type: 'model.streaming', turnId: 't1', payload: { kind: 'text_delta', delta: 'world' } }));
    b.accept(ev({ sessionId: 's', type: 'model.streaming', turnId: 't1', payload: { kind: 'reasoning_delta', delta: 'IGNORED' } }));
    b.accept(ev({ sessionId: 's', type: 'model.streaming', turnId: 't2', payload: { kind: 'text_delta', delta: 'OTHER' } }));
    expect(b.assistantText('s', 't1')).toBe('Hello world');
    expect(b.assistantText('s', null)).toBe('Hello worldOTHER');
  });

  it('counts tool calls once each, with denied and failed tallies', () => {
    const b = new EventBuffer(20);
    b.accept(ev({ sessionId: 's', type: 'tool.updated', turnId: 't1', payload: { toolCallId: 'c1', status: 'running' } }));
    b.accept(ev({ sessionId: 's', type: 'tool.updated', turnId: 't1', payload: { toolCallId: 'c1', status: 'completed' } }));
    b.accept(ev({ sessionId: 's', type: 'tool.updated', turnId: 't1', payload: { toolCallId: 'c2', status: 'denied' } }));
    b.accept(ev({ sessionId: 's', type: 'tool.updated', turnId: 't1', payload: { toolCallId: 'c3', status: 'failed' } }));
    expect(b.countToolCalls('s', 't1')).toEqual({ total: 3, denied: 1, failed: 1 });
  });

  it('reports the latest turn id', () => {
    const b = new EventBuffer(10);
    b.accept(ev({ sessionId: 's', type: 'x', turnId: 'older' }));
    b.accept(ev({ sessionId: 's', type: 'x', turnId: 'newer' }));
    expect(b.latestTurnId('s')).toBe('newer');
    expect(b.latestTurnId('nope')).toBeNull();
  });

  it('finds the last event of a type', () => {
    const b = new EventBuffer(10);
    b.accept(ev({ sessionId: 's', type: 'a' }));
    b.accept(ev({ sessionId: 's', type: 'b' }));
    expect(b.lastOfType('s', 'a')?.type).toBe('a');
    expect(b.lastOfType('s', 'zzz')).toBeNull();
  });
});

describe('EventBuffer — state.updated and disposal', () => {
  it('stores session-scoped and server-scoped state separately', () => {
    const b = new EventBuffer(10);
    b.acceptStateUpdated({ sessionId: 's1', revision: 3 });
    b.acceptStateUpdated({ scope: 'server', revision: 9 });
    expect(b.stateFor('s1')?.revision).toBe(3);
    expect(b.serverState()?.revision).toBe(9);
    expect(b.stateFor('nope')).toBeNull();
  });

  it('rejects outstanding waiters on dispose rather than leaving them hanging', async () => {
    const b = new EventBuffer(10);
    const p = b.waitForTerminalTurn('s', 't1', 5000);
    b.dispose();
    await expect(p).rejects.toThrow(/disposed/);
  });
});

describe('attachEventBuffer', () => {
  it('routes session events and state updates, and unsubscribes', () => {
    type Handler = (method: string, params: unknown) => void;
    let handler: Handler | null = null;
    const fake = {
      on: (_e: string, h: Handler) => {
        handler = h;
      },
      off: () => {
        handler = null;
      },
    } as unknown as ZCodeProtocolClient;

    const b = new EventBuffer(10);
    const detach = attachEventBuffer(fake, b);

    handler!('session/event', { eventId: 'e1', sessionId: 's', type: 'turn.completed', seq: 1, timestamp: 1 });
    handler!('state.updated', { sessionId: 's', revision: 2 });
    handler!('process/mcpTelemetry', { kind: 'process_start' }); // must be ignored, not stored

    expect(b.eventsFor('s')).toHaveLength(1);
    expect(b.stateFor('s')?.revision).toBe(2);
    detach();
    expect(handler).toBeNull();
  });
});
