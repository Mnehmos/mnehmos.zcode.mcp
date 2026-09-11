/**
 * The runtime registry: one ZCode agent runtime per workspace, lazily spawned and reused.
 *
 * Keyed on `workspaceKey`, which is ZCode's own join key across sessions, subscriptions and event
 * maps. The derivation rule is now known from the audit —
 *
 *     workspaceKey = workspaceIdentity?.trim() || workspacePath
 *
 * — so we can compute it to decide *which child to reuse*, while still treating whatever ZCode
 * reports back as authoritative and warning on a mismatch. Computing it is only used for cache
 * lookup; it is never passed to ZCode as if we had invented it.
 *
 * Constitution Article VI: bounded children, idle eviction, and an owned process group killed and
 * verified on every exit path.
 */
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

import { discoverRuntime, discoveryFailure, resolveNode, type Discovery, type Env } from '../schema/env.js';
import { ZCodeProtocolClient } from './protocol.js';
import { createTransport, type ZCodeStdioTransport } from './transport.js';
import { bootstrapProvider, targetFromEnv, type BootstrapResult, type ModelTarget } from './settings.js';

export interface WorkspaceRef {
  workspacePath: string;
  workspaceIdentity?: string;
}

/**
 * The audited rule: `workspaceIdentity?.trim() || workspacePath`.
 *
 * The path component is normalised with `path.resolve`, because the same directory arrives spelled
 * differently depending on who supplied it — an .env written with forward slashes, a caller passing
 * a trailing separator, a relative path. ZCode reports the native form, and comparing raw strings
 * made an identical workspace look like a mismatch.
 *
 * `workspaceIdentity` is NOT a path and is never resolved: it is an opaque key the desktop invents
 * for remote workspaces.
 */
export function computeWorkspaceKey(ref: WorkspaceRef): string {
  const identity = ref.workspaceIdentity?.trim();
  if (identity && identity.length > 0) return identity;
  try {
    return path.resolve(ref.workspacePath);
  } catch {
    return ref.workspacePath;
  }
}

export interface Runtime {
  readonly workspaceKey: string;
  readonly workspacePath: string;
  readonly transport: ZCodeStdioTransport;
  readonly client: ZCodeProtocolClient;
  readonly discovery: Discovery;
  readonly settings: BootstrapResult;
  readonly commandLine: string;
  startedAt: number;
  lastUsedAt: number;
  /** Set when ZCode reported a workspaceKey different from the one we computed. */
  keyMismatch: { computed: string; reported: string } | null;
  /** Protocol identity, filled in on first contact. */
  protocol: { name: string; version: number } | null;
  runtimeVersion: string | null;
}

export interface RegistryOptions {
  env: Env;
  /** Override for tests: pretend this is the discovered bundle. */
  cliOverride?: string;
  /**
   * The provider for newly spawned runtimes. A getter, not a value, so a runtime started after a
   * `zcode_models select scope=server` picks up the new default without re-creating the registry.
   */
  targetProvider?: () => ModelTarget | undefined;
  /** Wire/ stderr directories, passed through to each transport. */
  wireDir: string;
  stderrDir: string;
  /**
   * Called once a runtime is alive and has answered its first request, BEFORE acquire() returns.
   *
   * This is the hook that closes the deadlock window: the event buffer and the approval policy must
   * be attached before anyone can start a turn, or an `interaction/*` request can arrive with
   * nobody listening and park the turn in `waiting` forever.
   */
  onReady?: (runtime: Runtime) => void;
}

export class CapReachedError extends Error {
  constructor(readonly cap: number) {
    super(
      `runtime cap reached (${cap}). Wait for an idle runtime to be evicted, or raise ` +
        'ZCODE_MCP_MAX_CHILDREN. Each runtime is a separate ZCode agent process.',
    );
    this.name = 'CapReachedError';
  }
}

export class RuntimeRegistry {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly spawning = new Map<string, Promise<Runtime>>();
  private disposed = false;
  /** `zcode version` is asked once per registry, not once per runtime. */
  private versionPromise: Promise<string | null> | null = null;

  constructor(private readonly opts: RegistryOptions) {}

  private get discovery(): Discovery {
    return this.opts.cliOverride
      ? { cli: this.opts.cliOverride, source: 'test override', tried: [] }
      : discoverRuntime();
  }

  /**
   * Get a live runtime for this workspace, spawning one if needed.
   *
   * Concurrent callers for the same key share a single spawn — two awaits must not create two
   * children.
   */
  async acquire(ref: WorkspaceRef): Promise<Runtime> {
    if (this.disposed) throw new Error('runtime registry is disposed');

    const workspaceKey = computeWorkspaceKey(ref);
    const existing = this.runtimes.get(workspaceKey);
    if (existing && existing.transport.alive) {
      existing.lastUsedAt = Date.now();
      return existing;
    }
    if (existing) {
      // A dead child: drop it and respawn below. Its process group is already gone.
      this.runtimes.delete(workspaceKey);
      existing.client.dispose();
    }

    const inFlight = this.spawning.get(workspaceKey);
    if (inFlight) return inFlight;

    const spawn = this.spawn(ref, workspaceKey).finally(() => this.spawning.delete(workspaceKey));
    this.spawning.set(workspaceKey, spawn);
    return spawn;
  }

