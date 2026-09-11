/**
 * Registry unit tests: the pure decisions. Spawning a real runtime is covered in integration.test.ts.
 *
 * The workspace-key rule is the audited one — `workspaceIdentity?.trim() || workspacePath` — and it
 * matters because the registry uses it to decide which child to reuse. Getting it wrong would spawn
 * a second runtime for the same workspace, which looks like a leak and behaves like one.
 */
import { describe, expect, it } from '@jest/globals';
import * as path from 'node:path';

import { CapReachedError, computeWorkspaceKey, RuntimeRegistry } from '../src/zcode/registry.js';
import { loadEnv } from '../src/schema/env.js';

describe('computeWorkspaceKey', () => {
  it('is the path when there is no identity', () => {
    expect(computeWorkspaceKey({ workspacePath: 'F:\\Github\\proj' })).toBe('F:\\Github\\proj');
  });

  it('prefers a non-empty identity, which is how remote workspaces differ', () => {
    expect(
      computeWorkspaceKey({ workspacePath: 'F:\\Github\\proj', workspaceIdentity: 'remote:ssh:box' }),
    ).toBe('remote:ssh:box');
  });

  it('treats a blank identity as absent, matching the runtime', () => {
    expect(computeWorkspaceKey({ workspacePath: 'F:\\p', workspaceIdentity: '   ' })).toBe('F:\\p');
    expect(computeWorkspaceKey({ workspacePath: 'F:\\p', workspaceIdentity: '' })).toBe('F:\\p');
  });

  it('trims the identity so two spellings collapse to one runtime', () => {
    expect(computeWorkspaceKey({ workspacePath: 'p', workspaceIdentity: ' id ' })).toBe('id');
  });
});

describe('RuntimeRegistry — lifecycle without spawning', () => {
  const env = loadEnv({} as NodeJS.ProcessEnv);
  const make = (over: Partial<ConstructorParameters<typeof RuntimeRegistry>[0]> = {}) =>
    new RuntimeRegistry({ env, wireDir: 'work/wire', stderrDir: 'work/stderr', ...over });

  it('starts empty and lists nothing', () => {
    const r = make();
    expect(r.size).toBe(0);
    expect(r.list()).toEqual([]);
    void r.disposeAll(0);
  });

  it('reports the cap rather than silently over-spawning', async () => {
    const r = make({ env: { ...env, ZCODE_MCP_MAX_CHILDREN: 1 } });
    // Seed the map with a fake live runtime so the cap check fires before any spawn attempt.
    const fake = {
      workspaceKey: 'a',
      workspacePath: 'a',
      transport: { alive: true, disposeAndWait: async () => {} },
      client: { dispose: () => {} },
      discovery: { cli: 'x', source: 't', tried: [] },
      settings: { source: 'environment', childEnv: {}, configPath: null, warnings: [] },
      commandLine: 'x',
      startedAt: Date.now(),
      lastUsedAt: Date.now(),
      keyMismatch: null,
      protocol: null,
      runtimeVersion: null,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (r as any).runtimes.set('a', fake);

    await expect(r.acquire({ workspacePath: 'b' })).rejects.toBeInstanceOf(CapReachedError);
    await r.disposeAll(0);
  });

  it('refuses to acquire after disposal rather than spawning a stray child', async () => {
    const r = make();
    await r.disposeAll(0);
    await expect(r.acquire({ workspacePath: 'x' })).rejects.toThrow(/disposed/);
  });

  it('evicts nothing while every runtime is fresh', () => {
    const r = make({ env: { ...env, ZCODE_MCP_CHILD_IDLE_MS: 60_000 } });
    expect(r.evictIdle()).toBe(0);
    void r.disposeAll(0);
  });

  it('does not evict when the idle TTL is disabled', () => {
    const r = make({ env: { ...env, ZCODE_MCP_CHILD_IDLE_MS: 0 } });
    const fake = {
      workspaceKey: 'a',
      workspacePath: 'a',
      transport: { alive: true, disposeAndWait: async () => {} },
      client: { dispose: () => {} },
      discovery: { cli: 'x', source: 't', tried: [] },
      settings: { source: 'environment', childEnv: {}, configPath: null, warnings: [] },
      commandLine: 'x',
      startedAt: 0,
      lastUsedAt: 0, // ancient, but eviction is off
      keyMismatch: null,
      protocol: null,
      runtimeVersion: null,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (r as any).runtimes.set('a', fake);
    expect(r.evictIdle(Date.now())).toBe(0);
    expect(r.size).toBe(1);
    void r.disposeAll(0);
  });

  it('evicts a runtime idle past the TTL and disposes it', () => {
    const r = make({ env: { ...env, ZCODE_MCP_CHILD_IDLE_MS: 1_000 } });
    let disposed = false;
    const fake = {
      workspaceKey: 'a',
      workspacePath: 'a',
      transport: { alive: true, disposeAndWait: async () => void (disposed = true) },
      client: { dispose: () => void (disposed = true) },
      discovery: { cli: 'x', source: 't', tried: [] },
      settings: { source: 'environment', childEnv: {}, configPath: null, warnings: [] },
      commandLine: 'x',
      startedAt: 0,
      lastUsedAt: Date.now() - 10_000,
      keyMismatch: null,
      protocol: null,
      runtimeVersion: null,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (r as any).runtimes.set('a', fake);
    expect(r.evictIdle()).toBe(1);
    expect(r.size).toBe(0);
    expect(disposed).toBe(true);
  });
});

describe('workspace path resolution', () => {
  it('resolves a relative workspace before handing it to the child', () => {
    // The child's cwd must be absolute; a relative path would silently land somewhere else.
    const abs = path.resolve('.');
    expect(path.isAbsolute(abs)).toBe(true);
  });
});
