/**
 * The approval policy. Not optional.
 *
 * Owning a runtime makes this server the runtime's ONLY client, so the runtime sends *us* the
 * requests a desktop user would normally see:
 *
 *   interaction/requestPermission             a tool needs approval
 *   interaction/requestUserInput              the agent needs a free-form answer
 *   interaction/requestProviderRuntimeHeaders  the agent wants credentials for a provider
 *   interaction/requestOfficialMcpAuthHeaders   the agent wants official-MCP auth headers
 *   session/requestRuntimePreferences          the agent wants runtime preferences
 *   interaction/browserList / browserExecute   the agent wants a browser
 *
 * Unanswered, the turn parks in status `waiting` forever. So every one of these is answered, either
 * from policy or by parking it for `zcode_approval`.
 *
 * Constitution Article V: the default is DENY. An MCP server does not silently acquire the approvals
 * a human would have been asked for.
 */
import { EventEmitter } from 'node:events';

import type { ZCodeProtocolClient } from './protocol.js';

export type ApprovalMode = 'deny' | 'allow' | 'ask';
export type Decision = 'allow' | 'deny' | 'escalate' | 'modify';

export interface PermissionRule {
  behavior: 'allow' | 'deny' | 'ask';
  rules: Array<{ tool_name: string; rule_content?: string }>;
}

export interface PendingRequest {
  requestId: string;
  sessionId: string | null;
  method: string;
  toolName?: string;
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
  reason?: string;
  input?: unknown;
  options?: unknown[];
  receivedAt: number;
  /** The protocol-level id we must answer on. */
  protocolId: string | number;
}

export interface PolicyCounters {
  allowed: number;
  denied: number;
  asked: number;
  parked: number;
  autoAnswered: number;
  unmatched: number;
}

export interface PolicyOptions {
  mode?: ApprovalMode;
  /** Patterns: `ToolName` or `ToolName(rule prefix*)`, matching the CLI's --disallowed-tools syntax. */
  allowPatterns?: string[];
  /** Preferences reported when the runtime asks. */
  preferences?: {
    askUserQuestionAutoResolutionEnabled: boolean;
    nativeSearchEnhancementsEnabled: boolean;
    memoryEnabled: boolean;
  };
  /** Headers to answer `requestProviderRuntimeHeaders` with. Empty by default: the key is in the env. */
  providerHeaders?: Record<string, string>;
  /** Whether the durable-rule path is permitted at all. */
  allowPersistRules?: boolean;
  onEvent?: (e: { kind: 'decision' | 'parked' | 'auto' | 'unmatched'; detail: Record<string, unknown> }) => void;
}

/** Parse `Tool(git *)` into a name plus an optional content pattern. */
export function parsePattern(pattern: string): { tool: string; content: string | null } {
  const m = /^\s*([A-Za-z0-9_.:-]+)\s*(?:\((.*)\))?\s*$/.exec(pattern);
  if (!m) return { tool: pattern.trim(), content: null };
  return { tool: m[1]!, content: m[2] !== undefined && m[2].length > 0 ? m[2] : null };
}

/** Match a tool call against one pattern. `*` is a wildcard at the end, as in the CLI. */
export function matchesPattern(pattern: string, toolName: string, ruleContent?: string): boolean {
  const { tool, content } = parsePattern(pattern);
  if (tool.toLowerCase() !== toolName.toLowerCase()) return false;
  if (content === null) return true;
  const rc = ruleContent ?? '';
  if (content.endsWith('*')) return rc.startsWith(content.slice(0, -1));
  return rc === content;
}

export class ApprovalPolicy extends EventEmitter {
  private readonly mode: ApprovalMode;
  private readonly allowPatterns: string[];
  private readonly allowPersistRules: boolean;
  private readonly providerHeaders: Record<string, string>;
  private readonly preferences: NonNullable<PolicyOptions['preferences']>;
  private readonly onEvent: PolicyOptions['onEvent'];
  private readonly pendingMap = new Map<string, PendingRequest>();
  private readonly counters: PolicyCounters = {
    allowed: 0,
    denied: 0,
    asked: 0,
    parked: 0,
    autoAnswered: 0,
    unmatched: 0,
  };

