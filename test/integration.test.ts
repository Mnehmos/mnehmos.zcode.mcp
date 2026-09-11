/**
 * The M1 gate: prove the transport against the real ZCode agent runtime.
 *
 * Opt-in via ZCODE_MCP_IT=1 because it needs an installed ZCode. It does NOT run a model turn,
 * so it costs nothing — it only exercises `session/list` and an error path.
 *
 *   ZCODE_MCP_IT=1 npm run test:it
 *
 * What this asserts, in order of what would hurt most if it broke:
 *   1. the runtime is discoverable and spawnable
 *   2. it answers `session/list` with real data          <- the whole project rests on this
 *   3. an unknown method returns -32601                  <- the envelope is what we think it is
 *   4. an oversized frame is refused locally             <- no half-written frames, ever
 *   5. disposing leaves no orphan process                <- Constitution Article VI
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { discoverRuntime, resolveNode } from '../src/schema/env.js';
import {
  createTransport,
  ZCODE_FRAME_LIMIT_BYTES,
  type ZCodeStdioTransport,
  type Inbound,
} from '../src/zcode/transport.js';

const enabled = process.env.ZCODE_MCP_IT === '1';
const discovery = discoverRuntime();
const node = resolveNode();
const scratch = path.resolve('work', 'scratch');

/** Send one frame and resolve with the first frame that answers it. */
function call(t: ZCodeStdioTransport, id: number, method: string, params: unknown, timeoutMs = 45_000) {
  return new Promise<Inbound>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeoutMs);
    const onMessage = (m: Inbound) => {
      if ((m.kind === 'result' || m.kind === 'error') && String(m.id) === String(id)) {
        clearTimeout(timer);
        t.off('message', onMessage);
        resolve(m);
      }
    };
    t.on('message', onMessage);
    t.send({ id, method, params }).catch((err) => {
      clearTimeout(timer);
      t.off('message', onMessage);
      reject(err);
    });
  });
}

/** Is this pid still present? Used to prove the process tree was reaped. */
function pidAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8' });
      return out.includes(`"${pid}"`);
    }
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('integration: real ZCode runtime', () => {
  let t: ZCodeStdioTransport | null = null;

  beforeAll(() => {
    if (!enabled) return;
    fs.mkdirSync(scratch, { recursive: true });
  });

  afterAll(async () => {
    if (t) await t.disposeAndWait(5_000);
    if (enabled) fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('discovers a runtime bundle', () => {
    if (!enabled) return;
    expect(discovery.cli).toBeTruthy();
    // eslint-disable-next-line no-console
    console.log(`[it] runtime: ${discovery.cli}  (via ${discovery.source})`);
  });

  it('spawns and answers session/list with real data', async () => {
    if (!enabled) return;
    expect(discovery.cli).toBeTruthy();

    t = createTransport({
      cli: discovery.cli!,
      node,
      cwd: scratch,
      runId: 'it-session-list',
      wireDir: path.resolve('work', 'wire'),
      stderrDir: path.resolve('work', 'stderr'),
    });

    const reply = await call(t, 1, 'session/list', {});
    expect(reply.kind).toBe('result');
    if (reply.kind !== 'result') return;

    const result = reply.result as { sessions?: unknown[] };
    expect(Array.isArray(result.sessions)).toBe(true);

    // The schema is the contract: these keys must be present on every session.
    const sessions = result.sessions as Array<Record<string, unknown>>;
    // eslint-disable-next-line no-console
    console.log(`[it] session/list returned ${sessions.length} session(s)`);
    for (const s of sessions.slice(0, 3)) {
      expect(s).toHaveProperty('sessionId');
      expect(s).toHaveProperty('status');
      expect(s).toHaveProperty('workspace');
      const ws = s.workspace as Record<string, unknown>;
      expect(ws).toHaveProperty('workspaceKey');
      expect(ws).toHaveProperty('workspacePath');
    }
  }, 60_000);

  it('returns -32601 for an unknown method', async () => {
    if (!enabled || !t) return;
    const reply = await call(t, 2, 'definitely/not-a-method', {});
    expect(reply.kind).toBe('error');
    if (reply.kind !== 'error') return;
    expect(reply.error.code).toBe(-32601);
    expect(reply.error.message).toContain('definitely/not-a-method');
  }, 60_000);

  it('refuses an oversized frame before writing it', async () => {
    if (!enabled || !t) return;
    const huge = 'x'.repeat(ZCODE_FRAME_LIMIT_BYTES + 64);
    await expect(t.send({ id: 3, method: 'session/list', params: { pad: huge } })).rejects.toThrow(
      /1 MiB inline frame limit/,
    );
  }, 30_000);

  it('leaves no orphan process after dispose', async () => {
    if (!enabled || !t) return;
    const pid = t.pid;
    expect(pid).toBeDefined();
    await t.disposeAndWait(5_000);
    expect(t.alive).toBe(false);
    // Give the OS a beat to reap, then insist the pid is gone.
    await new Promise((r) => setTimeout(r, 500));
    expect(pidAlive(pid)).toBe(false);
    t = null;
  }, 30_000);

  /**
   * The M2 gate: a provider reaches the runtime, and the runtime reports it.
   *
   * This is the second critical-path item. It proves the environment bootstrap works by observing
   * `model.current` change from the sentinel `missing-model` to the injected one, and
   * `modelCatalog.available` become non-empty.
   *
   * It costs nothing: no turn is started, so no model call is made. The base URL is deliberately
   * unresolvable so that even if something did try to reach out, it cannot.
   */
  describe('provider bootstrap (M2)', () => {
    async function readModel(env: NodeJS.ProcessEnv) {
      const child = createTransport({
        cli: discovery.cli!,
        node,
        cwd: scratchForProvider(),
        runId: `it-provider-${Object.keys(env).length}`,
        env,
      });
      try {
        const reply = await call(child, 1, 'workspace/readState', {
          workspace: { workspacePath: scratchForProvider(), workspaceKey: scratchForProvider() },
        });
        if (reply.kind !== 'result') throw new Error(`readState failed: ${JSON.stringify(reply)}`);
        const r = reply.result as {
          settings?: { model?: { current?: { modelId?: string; providerId?: string } } };
          modelCatalog?: { available?: unknown[] };
        };
        return {
          current: r.settings?.model?.current ?? {},
          available: r.modelCatalog?.available?.length ?? 0,
        };
      } finally {
        await child.disposeAndWait(4_000);
      }
    }

    it('reports the sentinel when no provider is configured', async () => {
      if (!enabled) return;
      const { current } = await readModel({});
      // A clean child with no provider must self-report as unconfigured, not pretend.
      expect(current.modelId).toBe('missing-model');
      expect(current.providerId).toBe('zcode-unconfigured');
    }, 60_000);

    it('picks up ZCODE_MODEL and exposes it in the catalogue', async () => {
      if (!enabled) return;
      const { current, available } = await readModel({
        ZCODE_MODEL: 'mcp-probe/probe-model',
        ZCODE_BASE_URL: 'https://example.invalid/v1',
        ZCODE_API_KEY: 'probe-not-a-real-key',
      });
      expect(current.modelId).toBe('probe-model');
      expect(current.providerId).toBe('mcp-probe');
      expect(available).toBeGreaterThan(0);
    }, 60_000);
  });
});

let providerScratch: string | null = null;
function scratchForProvider(): string {
  if (!providerScratch) {
    providerScratch = path.resolve('work', 'scratch-provider');
    fs.mkdirSync(providerScratch, { recursive: true });
  }
  return providerScratch;
}
