/**
 * Policy tests. Constitution Article V: default deny, and every server->client request settles.
 *
 * A fake client records what the policy answered, so these assertions are about the exact protocol
 * frames the runtime would receive.
 */
import { describe, expect, it } from '@jest/globals';

import {
  ApprovalPolicy,
  matchesPattern,
  parsePattern,
  policyFromEnv,
} from '../src/zcode/policy.js';
import type { ZCodeProtocolClient } from '../src/zcode/protocol.js';

interface Sent {
  kind: 'result' | 'error';
  id: string | number;
  payload: unknown;
}

function fakeClient(): { client: ZCodeProtocolClient; sent: Sent[] } {
  const sent: Sent[] = [];
  const client = {
    respond: async (id: string | number, result: unknown) => {
      sent.push({ kind: 'result', id, payload: result });
    },
    respondError: async (id: string | number, error: unknown) => {
      sent.push({ kind: 'error', id, payload: error });
    },
  } as unknown as ZCodeProtocolClient;
  return { client, sent };
}

describe('parsePattern / matchesPattern', () => {
  it('reads a bare tool name', () => {
    expect(parsePattern('Read')).toEqual({ tool: 'Read', content: null });
  });
  it('reads a tool with a content pattern', () => {
    expect(parsePattern('Bash(git *)')).toEqual({ tool: 'Bash', content: 'git *' });
  });
  it('treats empty parens as no content constraint', () => {
    expect(parsePattern('Bash()')).toEqual({ tool: 'Bash', content: null });
  });

  it('matches a bare name case-insensitively', () => {
    expect(matchesPattern('read', 'Read')).toBe(true);
    expect(matchesPattern('Write', 'Read')).toBe(false);
  });
  it('matches a trailing-wildcard content pattern as a prefix', () => {
    expect(matchesPattern('Bash(git *)', 'Bash', 'git status')).toBe(true);
    expect(matchesPattern('Bash(git *)', 'Bash', 'rm -rf /')).toBe(false);
  });
  it('matches an exact content pattern only when equal', () => {
    expect(matchesPattern('Bash(git status)', 'Bash', 'git status')).toBe(true);
    expect(matchesPattern('Bash(git status)', 'Bash', 'git log')).toBe(false);
  });
  it('does not match a content pattern against a missing rule content', () => {
    expect(matchesPattern('Bash(git *)', 'Bash')).toBe(false);
  });
});

describe('ApprovalPolicy — decisions', () => {
  it('defaults to deny', () => {
    expect(new ApprovalPolicy().decide('Bash')).toBe('deny');
    expect(new ApprovalPolicy().config.mode).toBe('deny');
  });

  it('allows everything in allow mode', () => {
    expect(new ApprovalPolicy({ mode: 'allow' }).decide('Bash')).toBe('allow');
  });

  it('honours an allow pattern over the deny default', () => {
    const p = new ApprovalPolicy({ allowPatterns: ['Read', 'Bash(git *)'] });
    expect(p.decide('Read')).toBe('allow');
    expect(p.decide('Bash', 'git status')).toBe('allow');
    expect(p.decide('Bash', 'rm -rf /')).toBe('deny');
    expect(p.decide('Write')).toBe('deny');
  });

  it('denies in ask mode until the caller resolves, because asking is not allowing', () => {
    expect(new ApprovalPolicy({ mode: 'ask' }).decide('Bash')).toBe('deny');
  });
});

describe('ApprovalPolicy — handling server->client requests', () => {
  it('answers a permission request with a deny and a reason that explains how to change it', async () => {
    const { client, sent } = fakeClient();
    const p = new ApprovalPolicy({ mode: 'deny' });
    await p.handle(client, 'server-1', 'interaction/requestPermission', {
      sessionId: 's',
      requestId: 'r1',
      toolName: 'Bash',
      riskLevel: 'high',
    });
    expect(sent).toHaveLength(1);
    const payload = sent[0]!.payload as { decision: string; reason: string };
    expect(payload.decision).toBe('deny');
    expect(payload.reason).toContain('ZCODE_MCP_APPROVAL=ask');
    expect(p.config.counters.denied).toBe(1);
  });

  it('parks in ask mode and does NOT answer, so nothing is fabricated', async () => {
    const { client, sent } = fakeClient();
    const p = new ApprovalPolicy({ mode: 'ask' });
    await p.handle(client, 'server-1', 'interaction/requestPermission', {
      sessionId: 's',
      requestId: 'r1',
      toolName: 'Bash',
      riskLevel: 'critical',
      reason: 'wants to run a shell command',
    });
    expect(sent).toHaveLength(0);
    const pending = p.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ requestId: 'r1', toolName: 'Bash', riskLevel: 'critical', sessionId: 's' });
  });

  it('parks a user-input request rather than inventing an answer', async () => {
    const { client, sent } = fakeClient();
    const p = new ApprovalPolicy({ mode: 'allow' });
    await p.handle(client, 'server-2', 'interaction/requestUserInput', { sessionId: 's', requestId: 'q1' });
    expect(sent).toHaveLength(0);
    expect(p.pending()[0]!.method).toBe('interaction/requestUserInput');
  });

  it('answers provider headers with an empty object, since the key lives in the env', async () => {
    const { client, sent } = fakeClient();
    await new ApprovalPolicy().handle(client, 'server-3', 'interaction/requestProviderRuntimeHeaders', {});
    expect(sent[0]!.payload).toEqual({});
  });

  it('refuses official MCP auth honestly instead of pretending to have a trust validator', async () => {
    const { client, sent } = fakeClient();
    await new ApprovalPolicy().handle(client, 'server-4', 'interaction/requestOfficialMcpAuthHeaders', {});
    expect(sent[0]!.payload).toEqual({ ok: false, reason: 'official_auth_unavailable' });
  });

  it('answers runtime preferences immediately so the turn cannot stall on them', async () => {
    const { client, sent } = fakeClient();
    await new ApprovalPolicy().handle(client, 'server-5', 'session/requestRuntimePreferences', {});
    expect(sent[0]!.payload).toMatchObject({
      askUserQuestionAutoResolutionEnabled: true,
      nativeSearchEnhancementsEnabled: true,
      memoryEnabled: false,
    });
  });

  it('answers browser requests with "no browser" rather than leaving them hanging', async () => {
    const { client, sent } = fakeClient();
    const p = new ApprovalPolicy();
    await p.handle(client, 'server-6', 'interaction/browserList', {});
    await p.handle(client, 'server-7', 'interaction/browserExecute', { command: 'navigate' });
    expect(sent[0]!.payload).toEqual({ browsers: [] });
    const exec = sent[1]!.payload as { ok: boolean; error: { code: string } };
    expect(exec.ok).toBe(false);
    expect(exec.error.code).toBe('backend_unavailable');
  });

  it('refuses an unknown request instead of hanging on it', async () => {
    const { client, sent } = fakeClient();
    await new ApprovalPolicy().handle(client, 'server-8', 'interaction/somethingNew', {});
    expect(sent[0]!.kind).toBe('error');
    expect((sent[0]!.payload as { code: number }).code).toBe(-32601);
    expect(new ApprovalPolicy().config.counters.unmatched).toBe(0); // fresh instance, counted below
  });

  it('counts an unmatched request', async () => {
    const { client } = fakeClient();
    const p = new ApprovalPolicy();
    await p.handle(client, 'x', 'interaction/unknown', {});
    expect(p.config.counters.unmatched).toBe(1);
  });

  it('does not throw when settling fails, so the message loop survives', async () => {
    const client = {
      respond: async () => {
        throw new Error('ZCode agent stdio transport is closed');
      },
      respondError: async () => {
        throw new Error('closed');
      },
    } as unknown as ZCodeProtocolClient;
    await expect(new ApprovalPolicy().handle(client, 'x', 'interaction/browserList', {})).resolves.toBeUndefined();
  });
});