  constructor(opts: PolicyOptions = {}) {
    super();
    this.mode = opts.mode ?? 'deny';
    this.allowPatterns = opts.allowPatterns ?? [];
    this.allowPersistRules = opts.allowPersistRules ?? false;
    this.providerHeaders = opts.providerHeaders ?? {};
    this.preferences = opts.preferences ?? {
      askUserQuestionAutoResolutionEnabled: true,
      nativeSearchEnhancementsEnabled: true,
      memoryEnabled: false,
    };
    this.onEvent = opts.onEvent;
  }

  get config(): { mode: ApprovalMode; allowPatterns: string[]; allowPersistRules: boolean; counters: PolicyCounters; pending: number } {
    return {
      mode: this.mode,
      allowPatterns: [...this.allowPatterns],
      allowPersistRules: this.allowPersistRules,
      counters: { ...this.counters },
      pending: this.pendingMap.size,
    };
  }

  pending(): PendingRequest[] {
    return [...this.pendingMap.values()].sort((a, b) => a.receivedAt - b.receivedAt);
  }

  /** Decide what this policy would do with a tool call, without answering anything. */
  decide(toolName: string | undefined, ruleContent?: string): Decision {
    if (this.mode === 'allow') return 'allow';
    if (toolName && this.allowPatterns.some((p) => matchesPattern(p, toolName, ruleContent))) return 'allow';
    return 'deny';
  }

  /** Answer a parked request. Rejects an unknown id rather than pretending. */
  resolve(
    requestId: string,
    decision: Decision,
    client: ZCodeProtocolClient,
    opts: { reason?: string; modifiedInput?: unknown; persistRule?: PermissionRule } = {},
  ): Promise<{ ok: boolean; error?: string }> {
    const p = this.pendingMap.get(requestId);
    if (!p) return Promise.resolve({ ok: false, error: `request not pending: ${requestId}` });

    if (opts.persistRule && !this.allowPersistRules) {
      return Promise.resolve({
        ok: false,
        error:
          'persisting a permission rule requires ZCODE_MCP_ALLOW_PERSIST_RULES=1. This is the one call ' +
          'that changes FUTURE authority, so it is gated separately.',
      });
    }

    const result: Record<string, unknown> = { decision };
    if (opts.reason) result.reason = opts.reason;
    if (opts.modifiedInput !== undefined) result.modifiedInput = opts.modifiedInput;
    if (opts.persistRule) {
      result.permissionUpdates = [
        {
          type: 'addRules',
          behavior: opts.persistRule.behavior,
          rules: opts.persistRule.rules.map((r) => ({
            toolName: r.tool_name,
            ...(r.rule_content ? { ruleContent: r.rule_content } : {}),
          })),
        },
      ];
    }

    this.pendingMap.delete(requestId);
    this.counters[decision === 'allow' ? 'allowed' : 'denied']++;
    this.emit('decision', { requestId, decision });
    this.onEvent?.({ kind: 'decision', detail: { requestId, decision } });
    return client
      .respond(p.protocolId, result)
      .then(() => ({ ok: true }))
      .catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  }

