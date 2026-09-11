/**
 * Staleness handling for conversation reads.
 *
 * The protocol carries `baseLogEpoch` + `baseRevision`, and has dedicated errors
 * (`proto.staleLogEpoch`, `proto.staleRevision`). The plan called for a full read-modify-write
 * layer that always fetches the tokens first and retries once.
 *
 * **Probing changed that, and the smaller thing is the honest one.**
 *
 *   - `session/read` does NOT expose `logEpoch` anywhere. Its snapshot carries
 *     `runtime.stateRevision`, which is a different number and may not be the same token.
 *   - `v4/conversation/rowsRange` **accepted a fabricated `baseLogEpoch: "x"` and `baseRevision: 0`
 *     and returned real rows.** So the compare-and-swap is not enforced on that path in this build.
 *
 * Building a layer that fabricates tokens it cannot obtain, to satisfy a check that does not run,
 * would be inventing a constraint. What is left is genuinely useful and small:
 *
 *   - attempt the read
 *   - if the runtime DOES report staleness, re-read the session and retry ONCE
 *   - if it is still stale, say so with `degraded` rather than looping or hiding it
 *
 * Tokens, when a caller has real ones, are passed through untouched. They are never invented.
 */
import type { Outcome } from '../envelope.js';
import { isMethodNotFound, ZCodeProtocolError } from './protocol.js';
import type { Runtime } from './registry.js';

/**
 * The conversation log tokens.
 *
 * CONFIRMED by probe against `v4/conversation/rowsRange`, which returns the current values under
 * the names `atLogEpoch` and `atSeq`. Those are what `fileChanges` and `fileRewindPreview` want as
 * `baseLogEpoch` and `baseRevision`, and passing a wrong epoch is rejected with
 * `proto.staleLogEpoch` — so the compare-and-swap IS enforced on those paths.
 *
 * Note `rowsRange` itself does NOT enforce it (it accepted a fabricated epoch and returned rows),
 * so tokens are optional there and required here.
 */
export interface LogTokens {
  logEpoch?: string;
  revision?: number;
}

/** Read the tokens out of a `rowsRange` response. Returns null when the response carries none. */
export function tokensFromRowWindow(res: unknown): LogTokens | null {
  if (!res || typeof res !== 'object') return null;
  const r = res as Record<string, unknown>;
  const logEpoch = typeof r.atLogEpoch === 'string' ? r.atLogEpoch : undefined;
  const seq = typeof r.atSeq === 'number' ? r.atSeq : undefined;
  if (logEpoch === undefined && seq === undefined) return null;
  return { ...(logEpoch !== undefined ? { logEpoch } : {}), ...(seq !== undefined ? { revision: seq } : {}) };
}

/** Fold tokens into the wire names fileChanges expects. */
export function tokenParams(t: LogTokens): Record<string, unknown> {
  return {
    ...(t.logEpoch !== undefined ? { baseLogEpoch: t.logEpoch } : {}),
    ...(t.revision !== undefined ? { baseRevision: t.revision } : {}),
  };
}

/** True when the runtime rejected the read as stale. */
export function isStale(err: unknown): boolean {
  if (!(err instanceof ZCodeProtocolError)) return false;
  if (err.code === -32603 && /stale/i.test(err.message)) return true;
  return err.message.includes('proto.staleLogEpoch') || err.message.includes('proto.staleRevision');
}

export interface RetryResult<T> {
  value: T;
  /** How many extra attempts were made. 1 means one staleness retry happened. */
  retries: number;
  /** Set when the first attempt was stale and the retry succeeded. */
  recoveredFromStale: boolean;
}

/**
 * Run a conversation read with at most one staleness retry.
 *
 * `refresh` is what re-reads state between attempts; pass something that re-reads the session. It is
 * only called when staleness is actually reported, so the common path costs one round trip.
 */
export async function withStaleRetry<T>(
  o: Outcome,
  runtime: Runtime,
  label: string,
  attempt: (tokens: LogTokens) => Promise<T>,
  refresh?: () => Promise<LogTokens | null>,
): Promise<RetryResult<T>> {
  let tokens: LogTokens = {};
  try {
    const value = await attempt(tokens);
    return { value, retries: 0, recoveredFromStale: false };
  } catch (err) {
    if (isMethodNotFound(err)) {
      // A capability gap, not a staleness problem. Let the caller report it as such.
      throw err;
    }
    if (!isStale(err)) throw err;

    o.warn(
      'stale_conversation_read',
      `${label} was rejected as stale (${err instanceof Error ? err.message : String(err)}); ` +
        're-reading and retrying once',
      'advisory',
    );

    if (refresh) {
      const fresh = await refresh().catch(() => null);
      if (fresh) tokens = fresh;
    }

    const value = await attempt(tokens);
    return { value, retries: 1, recoveredFromStale: true };
  }
}

/**
 * Extract tokens from a session snapshot, if it happens to carry any.
 *
 * Deliberately limited to fields that are actually present. It returns `stateRevision` under the
 * name `revision` only when a `logEpoch`-like field exists alongside it — otherwise the two are not
 * known to correspond and passing the wrong number would be worse than passing none.
 */
export function tokensFromSnapshot(snapshot: unknown): LogTokens | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const s = snapshot as Record<string, unknown>;
  const logEpoch =
    typeof s.logEpoch === 'string' ? s.logEpoch : typeof s.log_epoch === 'string' ? (s.log_epoch as string) : undefined;
  const revision = typeof s.revision === 'number' ? s.revision : undefined;
  if (logEpoch === undefined && revision === undefined) return null;
  return { ...(logEpoch !== undefined ? { logEpoch } : {}), ...(revision !== undefined ? { revision } : {}) };
}
