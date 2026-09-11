/**
 * Transport unit tests. These never spawn a process — they cover the codec, which is the part
 * most likely to be subtly wrong (partial lines, frames split across chunks, misclassification).
 * The real spawn is proven in integration.test.ts behind ZCODE_MCP_IT=1.
 */
import { describe, expect, it } from '@jest/globals';

import { classify, drainLines, ZCODE_FRAME_LIMIT_BYTES } from '../src/zcode/transport.js';

describe('drainLines', () => {
  it('returns complete lines and preserves the remainder', () => {
    const { lines, rest } = drainLines('{"a":1}\n{"b":2}\n{"c"');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(rest).toBe('{"c"');
  });

  it('handles a frame split across chunks by returning no lines until it completes', () => {
    const first = drainLines('{"id":1,"resu');
    expect(first.lines).toEqual([]);
    expect(first.rest).toBe('{"id":1,"resu');

    const second = drainLines(first.rest + 'lt":42}\n');
    expect(second.lines).toEqual(['{"id":1,"result":42}']);
    expect(second.rest).toBe('');
  });

  it('handles several frames arriving in one chunk', () => {
    const { lines } = drainLines('{"n":1}\n{"n":2}\n{"n":3}\n');
    expect(lines).toHaveLength(3);
  });

  it('strips CR so CRLF output parses', () => {
    const { lines } = drainLines('{"a":1}\r\n');
    expect(lines).toEqual(['{"a":1}']);
  });

  it('drops blank keepalive lines', () => {
    const { lines } = drainLines('\n\n{"a":1}\n\n');
    expect(lines).toEqual(['{"a":1}']);
  });
});

describe('classify', () => {
  it('recognises a result frame', () => {
    expect(classify({ id: 1, result: { sessions: [] } })).toEqual({
      kind: 'result',
      id: 1,
      result: { sessions: [] },
    });
  });

  it('recognises an error frame and preserves the code', () => {
    const m = classify({ id: 1, error: { code: -32601, message: 'Method not found: x', data: { a: 1 } } });
    expect(m).toMatchObject({ kind: 'error', id: 1, error: { code: -32601 } });
  });

  it('defaults a malformed error object to -32603 rather than throwing', () => {
    expect(classify({ id: 1, error: 'boom' })).toMatchObject({ kind: 'error', error: { code: -32603 } });
  });

  it('recognises a server->client request, which has both id and method', () => {
    const m = classify({ id: 'server-1', method: 'interaction/requestPermission', params: { sessionId: 's' } });
    expect(m).toMatchObject({ kind: 'request', id: 'server-1', method: 'interaction/requestPermission' });
  });

  it('recognises a notification, which has method and no id', () => {
    const m = classify({ method: 'process/mcpTelemetry', params: { kind: 'process_start' } });
    expect(m).toMatchObject({ kind: 'notification', method: 'process/mcpTelemetry' });
    expect(m).not.toHaveProperty('id');
  });

  it('treats an explicit null id as absent, matching the runtime', () => {
    expect(classify({ id: null, method: 'x' })).toMatchObject({ kind: 'notification' });
  });

  it('prefers result over method when both are present', () => {
    // A response that echoes a method name must not be mistaken for a request.
    expect(classify({ id: 5, method: 'session/list', result: 1 })).toMatchObject({ kind: 'result' });
  });

  it('returns null for non-objects and arrays', () => {
    expect(classify(null)).toBeNull();
    expect(classify([])).toBeNull();
    expect(classify('nope')).toBeNull();
  });
});

describe('frame limit', () => {
  it('is ZCode 1 MiB, matching nn.maxFrameBytes', () => {
    expect(ZCODE_FRAME_LIMIT_BYTES).toBe(1024 * 1024);
  });
});
