/**
 * Redaction tests. Constitution Article IV: no credential may reach a wire log, a result, or the
 * audit database. This runs synthetic secrets through every path that could leak one, because the
 * real secrets are the user's and must never be used as test data.
 */
import { describe, expect, it } from '@jest/globals';

import { isSensitiveKey, REDACTED, redact, redactString, wireLine } from '../src/zcode/redact.js';

/** Shapes that look like real credentials, but are not. */
const FAKE = {
  openai: 'sk-abcdefghijklmnopqrstuvwxyz012345',
  openrouter: 'sk-or-v1-abcdef0123456789abcdef0123456789',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyX2lkIjoiYWJjIn0.c2lnbmF0dXJlLXBhcnQ',
  bearer: 'Bearer abcdefghijklmnopqrstuvwxyz123456',
  providerKey: '58ddd320f7ec4f7298786dc6d7566a4c.juSiut1H4c06rGA5',
  aws: 'AKIAIOSFODNN7EXAMPLE',
};

describe('redactString — value shapes', () => {
  for (const [name, value] of Object.entries(FAKE)) {
    it(`scrubs a ${name}-shaped credential`, () => {
      const out = redactString(`prefix ${value} suffix`);
      expect(out).not.toContain(value);
      expect(out).toContain(REDACTED);
    });
  }

  it('leaves ordinary text alone', () => {
    const s = 'session/list returned 23 sessions for F:\\Github\\proj';
    expect(redactString(s)).toBe(s);
  });

  it('does not mangle short lookalikes', () => {
    // Too short to be a credential; redacting it would destroy legitimate data.
    expect(redactString('sk-short')).toBe('sk-short');
  });
});

describe('redact — structured payloads', () => {
  it('redacts by key name, recursively', () => {
    const out = redact({
      provider: 'zai',
      options: { apiKey: 'secret-value', baseURL: 'https://api.example/v1' },
      nested: [{ authorization: 'Bearer x' }, { password: 'hunter2' }],
    }) as Record<string, unknown>;

    const opts = out.options as Record<string, unknown>;
    expect(opts.apiKey).toBe(REDACTED);
    // A non-sensitive sibling must survive, or the result is useless.
    expect(opts.baseURL).toBe('https://api.example/v1');
    expect(out.provider).toBe('zai');

    const nested = out.nested as Array<Record<string, unknown>>;
    expect(nested[0]!.authorization).toBe(REDACTED);
    expect(nested[1]!.password).toBe(REDACTED);
  });

  it('redacts a secret that arrives as a bare string value', () => {
    const out = redact({ note: `use ${FAKE.openai} to authenticate` }) as Record<string, unknown>;
    expect(String(out.note)).not.toContain(FAKE.openai);
  });

  it('never mutates the input', () => {
    const input = { options: { apiKey: 'keep-me' } };
    redact(input);
    expect(input.options.apiKey).toBe('keep-me');
  });

  it('survives a deeply nested payload without hanging', () => {
    let deep: Record<string, unknown> = { apiKey: 'x' };
    for (let i = 0; i < 40; i++) deep = { child: deep };
    expect(() => redact(deep)).not.toThrow();
  });

  it('handles null, primitives and arrays', () => {
    expect(redact(null)).toBeNull();
    expect(redact(7)).toBe(7);
    expect(redact(['sk-abcdefghijklmnopqrstuvwxyz012345'])).toEqual([REDACTED]);
  });
});

describe('isSensitiveKey', () => {
  it('matches the names that matter', () => {
    for (const k of ['apiKey', 'api_key', 'authorization', 'accessToken', 'refresh_token', 'secret', 'password', 'credential', 'privateKey', 'webhookSecret']) {
      expect(isSensitiveKey(k)).toBe(true);
    }
  });

  it('does not match ordinary keys', () => {
    for (const k of ['baseURL', 'modelId', 'providerId', 'sessionId2', 'kind']) {
      expect(isSensitiveKey(k)).toBe(false);
    }
  });
});

describe('wireLine', () => {
  it('emits a direction-tagged, redacted JSON line', () => {
    const line = wireLine('out', { id: 1, method: 'workspace/readState', params: { apiKey: 'secret' } });
    expect(line).not.toContain('secret');
    const parsed = JSON.parse(line) as { dir: string; msg: Record<string, unknown> };
    expect(parsed.dir).toBe('out');
    expect(parsed.msg.method).toBe('workspace/readState');
  });

  it('redacts a request envelope whose params carry a key', () => {
    const line = wireLine('out', { id: 2, method: 'x', params: { authorization: 'Bearer abcdefghij' } });
    expect(line).not.toContain('abcdefghij');
  });

  it('keeps ids and methods, which are needed to debug', () => {
    const parsed = JSON.parse(wireLine('in', { id: 'server-1', method: 'interaction/requestPermission', params: {} })) as {
      msg: { id: string };
    };
    expect(parsed.msg.id).toBe('server-1');
  });
});

describe('one redaction pass, many surfaces', () => {
  it('a synthetic secret does not survive into a serialized envelope', () => {
    // Simulates what the audit row and the wire log both do with an envelope.
    const envelope = {
      ok: true,
      result: { provider: { options: { apiKey: FAKE.providerKey } } },
      diagnostics: { methods: [], stderr_tail: [`error: rejected key ${FAKE.openai}`] },
    };
    const serialized = JSON.stringify(redact(envelope));
    expect(serialized).not.toContain(FAKE.providerKey);
    expect(serialized).not.toContain(FAKE.openai);
    expect(serialized).toContain(REDACTED);
    // The structure survives: a redacted envelope is still a usable envelope.
    expect(JSON.parse(serialized)).toHaveProperty('result.provider.options.apiKey');
  });
});