describe('ApprovalPolicy — resolving a parked request', () => {
  async function parked(mode: 'ask' = 'ask') {
    const f = fakeClient();
    const p = new ApprovalPolicy({ mode });
    await p.handle(f.client, 'server-1', 'interaction/requestPermission', {
      sessionId: 's',
      requestId: 'r1',
      toolName: 'Bash',
    });
    return { ...f, policy: p };
  }

  it('answers on the protocol id it was parked under, and clears the queue', async () => {
    const { client, policy, sent } = await parked();
    const res = await policy.resolve('r1', 'allow', client);
    expect(res.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.id).toBe('server-1');
    expect(sent[0]!.payload).toMatchObject({ decision: 'allow' });
    expect(policy.pending()).toHaveLength(0);
  });

  it('reports an unknown request id rather than silently succeeding', async () => {
    const { client, policy } = await parked();
    const res = await policy.resolve('nope', 'allow', client);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('not pending');
  });

  it('carries a modified input and a reason through', async () => {
    const { client, policy, sent } = await parked();
    await policy.resolve('r1', 'modify', client, { reason: 'narrowed', modifiedInput: { command: 'ls' } });
    expect(sent[0]!.payload).toMatchObject({
      decision: 'modify',
      reason: 'narrowed',
      modifiedInput: { command: 'ls' },
    });
  });

  it('refuses a durable rule unless explicitly enabled, because it changes future authority', async () => {
    const { client, policy } = await parked();
    const res = await policy.resolve('r1', 'allow', client, {
      persistRule: { behavior: 'allow', rules: [{ tool_name: 'Bash', rule_content: 'git *' }] },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('ZCODE_MCP_ALLOW_PERSIST_RULES');
    // The request must still be pending: a refused rule write must not consume it.
    expect(policy.pending()).toHaveLength(1);
  });

  it('emits the rule in the protocol shape when enabled', async () => {
    const f = fakeClient();
    const p = new ApprovalPolicy({ mode: 'ask', allowPersistRules: true });
    await p.handle(f.client, 'server-1', 'interaction/requestPermission', { sessionId: 's', requestId: 'r1', toolName: 'Bash' });
    const res = await p.resolve('r1', 'allow', f.client, {
      persistRule: { behavior: 'allow', rules: [{ tool_name: 'Bash', rule_content: 'git *' }] },
    });
    expect(res.ok).toBe(true);
    const payload = f.sent[0]!.payload as { permissionUpdates: unknown[] };
    expect(payload.permissionUpdates).toEqual([
      { type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: 'git *' }] },
    ]);
  });
});

describe('policyFromEnv', () => {
  it('defaults to deny with no patterns', () => {
    const p = policyFromEnv({});
    expect(p.config.mode).toBe('deny');
    expect(p.config.allowPatterns).toEqual([]);
  });

  it('reads the mode, the allowlist and the persist gate', () => {
    const p = policyFromEnv({
      ZCODE_MCP_APPROVAL: 'ask',
      ZCODE_MCP_APPROVAL_ALLOWLIST: 'Read, Bash(git *)',
      ZCODE_MCP_ALLOW_PERSIST_RULES: '1',
    });
    expect(p.config.mode).toBe('ask');
    expect(p.config.allowPatterns).toEqual(['Read', 'Bash(git *)']);
    expect(p.config.allowPersistRules).toBe(true);
  });

  it('falls back to deny on a nonsense mode rather than guessing', () => {
    expect(policyFromEnv({ ZCODE_MCP_APPROVAL: 'yolo' }).config.mode).toBe('deny');
  });
});
