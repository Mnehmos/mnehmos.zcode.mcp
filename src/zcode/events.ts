/**
 * Event buffering and terminal-turn detection.
 *
 * This file contains the single most important read-back in the server. `v4/command` returns
 * **admission**, not completion — so a chat tool may only report success after observing a terminal
 * `turn.completed` / `turn.failed` for the turn it submitted. Everything here exists to make that
 * observation reliable:
 *
 *   - notifications are buffered per session in a bounded ring
 *   - duplicates are collapsed by `eventId`, because the runtime re-sends on replay
 *   - ordering is by `seq`, which the runtime assigns monotonically
 *   - `waitForTerminalTurn` resolves on the *specific* turn, so a stale terminal from a previous
 *     turn cannot be mistaken for this one's
 *
 * Bound is ZCODE_MCP_EVENT_BUFFER, default 2000, matching the runtime's own eventRetentionPerSession.
 */
import type { ZCodeProtocolClient } from './protocol.js';

export interface SessionEvent {
  eventId: string;
  sessionId: string;
  turnId?: string;
  seq: number;
  traceId?: string;
  timestamp: number;
  deliveryKind?: string;
  type: string;
  payload?: unknown;
}

export interface StateUpdated {
  scope?: 'server' | 'workspace' | 'session';
  sessionId?: string;
  workspace?: unknown;
  revision?: number;
  reason?: string;
  patch?: unknown;
}

/** The two event types that mean a turn is over. Nothing else may be treated as terminal. */
export const TERMINAL_TURN_TYPES = ['turn.completed', 'turn.failed'] as const;
export type TerminalTurnType = (typeof TERMINAL_TURN_TYPES)[number];

export function isTerminalTurn(type: string): type is TerminalTurnType {
  return (TERMINAL_TURN_TYPES as readonly string[]).includes(type);
}

/** Narrow an unknown notification into a SessionEvent, or return null. */
export function asSessionEvent(method: string, params: unknown): SessionEvent | null {
  if (method !== 'session/event') return null;
  if (!params || typeof params !== 'object') return null;
  const p = params as Record<string, unknown>;
  const eventId = typeof p.eventId === 'string' ? p.eventId : null;
  const sessionId = typeof p.sessionId === 'string' ? p.sessionId : null;
  const type = typeof p.type === 'string' ? p.type : null;
  if (!eventId || !sessionId || !type) return null;
  return {
    eventId,
    sessionId,
    ...(typeof p.turnId === 'string' ? { turnId: p.turnId } : {}),
    seq: typeof p.seq === 'number' ? p.seq : 0,
    ...(typeof p.traceId === 'string' ? { traceId: p.traceId } : {}),
    timestamp: typeof p.timestamp === 'number' ? p.timestamp : Date.now(),
    ...(typeof p.deliveryKind === 'string' ? { deliveryKind: p.deliveryKind } : {}),
    type,
    ...(p.payload !== undefined ? { payload: p.payload } : {}),
  };
}

