/**
 * Envelope and warning tests. This is where Constitution Article II is enforced, so the important
 * cases are the unhappy ones: a mutating action must never be able to report a clean success
 * without a read-back.
 */
import { describe, expect, it } from '@jest/globals';

import { Outcome, localEnvelope } from '../src/envelope.js';
import { byImpact, warn, WARNING_CODES } from '../src/warnings.js';

describe('Outcome — the read-back rule', () => {
  it('passes a mutating action that read back and agreed', () => {
    const o = new Outcome({ tool: 'zcode_session', action: 'set_mode', mutates: true });
    o.result({ mode: 'plan' });
    o.readBack(true);
    const e = o.finalise();
    expect(e.ok).toBe(true);
    expect(e.evidence.warnings).toHaveLength(0);
  });

  it('FAILS a mutating action whose read-back disagreed', () => {
    const o = new Outcome({ tool: 'zcode_session', action: 'set_model', mutates: true });
    o.readBack(false, 'requested glm-4, observed glm-3');
    const e = o.finalise();
    expect(e.ok).toBe(false);
    expect(e.evidence.errors[0]).toContain('read-back mismatch');
    expect(e.evidence.errors[0]).toContain('requested glm-4');
  });

  it('never lets a mutating action pass silently without a read-back', () => {
    const o = new Outcome({ tool: 'zcode_session', action: 'close', mutates: true });
    o.result({ closed: true });
    const e = o.finalise();
    // It stays ok (the dispatcher may have a reason), but it must be marked unreliable.
    const w = e.evidence.warnings.find((x) => x.code === 'read_back_missing');
    expect(w).toBeDefined();
    expect(w!.impact).toBe('unreliable');
  });

  it('accepts an explicit declaration that read-back is unavailable, as degraded', () => {
    const o = new Outcome({ tool: 'zcode_settings', action: 'set_desktop', mutates: true });
    o.readBackUnavailable('desktop settings are read at startup');
    const e = o.finalise();
    expect(e.ok).toBe(true);
    expect(e.evidence.warnings[0]).toMatchObject({ code: 'read_back_unavailable', impact: 'degraded' });
  });

  it('does not require a read-back for a read-only action', () => {
    const o = new Outcome({ tool: 'zcode_usage', action: 'stats', mutates: false });
    o.result({ total: 1 });
    const e = o.finalise();
    expect(e.ok).toBe(true);
    expect(e.evidence.warnings).toHaveLength(0);
  });
});

describe('Outcome — failure and diagnostics', () => {
  it('marks failure on error()', () => {
    const o = new Outcome({ tool: 't', action: 'a' });
    o.error('boom');
    expect(o.finalise().ok).toBe(false);
  });

  it('records per-method diagnostics so a composite action is diagnosable', () => {
    const o = new Outcome({ tool: 't', action: 'a' });
    o.method('session/list', true, 12);
    o.method('session/read', false, 30, 'session unavailable');
    const e = o.finalise();
    expect(e.diagnostics.methods).toHaveLength(2);
    expect(e.diagnostics.methods[1]!.error).toBe('session unavailable');
  });

  it('reports duration and timeout state', () => {
    const o = new Outcome({ tool: 't', action: 'a' });
    o.setTimedOut(true).setExitCode(1);
    const e = o.finalise();
    expect(e.evidence.timed_out).toBe(true);
    expect(e.evidence.exit_code).toBe(1);
    expect(e.evidence.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('nulls an unset result rather than leaving it undefined', () => {
    expect(new Outcome({ tool: 't', action: 'a' }).finalise().result).toBeNull();
  });
});

describe('warning vocabulary', () => {
  it('gives every code a default impact', () => {
    for (const [code, impact] of Object.entries(WARNING_CODES)) {
      expect(['advisory', 'degraded', 'unreliable']).toContain(impact);
      expect(code).toBe(code.toLowerCase());
    }
  });

  it('builds a warning with the code default, and allows an override', () => {
    expect(warn('no_terminal_event', 'x').impact).toBe('degraded');
    expect(warn('provider_not_configured', 'x').impact).toBe('unreliable');
    expect(warn('no_terminal_event', 'x', 'unreliable').impact).toBe('unreliable');
  });

  it('sorts the most consequential warnings first', () => {
    const sorted = byImpact([
      warn('restart_required', 'a'),
      warn('provider_not_configured', 'b'),
      warn('no_terminal_event', 'c'),
    ]);
    expect(sorted.map((w) => w.impact)).toEqual(['unreliable', 'degraded', 'advisory']);
  });
});

describe('localEnvelope', () => {
  it('has the same shape as a run envelope, with no runtime', () => {
    const e = localEnvelope({ tool: 'zcode_status', action: 'runs' }, [1, 2]);
    expect(e.mode).toBe('local');
    expect(e.runtime).toBeNull();
    expect(e.run).toBeNull();
    expect(e.evidence.payload_source).toBe('local');
    expect(e.result).toEqual([1, 2]);
  });
});