  private async spawn(ref: WorkspaceRef, workspaceKey: string): Promise<Runtime> {
    this.evictIdle();
    if (this.runtimes.size >= this.opts.env.ZCODE_MCP_MAX_CHILDREN) {
      throw new CapReachedError(this.opts.env.ZCODE_MCP_MAX_CHILDREN);
    }

    const discovery = this.discovery;
    if (!discovery.cli) throw new Error(discoveryFailure(discovery));

    // The child's cwd must be the workspace: it is how the agent resolves the project, the
    // config walk-up, and the shell's working directory.
    const cwd = path.resolve(ref.workspacePath);

    const target = this.opts.targetProvider?.() ?? targetFromEnv();
    const settings = bootstrapProvider({ workspace: cwd, ...(target ? { target } : {}) });

    const runId = `${sanitize(workspaceKey)}-${Date.now()}`;
    const node = resolveNode();
    const transport = createTransport({
      cli: discovery.cli,
      node,
      cwd,
      runId,
      wireDir: this.opts.wireDir,
      stderrDir: this.opts.stderrDir,
      env: settings.childEnv,
    });
    const client = new ZCodeProtocolClient(transport, this.opts.env.ZCODE_MCP_TIMEOUT_MS);

    const runtime: Runtime = {
      workspaceKey,
      workspacePath: cwd,
      transport,
      client,
      discovery,
      settings,
      commandLine: `${node} ${discovery.cli} app-server --stdio --cwd ${cwd}`,
      startedAt: Date.now(),
      lastUsedAt: Date.now(),
      keyMismatch: null,
      protocol: null,
      runtimeVersion: null,
    };

    this.runtimes.set(workspaceKey, runtime);

    // First contact doubles as the startup gate: if the runtime cannot answer, the caller finds out
    // here rather than at the tool call it actually cared about.
    try {
      await this.verifyFirstContact(runtime);
    } catch (err) {
      this.runtimes.delete(workspaceKey);
      client.dispose();
      await transport.disposeAndWait(2_000);
      throw err;
    }

    // Attach subscribers before returning, so no caller can start a turn against a runtime with no
    // policy listening.
    this.opts.onReady?.(runtime);
    return runtime;
  }

  /**
   * The runtime's own version, read once from `zcode version`.
   *
   * The envelope promises a version, and a caller diagnosing a protocol mismatch needs the real one
   * rather than "unknown". This spawns a short-lived process with no model involvement, and the
   * result is memoised for the life of the registry.
   */
  private runtimeVersion(discovery: Discovery): Promise<string | null> {
    this.versionPromise ??= (async () => {
      try {
        const { stdout } = await execFileAsync(resolveNode(), [discovery.cli as string, 'version'], {
          timeout: 30_000,
          windowsHide: true,
        });
        const v = stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? null;
        return v && v.length > 0 ? v : null;
      } catch {
        return null;
      }
    })();
    return this.versionPromise;
  }

  /**
   * Ask the cheapest possible question and use the answer to establish identity.
   * `session/list` works with empty params and is read-only, so it is safe for any caller.
   */
  private async verifyFirstContact(runtime: Runtime): Promise<void> {
    const result = await runtime.client.request<{
      sessions?: Array<{ workspace?: { workspaceKey?: string; workspacePath?: string } }>;
    }>('session/list', {}, { timeoutMs: this.opts.env.ZCODE_MCP_STARTUP_MS });
    runtime.lastUsedAt = Date.now();
    runtime.protocol = { name: 'ZCode Protocol', version: 1 };
    runtime.runtimeVersion = await this.runtimeVersion(runtime.discovery);

    // Cross-check the workspace key ONLY against a session that is in this workspace. Comparing
    // against whichever session happens to be first would warn about an unrelated project, which is
    // noise that trains a reader to ignore the warning.
    for (const s of result?.sessions ?? []) {
      const reported = s.workspace?.workspaceKey;
      const reportedPath = s.workspace?.workspacePath;
      const sameWorkspace =
        reportedPath !== undefined && path.resolve(reportedPath) === path.resolve(runtime.workspacePath);
      if (!sameWorkspace) continue;
      // Compare canonically: ZCode may report a different separator from the one we were handed.
      const canonical = (v: string) => {
        try {
          return path.resolve(v);
        } catch {
          return v;
        }
      };
      if (typeof reported === 'string' && reported.length > 0 && canonical(reported) !== canonical(runtime.workspaceKey)) {
        runtime.keyMismatch = { computed: runtime.workspaceKey, reported };
      }
      break;
    }
  }

  /** Evict runtimes idle past the threshold. Safe to call at any time. */
  evictIdle(now = Date.now()): number {
    const ttl = this.opts.env.ZCODE_MCP_CHILD_IDLE_MS;
    if (ttl <= 0) return 0;
    let evicted = 0;
    for (const [key, rt] of this.runtimes) {
      if (now - rt.lastUsedAt < ttl) continue;
      this.runtimes.delete(key);
      rt.client.dispose();
      void rt.transport.disposeAndWait(3_000);
      evicted++;
    }
    return evicted;
  }

  /** Runtimes that are still alive, for `zcode_status runtimes`. */
  list(): Runtime[] {
    return [...this.runtimes.values()].filter((r) => r.transport.alive);
  }

  get size(): number {
    return this.runtimes.size;
  }

  /** Kill everything we own and wait for it. */
  async disposeAll(graceMs = 5_000): Promise<void> {
    this.disposed = true;
    const all = [...this.runtimes.values()];
    this.runtimes.clear();
    await Promise.all(
      all.map(async (rt) => {
        rt.client.dispose();
        await rt.transport.disposeAndWait(graceMs);
      }),
    );
  }
}

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-60);
}