  /**
   * Answer one server->client request. Always settles: either with a response the runtime accepts,
   * or with an error frame. Never leaves it hanging.
   */
  async handle(client: ZCodeProtocolClient, id: string | number, method: string, params: unknown): Promise<void> {
    const p = (params ?? {}) as Record<string, unknown>;
    const str = (k: string): string | null => (typeof p[k] === 'string' ? (p[k] as string) : null);

    try {
      switch (method) {
        case 'interaction/requestPermission': {
          const requestId = str('requestId') ?? String(id);
          const sessionId = str('sessionId');
          const toolName = str('toolName') ?? undefined;
          const ruleContent = typeof p.ruleContent === 'string' ? p.ruleContent : undefined;

          if (this.mode === 'ask') {
            this.park({ requestId, sessionId, method, toolName, protocolId: id, params: p });
            return; // deliberately unresolved: zcode_approval must answer it
          }
          const decision = this.decide(toolName, ruleContent);
          if (decision === 'allow') this.counters.allowed++;
          else this.counters.denied++;
          this.onEvent?.({ kind: 'decision', detail: { requestId, decision, toolName } });
          await client.respond(id, {
            decision,
            reason:
              decision === 'deny'
                ? `denied by mnehmos.zcode.mcp policy (mode=${this.mode}). Set ZCODE_MCP_APPROVAL=ask to ` +
                  'resolve these individually, or add an allow pattern.'
                : 'allowed by mnehmos.zcode.mcp policy',
          });
          return;
        }

        case 'interaction/requestUserInput': {
          const requestId = str('requestId') ?? String(id);
          this.park({ requestId, sessionId: str('sessionId'), method, protocolId: id, params: p });
          // Parking is the honest answer: we cannot invent a user's input. If the caller never
          // resolves it, the turn stalls visibly rather than receiving a fabricated value.
          return;
        }

        case 'interaction/requestProviderRuntimeHeaders': {
          // The credential travels in the child's environment, so we have no headers to add here.
          // Answering with an empty object lets the call proceed under the env-supplied key.
          this.counters.autoAnswered++;
          await client.respond(id, this.providerHeaders);
          return;
        }

        case 'interaction/requestOfficialMcpAuthHeaders': {
          this.counters.autoAnswered++;
          // We have no desktop trust validator, and must not pretend to.
          await client.respond(id, { ok: false, reason: 'official_auth_unavailable' });
          return;
        }

        case 'session/requestRuntimePreferences': {
          this.counters.autoAnswered++;
          await client.respond(id, { ...this.preferences });
          return;
        }

        case 'interaction/browserList': {
          this.counters.autoAnswered++;
          await client.respond(id, { browsers: [] });
          return;
        }

        case 'interaction/browserExecute': {
          this.counters.autoAnswered++;
          await client.respond(id, {
            ok: false,
            error: { code: 'backend_unavailable', message: 'browser control is not available in this server' },
            elapsedMs: 0,
          });
          return;
        }

        default: {
          this.counters.unmatched++;
          this.onEvent?.({ kind: 'unmatched', detail: { method } });
          // Refuse rather than hang. A method we do not know is still a request that must settle.
          await client.respondError(id, {
            code: -32601,
            message: `unsupported client request: ${method}`,
          });
          return;
        }
      }
    } catch (err) {
      // Settling failed (usually a dead transport). Nothing more we can do, but do not throw into
      // the notification handler, which would take down the message loop.
      this.onEvent?.({
        kind: 'unmatched',
        detail: { method, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  private park(input: {
    requestId: string;
    sessionId: string | null;
    method: string;
    protocolId: string | number;
    params: Record<string, unknown>;
    toolName?: string;
  }): void {
    const risk = input.params.riskLevel;
    this.pendingMap.set(input.requestId, {
      requestId: input.requestId,
      sessionId: input.sessionId,
      method: input.method,
      protocolId: input.protocolId,
      receivedAt: Date.now(),
      ...(input.toolName ? { toolName: input.toolName } : {}),
      ...(risk === 'low' || risk === 'medium' || risk === 'high' || risk === 'critical' ? { riskLevel: risk } : {}),
      ...(typeof input.params.reason === 'string' ? { reason: input.params.reason } : {}),
      ...(input.params.input !== undefined ? { input: input.params.input } : {}),
      ...(Array.isArray(input.params.options) ? { options: input.params.options } : {}),
    });
    this.counters.parked++;
    this.counters.asked++;
    this.emit('parked', { requestId: input.requestId, method: input.method });
    this.onEvent?.({ kind: 'parked', detail: { requestId: input.requestId, method: input.method } });
  }

  /**
   * Wire this policy into a client's server-request stream. Returns an unsubscribe fn.
   * The policy must be attached before the first turn, or turns can park with nobody listening.
   */
  attach(client: ZCodeProtocolClient): () => void {
    const handler = (id: string | number, method: string, params: unknown) => {
      void this.handle(client, id, method, params);
    };
    client.on('request', handler);
    return () => client.off('request', handler);
  }
}

/** Build a policy from the parsed environment. */
export function policyFromEnv(
  env: {
    ZCODE_MCP_APPROVAL?: string;
    ZCODE_MCP_APPROVAL_ALLOWLIST?: string;
    ZCODE_MCP_ALLOW_PERSIST_RULES?: string;
  },
  opts: { onEvent?: PolicyOptions['onEvent'] } = {},
): ApprovalPolicy {
  const mode = (env.ZCODE_MCP_APPROVAL ?? 'deny') as ApprovalMode;
  const allowPatterns = (env.ZCODE_MCP_APPROVAL_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const truthy = (v: string | undefined) => v !== undefined && ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
  return new ApprovalPolicy({
    mode: ['deny', 'allow', 'ask'].includes(mode) ? mode : 'deny',
    allowPatterns,
    allowPersistRules: truthy(env.ZCODE_MCP_ALLOW_PERSIST_RULES),
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
  });
}
