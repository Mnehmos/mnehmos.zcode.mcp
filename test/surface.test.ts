/** Tests for the pure logic added with the full tool surface. */
import { describe, expect, it } from '@jest/globals';

import { buildHeadlessArgs } from '../src/zcode/actions/protocol.js';
import { allowList, matchesAllow, mutationsAllowed, protocolEnabled } from '../src/zcode/actions/protocol.js';
import { redactDeep } from '../src/zcode/actions/settings.js';
import { tokensFromRowWindow, tokenParams, isStale } from '../src/zcode/logtokens.js';
import { ZCodeProtocolError } from '../src/zcode/protocol.js';
import { FilesArgs, SettingsArgs, ProtocolArgs } from '../src/schema/tools.js';

describe('buildHeadlessArgs — only verified flags', () => {
  it('always sends --prompt and --json', () => {
    const { argv } = buildHeadlessArgs({ text: 'hi' });
    expect(argv).toContain('--prompt');
    expect(argv).toContain('hi');
    expect(argv).toContain('--json');
  });

  it('emits --cwd, which is verified to parse', () => {
    expect(buildHeadlessArgs({ text: 'x', workspace: 'F:/p' }).argv).toContain('--cwd');
  });

  it('NEVER emits --max-turns, --settings, --allowed-tools or --permission-mode', () => {
    // These are advertised by `zcode --help` and REJECTED by the parser (strict:true), so emitting
    // one turns a working call into a usage error.
    const { argv, skipped } = buildHeadlessArgs({
      text: 'x', '--max-turns': 3, '--settings': 'p', '--allowed-tools': 'Read', '--permission-mode': 'plan',
    } as Record<string, unknown>);
    for (const bad of ['--max-turns', '--settings', '--allowed-tools', '--permission-mode']) {
      expect(argv).not.toContain(bad);
      expect(skipped).toContain(bad);
    }
  });

  it('forwards --mode, which IS verified', () => {
    expect(buildHeadlessArgs({ text: 'x', mode: 'plan' }).argv).toEqual(
      expect.arrayContaining(['--mode', 'plan']),
    );
  });
});

describe('protocol gates', () => {
  it('is enabled unless explicitly disabled', () => {
    expect(protocolEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(protocolEnabled({ ZCODE_MCP_DISABLE_PROTOCOL: '1' } as NodeJS.ProcessEnv)).toBe(false);
    expect(protocolEnabled({ ZCODE_MCP_DISABLE_PROTOCOL: '0' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('requires an explicit opt-in for mutations', () => {
    expect(mutationsAllowed({} as NodeJS.ProcessEnv)).toBe(false);
    expect(mutationsAllowed({ ZCODE_MCP_PROTOCOL_ALLOW_MUTATIONS: '1' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('defaults to read-only paths, and a custom list replaces it', () => {
    const d = allowList({} as NodeJS.ProcessEnv);
    expect(d).toContain('session/list');
    expect(d.some((m) => m.includes('create'))).toBe(false);
    expect(allowList({ ZCODE_MCP_PROTOCOL_ALLOW: 'session/*' } as NodeJS.ProcessEnv)).toEqual(['session/*']);
  });

  it('matches exactly, and by prefix when a pattern ends in *', () => {
    expect(matchesAllow('session/list', ['session/list'])).toBe(true);
    expect(matchesAllow('session/create', ['session/*'])).toBe(true);
    expect(matchesAllow('workspace/readState', ['session/*'])).toBe(false);
  });

  it('does not let a wildcard escape its namespace', () => {
    expect(matchesAllow('workspace/setDefaultModel', ['session*'])).toBe(false);
  });
});

describe('redactDeep', () => {
  it('redacts by key name at any depth, including inside arrays', () => {
    const out = redactDeep({
      provider: { x: { options: { apiKey: 'live-secret', baseURL: 'https://ok' } } },
      list: [{ token: 't' }, { name: 'keep' }],
    }) as Record<string, unknown>;
    const j = JSON.stringify(out);
    expect(j).not.toContain('live-secret');
    expect(j).toContain('https://ok');
    expect(j).toContain('keep');
    expect(j).toContain('[REDACTED]');
  });

  it('does not mutate its input', () => {
    const input = { apiKey: 'unchanged' };
    redactDeep(input);
    expect(input.apiKey).toBe('unchanged');
  });
});

describe('logtokens — the real field names', () => {
  it('reads tokens from a rowsRange response', () => {
    expect(tokensFromRowWindow({ atLogEpoch: 'mtxef5c8-qdsym9l6', atSeq: 10 })).toEqual({
      logEpoch: 'mtxef5c8-qdsym9l6',
      revision: 10,
    });
  });

  it('returns null when the response carries none, rather than inventing them', () => {
    expect(tokensFromRowWindow({ rows: [] })).toBeNull();
    expect(tokensFromRowWindow(null)).toBeNull();
  });

  it('maps to the wire names fileChanges expects', () => {
    expect(tokenParams({ logEpoch: 'e', revision: 3 })).toEqual({ baseLogEpoch: 'e', baseRevision: 3 });
    expect(tokenParams({})).toEqual({});
  });

  it('recognises staleness by error code or message', () => {
    expect(isStale(new ZCodeProtocolError('proto.staleRevision', -32603))).toBe(true);
    expect(isStale(new ZCodeProtocolError('proto.staleLogEpoch', -32603))).toBe(true);
    expect(isStale(new ZCodeProtocolError('something else', -32603))).toBe(false);
    expect(isStale(new Error('staleRevision'))).toBe(false);
  });
});

describe('schemas — the shapes the runtime actually accepts', () => {
  it('coerces row ids to numbers, because the runtime rejects strings', () => {
    const r = FilesArgs.safeParse({ action: 'changes', session_id: 's', row_id: '1' });
    expect(r.success).toBe(true);
    if (r.success) expect((r.data as { row_id: number }).row_id).toBe(1);
  });

  it('accepts a settings read with no workspace, since the env supplies one', () => {
    expect(SettingsArgs.safeParse({ action: 'get', file: 'agent_config' }).success).toBe(true);
    expect(SettingsArgs.safeParse({ action: 'read_state' }).success).toBe(true);
  });

  it('requires a method for a raw call', () => {
    expect(ProtocolArgs.safeParse({ action: 'call', method: 'session/list' }).success).toBe(true);
    expect(ProtocolArgs.safeParse({ action: 'call' }).success).toBe(false);
  });
});
