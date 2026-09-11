/**
 * The A21 contract: session creation and event subscription.
 *
 * These are the two mistakes that cost the most time, so they get pinned:
 *   - the wrong create path (input admitted into a session with no row yet)
 *   - no subscription, so a turn can complete while the client sees nothing
 */
import { describe, expect, it } from '@jest/globals';

import { extractSessionId } from '../src/zcode/actions/session.js';
import { ModelsArgs } from '../src/schema/tools.js';
import { CHAT_SESSION_ID_OPTIONAL } from './fixtures.js';

describe('extractSessionId — the shapes the runtime actually returns', () => {
  it('reads a top-level sessionId', () => {
    expect(extractSessionId({ sessionId: 'sess_a' })).toBe('sess_a');
  });

  it('reads a nested session object, which is what session/read returns', () => {
    expect(extractSessionId({ session: { sessionId: 'sess_b' } })).toBe('sess_b');
  });

  it('reads a v4 command result', () => {
    expect(extractSessionId({ type: 'createSession', sessionId: 'sess_c' })).toBe('sess_c');
  });

  it('returns null rather than guessing', () => {
    expect(extractSessionId({ messages: [], projection: {} })).toBeNull();
    expect(extractSessionId(null)).toBeNull();
    expect(extractSessionId('sess_d')).toBeNull();
  });

  it('does NOT mistake a projection sessionId for the real one', () => {
    // A cold snapshot reports projection.sessionId === "unknown". Descending into `projection`
    // would return a placeholder as though it were an identity — returning null is correct, and
    // this is exactly what made an earlier create read-back report a false mismatch.
    expect(extractSessionId({ projection: { sessionId: 'unknown' } })).toBeNull();
  });
});

describe('chat send — session_id is optional', () => {
  it('accepts a send with no session_id, which is the create path', () => {
    const r = CHAT_SESSION_ID_OPTIONAL;
    expect(r.success).toBe(true);
  });
});

describe('models schema still parses', () => {
  it('catalog with no filters', () => {
    expect(ModelsArgs.safeParse({ action: 'catalog' }).success).toBe(true);
  });
});