interface Waiter {
  sessionId: string;
  turnId: string | null;
  resolve: (e: SessionEvent) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class EventBuffer {
  private readonly bySessions = new Map<string, SessionEvent[]>();
  /** Bounded set of seen ids, newest last. A Set preserves insertion order, which is all we need. */
  private readonly seen = new Set<string>();
  private readonly waiters = new Set<Waiter>();
  private readonly stateBySession = new Map<string, StateUpdated>();
  private lastServerState: StateUpdated | null = null;
  private totalAccepted = 0;
  private totalDroppedDuplicates = 0;

  constructor(private readonly capacity = 2000) {}

  get stats(): { sessions: number; buffered: number; accepted: number; duplicates: number; waiters: number } {
    let buffered = 0;
    for (const list of this.bySessions.values()) buffered += list.length;
    return {
      sessions: this.bySessions.size,
      buffered,
      accepted: this.totalAccepted,
      duplicates: this.totalDroppedDuplicates,
      waiters: this.waiters.size,
    };
  }

  /**
   * Add one event. Returns false when it was a duplicate (already seen) or malformed.
   * Callers must not treat a false return as an error: replay legitimately re-sends events.
   */
  accept(event: SessionEvent): boolean {
    if (this.seen.has(event.eventId)) {
      this.totalDroppedDuplicates++;
      return false;
    }
    this.seen.add(event.eventId);
    // Evict oldest ids alongside the ring so the two bounds do not diverge.
    if (this.seen.size > this.capacity * 2) {
      const excess = this.seen.size - this.capacity;
      let i = 0;
      for (const id of this.seen) {
        if (i++ >= excess) break;
        this.seen.delete(id);
      }
    }

    let list = this.bySessions.get(event.sessionId);
    if (!list) {
      list = [];
      this.bySessions.set(event.sessionId, list);
    }
    // Insert in seq order. Events arrive ordered in practice, so this is usually a push.
    const last = list[list.length - 1];
    if (!last || event.seq >= last.seq) list.push(event);
    else {
      const at = list.findIndex((e) => e.seq > event.seq);
      list.splice(at === -1 ? list.length : at, 0, event);
    }
    while (list.length > this.capacity) list.shift();

    this.totalAccepted++;
    this.wake(event);
    return true;
  }

  private wake(event: SessionEvent): void {
    if (!isTerminalTurn(event.type)) return;
    for (const w of [...this.waiters]) {
      if (w.sessionId !== event.sessionId) continue;
      // A terminal for a DIFFERENT turn must not satisfy a waiter: that is how a caller ends up
      // reporting someone else's result as its own.
      if (w.turnId !== null && event.turnId !== undefined && event.turnId !== w.turnId) continue;
      clearTimeout(w.timer);
      this.waiters.delete(w);
      w.resolve(event);
    }
  }

  /** Events for a session, oldest first. */
  eventsFor(sessionId: string): SessionEvent[] {
    return [...(this.bySessions.get(sessionId) ?? [])];
  }

  /** Most recent event of a type, if any. */
  lastOfType(sessionId: string, type: string): SessionEvent | null {
    const list = this.bySessions.get(sessionId);
    if (!list) return null;
    for (let i = list.length - 1; i >= 0; i--) if (list[i]!.type === type) return list[i]!;
    return null;
  }

  acceptStateUpdated(s: StateUpdated): void {
    if (s.sessionId) this.stateBySession.set(s.sessionId, s);
    else this.lastServerState = s;
  }

  stateFor(sessionId: string): StateUpdated | null {
    return this.stateBySession.get(sessionId) ?? null;
  }

  serverState(): StateUpdated | null {
    return this.lastServerState;
  }

  /**
   * Resolve when a terminal event for this turn arrives.
   *
   * Rejects with a distinguishable error on timeout, so a caller can report `degraded` rather than
   * guessing at an outcome.
   */
  waitForTerminalTurn(
    sessionId: string,
    turnId: string | null,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<SessionEvent> {
    const already = this.findTerminal(sessionId, turnId);
    if (already) return Promise.resolve(already);

    return new Promise<SessionEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(w);
        reject(new TerminalWaitTimeoutError(sessionId, turnId, timeoutMs));
      }, timeoutMs);
      const w: Waiter = { sessionId, turnId, resolve, reject, timer };
      if (signal) {
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            this.waiters.delete(w);
            reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
          },
          { once: true },
        );
      }
      this.waiters.add(w);
    });
  }

  private findTerminal(sessionId: string, turnId: string | null): SessionEvent | null {
    const list = this.bySessions.get(sessionId);
    if (!list) return null;
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i]!;
      if (!isTerminalTurn(e.type)) continue;
      if (turnId !== null && e.turnId !== undefined && e.turnId !== turnId) continue;
      return e;
    }
    return null;
  }

  /** Most recent turn id seen for a session, from any turn-scoped event. */
  latestTurnId(sessionId: string): string | null {
    const list = this.bySessions.get(sessionId);
    if (!list) return null;
    for (let i = list.length - 1; i >= 0; i--) if (list[i]!.turnId) return list[i]!.turnId!;
    return null;
  }

  /** Assemble the assistant text for a turn from its part events. */
  assistantText(sessionId: string, turnId: string | null): string {
    const list = this.bySessions.get(sessionId) ?? [];
    let out = '';
    for (const e of list) {
      if (turnId !== null && e.turnId !== undefined && e.turnId !== turnId) continue;
      const p = e.payload as { kind?: string; delta?: string } | undefined;
      if (e.type === 'model.streaming' && p?.kind === 'text_delta' && typeof p.delta === 'string') {
        out += p.delta;
      }
    }
    return out;
  }

  countToolCalls(sessionId: string, turnId: string | null): { total: number; denied: number; failed: number } {
    const list = this.bySessions.get(sessionId) ?? [];
    const ids = new Set<string>();
    let denied = 0;
    let failed = 0;
    for (const e of list) {
      if (e.type !== 'tool.updated') continue;
      if (turnId !== null && e.turnId !== undefined && e.turnId !== turnId) continue;
      const p = e.payload as { toolCallId?: string; status?: string; kind?: string } | undefined;
      const id = p?.toolCallId ?? e.eventId;
      if (ids.has(id)) continue;
      ids.add(id);
      if (p?.status === 'denied') denied++;
      if (p?.status === 'failed' || p?.kind === 'error') failed++;
    }
    return { total: ids.size, denied, failed };
  }

  dispose(): void {
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.reject(new Error('event buffer disposed'));
    }
    this.waiters.clear();
    this.bySessions.clear();
    this.seen.clear();
  }
}

export class TerminalWaitTimeoutError extends Error {
  constructor(
    readonly sessionId: string,
    readonly turnId: string | null,
    readonly timeoutMs: number,
  ) {
    super(`no terminal turn event for ${turnId ?? 'any turn'} in session ${sessionId} within ${timeoutMs} ms`);
    this.name = 'TerminalWaitTimeoutError';
  }
}

/** Subscribe a buffer to a client's notifications. Returns an unsubscribe fn. */
export function attachEventBuffer(client: ZCodeProtocolClient, buffer: EventBuffer): () => void {
  const onNotification = (method: string, params: unknown) => {
    const ev = asSessionEvent(method, params);
    if (ev) {
      buffer.accept(ev);
      return;
    }
    if (method === 'state.updated' && params && typeof params === 'object') {
      buffer.acceptStateUpdated(params as StateUpdated);
    }
  };
  client.on('notification', onNotification);
  return () => client.off('notification', onNotification);
}
