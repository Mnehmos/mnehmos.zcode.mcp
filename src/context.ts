/**
 * The server context: everything a dispatcher needs, assembled once.
 *
 * This exists so no dispatcher has to know how a runtime is spawned, where the audit database lives,
 * or whether the policy is attached. It also owns the one invariant that would be catastrophic to
 * get wrong: **a runtime is never handed to a caller before its event buffer and approval policy are
 * attached.**
 */
import { EventEmitter } from 'node:events';

import { ensureDirs, loadEnv, type Env } from './schema/env.js';
import { AuditDb, openAuditDb } from './storage/db.js';
import { attachEventBuffer, EventBuffer } from './zcode/events.js';
import { policyFromEnv, type ApprovalPolicy } from './zcode/policy.js';
import { RuntimeRegistry, type Runtime, type WorkspaceRef } from './zcode/registry.js';
import { targetFromEnv, type ModelTarget } from './zcode/settings.js';
import type { Envelope, RuntimeIdentity } from './envelope.js';
import { redact } from './zcode/redact.js';

export interface ContextDirs {
  work: string;
  wire: string;
  stdout: string;
  stderr: string;
  reports: string;
  settings: string;
  db: string;
}

export interface RuntimeContext {
  runtime: Runtime;
  buffer: EventBuffer;
  policy: ApprovalPolicy;
}

export class ServerContext extends EventEmitter {
  readonly env: Env;
  readonly dirs: ContextDirs;
  readonly db: AuditDb | null;
  readonly registry: RuntimeRegistry;
  /** Set when the audit database could not be opened; callers surface it rather than failing. */
  readonly dbError: string | null;

  private readonly byWorkspace = new Map<string, RuntimeContext>();
  /**
   * The provider newly spawned runtimes will use.
   *
   * Seeded from the environment; `zcode_models select scope=server` may change it for this process.
   * It is NOT persisted, and existing runtimes keep their model — both of which the tool states
   * rather than leaves for the caller to discover.
   */
  private active: ModelTarget | undefined;

  constructor(env: Env = loadEnv()) {
    super();
    this.env = env;
    this.dirs = ensureDirs(env);
    this.active = targetFromEnv();
    const opened = openAuditDb(env.ZCODE_MCP_DB);
    this.db = opened;
    this.dbError = opened ? null : `could not open the audit database at ${env.ZCODE_MCP_DB}`;
    this.registry = new RuntimeRegistry({
      env,
      wireDir: this.dirs.wire,
      stderrDir: this.dirs.stderr,
      onReady: (rt) => this.attachSubscribers(rt),
      // Read per spawn, so a runtime started after a selection uses it.
      targetProvider: () => this.active,
    });
  }

  /** The provider current for newly spawned runtimes. */
  activeTarget(): ModelTarget | undefined {
    return this.active;
  }

  /** Set the in-process default. Not persisted; the caller is told so. */
  setActiveTarget(t: ModelTarget | undefined): void {
    this.active = t;
  }

  /**
   * Attach the event buffer and the approval policy to a freshly spawned runtime.
   * Idempotent: a respawned runtime for the same workspace replaces the previous pair.
   */
  private attachSubscribers(rt: Runtime): RuntimeContext {
    const existing = this.byWorkspace.get(rt.workspaceKey);
    existing?.buffer.dispose();

    const buffer = new EventBuffer(this.env.ZCODE_MCP_EVENT_BUFFER);
    const policy = policyFromEnv(this.env, {
      onEvent: (e) => this.emit('policy', { workspaceKey: rt.workspaceKey, ...e }),
    });

    attachEventBuffer(rt.client, buffer);
    policy.attach(rt.client);

    const ctx: RuntimeContext = { runtime: rt, buffer, policy };
    this.byWorkspace.set(rt.workspaceKey, ctx);
    return ctx;
  }

  /** Get the runtime for a workspace, spawning and wiring one if needed. */
  async acquire(ref: WorkspaceRef): Promise<RuntimeContext> {
    const rt = await this.registry.acquire(ref);
    const existing = this.byWorkspace.get(rt.workspaceKey);
    if (existing && existing.runtime === rt) return existing;
    // A runtime that came back from a dead state was re-attached by onReady; if somehow not, attach.
    return this.attachSubscribers(rt);
  }

  /** The context for an already-live runtime, without spawning. */
  peek(workspaceKey: string): RuntimeContext | null {
    return this.byWorkspace.get(workspaceKey) ?? null;
  }

  runtimeIdentity(rt: Runtime): RuntimeIdentity {
    return {
      version: rt.runtimeVersion ?? 'unknown',
      protocol: rt.protocol ?? { name: 'ZCode Protocol', version: 1 },
      transport: 'stdio',
      workspace_key: rt.workspaceKey,
      discovered_via: rt.discovery.source,
    };
  }

  /** Persist a finished envelope. Never throws: an audit failure must not fail the call. */
  record(envelope: Envelope, runId: string, extra: { sessionId?: string | null; command?: string | null } = {}): void {
    if (!this.db) return;
    try {
      this.db.recordRun({
        runId,
        tool: envelope.tool,
        action: envelope.action,
        workspaceKey: envelope.runtime?.workspace_key ?? null,
        sessionId: extra.sessionId ?? null,
        ok: envelope.ok,
        payloadSource: envelope.evidence.payload_source,
        exitCode: envelope.evidence.exit_code,
        durationMs: envelope.evidence.duration_ms,
        timedOut: envelope.evidence.timed_out,
        runtimeVersion: envelope.runtime?.version ?? null,
        protocolVersion: envelope.runtime?.protocol.version ?? null,
        command: extra.command ?? envelope.run?.command ?? null,
        // Redacted on the way in: the audit row is a file that outlives the process.
        warnings: redact(envelope.evidence.warnings),
      });
      for (const [kind, path] of [
        ['wire', envelope.run?.wire],
        ['settings', envelope.run?.settings],
        ['report', `${this.dirs.reports}/${runId}.json`],
      ] as const) {
        if (path) this.db.recordArtifact({ runId, kind, path });
      }
    } catch {
      /* provenance is best-effort by design */
    }
  }

  /** Snapshot for `zcode_status runtimes`. */
  liveRuntimes(): Array<{
    workspace_key: string;
    pid: number | undefined;
    uptime_ms: number;
    transport_state: string;
    policy_mode: string;
    pending_approvals: number;
    events_buffered: number;
    key_mismatch: Runtime['keyMismatch'];
    discovered_via: string | null;
  }> {
    return this.registry.list().map((rt) => {
      const ctx = this.byWorkspace.get(rt.workspaceKey);
      return {
        workspace_key: rt.workspaceKey,
        pid: rt.transport.pid,
        uptime_ms: Date.now() - rt.startedAt,
        transport_state: rt.transport.alive ? 'ready' : 'dead',
        policy_mode: ctx?.policy.config.mode ?? 'unknown',
        pending_approvals: ctx?.policy.pending().length ?? 0,
        events_buffered: ctx?.buffer.stats.buffered ?? 0,
        key_mismatch: rt.keyMismatch,
        discovered_via: rt.discovery.source,
      };
    });
  }

  async dispose(): Promise<void> {
    for (const ctx of this.byWorkspace.values()) ctx.buffer.dispose();
    this.byWorkspace.clear();
    await this.registry.disposeAll();
    this.db?.close();
  }
}
