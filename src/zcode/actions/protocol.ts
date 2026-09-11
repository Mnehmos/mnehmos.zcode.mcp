/**
 * `zcode_protocol` — the escape hatch, and `zcode_headless` — the no-protocol fallback.
 *
 * The escape hatch implements the constitution's substitution principle: a bounded typed surface for
 * normal use, plus one auditable, gated, kill-switchable door for everything else. It is OFF by
 * default and restricted to read-only paths, because its whole purpose is to reach methods no typed
 * tool covers — which is exactly where no read-back and no schema guarantee exist.
 *
 * Headless is the opposite trade: no protocol at all, so it survives a protocol change entirely. Its
 * only failure mode is emitting a flag the CLI does not parse, so it emits only verified ones.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { ServerContext } from '../../context.js';
import type { Envelope } from '../../envelope.js';
import { Outcome, localEnvelope } from '../../envelope.js';
import { AuditDb } from '../../storage/db.js';
import { discoveryFailure, discoverRuntime, resolveNode, VERIFIED_CLI_FLAGS } from '../../schema/env.js';
import { acquireOrFail, describe, finish, newRunId, outcome, read, resolveWorkspace, workspaceRequired } from './_shared.js';
import { bootstrapProvider, targetFromEnv } from '../settings.js';

const execFileAsync = promisify(execFile);

// ── zcode_protocol ───────────────────────────────────────────────────────────

/** Methods callable without the mutation gate. Read-only paths only, by design. */
const DEFAULT_ALLOW = [
  'session/list',
  'session/read',
  'session/messages',
  'session/subagents',
  'session/usage',
  'workspace/readState',
  'v4/commands/query',
  'v4/conversation/rowsRange',
  'v4/conversation/plans',
  'v4/conversation/usage',
  'mcp/list',
  'usage/stats',
  'plugins/list',
  'plugins/overview',
  'plugins/describe',
  'skills/referenceCatalog',
  'automation/list',
];

export function protocolEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.ZCODE_MCP_DISABLE_PROTOCOL ?? '').trim().toLowerCase();
  return !(v === '1' || v === 'true' || v === 'yes' || v === 'on');
}

export function mutationsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.ZCODE_MCP_PROTOCOL_ALLOW_MUTATIONS ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export function allowList(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = (env.ZCODE_MCP_PROTOCOL_ALLOW ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return raw.length > 0 ? raw : DEFAULT_ALLOW;
}

/** Glob-ish match: `session/*` allows every session method. */
export function matchesAllow(method: string, patterns: string[]): boolean {
  return patterns.some((p) => (p.endsWith('*') ? method.startsWith(p.slice(0, -1)) : p === method));
}

/** The method catalogue, kept in-repo so the tool answers without a runtime. */
export const PROTOCOL_METHODS: Array<{ method: string; mutating: boolean; note?: string }> = [
  { method: 'session/create', mutating: true, note: 'creates a session; the row appears on first use' },
  { method: 'session/list', mutating: false },
  { method: 'session/read', mutating: false },
  { method: 'session/messages', mutating: false },
  { method: 'session/events', mutating: false },
  { method: 'session/subscribe', mutating: false, note: 'required before any event arrives' },
  { method: 'session/send', mutating: true },
  { method: 'session/stop', mutating: true, note: 'bypasses the runtime queue' },
  { method: 'session/resume', mutating: true },
  { method: 'session/close', mutating: true },
  { method: 'session/fork', mutating: true },
  { method: 'session/compact', mutating: true },
  { method: 'session/goal', mutating: true },
  { method: 'session/setModel', mutating: true },
  { method: 'session/setMode', mutating: true },
  { method: 'session/setThoughtLevel', mutating: true },
  { method: 'session/subagents', mutating: false },
  { method: 'session/usage', mutating: false },
  { method: 'session/cancelBackgroundTask', mutating: true },
  { method: 'workspace/readState', mutating: false },
  { method: 'workspace/setDefaultModel', mutating: true },
  { method: 'workspace/setDefaultMode', mutating: true },
  { method: 'workspace/setDefaultThoughtLevel', mutating: true },
  { method: 'workspace/updateInteractionPreferences', mutating: true },
  { method: 'workspace/updateModelIoPreferences', mutating: true },
  { method: 'workspace/updateProviderRegistry', mutating: true },
  { method: 'workspace/upsertModelProvider', mutating: true },
  { method: 'workspace/removeModelProvider', mutating: true },
  { method: 'workspace/hooks/trustGrant', mutating: true },
  { method: 'workspace/generateText', mutating: true },
  { method: 'workspace/cancelGenerateText', mutating: true },
  { method: 'v4/command', mutating: true, note: 'admission, not completion' },
  { method: 'v4/commands/query', mutating: false },
  { method: 'v4/conversation/rowsRange', mutating: false },
  { method: 'v4/conversation/plans', mutating: false },
  { method: 'v4/conversation/fileChanges', mutating: false },
  { method: 'v4/conversation/fileRewindPreview', mutating: false },
  { method: 'v4/conversation/usage', mutating: false },
  { method: 'v4/conversation/subscribe', mutating: false },
  { method: 'v4/conversation/unsubscribe', mutating: false },
  { method: 'v4/conversation/resync', mutating: false },
  { method: 'v4/attachment/begin', mutating: true },
  { method: 'v4/attachment/chunk', mutating: true },
  { method: 'v4/attachment/commit', mutating: true },
  { method: 'v4/attachment/abort', mutating: true },
  { method: 'v4/attachment/read', mutating: false },
  { method: 'v4/attachment/previewSource', mutating: false },
  { method: 'v4/usage/stats', mutating: false },
  { method: 'mcp/list', mutating: false, note: 'starts the configured servers' },
  { method: 'usage/stats', mutating: false },
  { method: 'plugins/list', mutating: false },
  { method: 'plugins/overview', mutating: false },
  { method: 'plugins/describe', mutating: false },
  { method: 'plugins/setEnabled', mutating: true },
  { method: 'plugins/install', mutating: true },
  { method: 'plugins/uninstall', mutating: true },
  { method: 'skills/referenceCatalog', mutating: false },
  { method: 'automation/list', mutating: false, note: 'CONFIRMED -32601 on a bare app-server' },
  { method: 'automation/create', mutating: true, note: 'CONFIRMED -32601 on a bare app-server' },
  { method: 'v4/controller/subscribe', mutating: false, note: 'CONFIRMED -32601 on a bare app-server' },
];

export async function protocolDispatch(ctx: ServerContext, args: Record<string, unknown>): Promise<Envelope> {
  const action = String(args.action);
  const env = process.env;

  if (action === 'methods') {
    const filter = typeof args.filter === 'string' ? args.filter.toLowerCase() : '';
    const listed = PROTOCOL_METHODS.filter((m) => !filter || m.method.toLowerCase().includes(filter));
    return localEnvelope({ tool: 'zcode_protocol', action }, {
      enabled: protocolEnabled(env),
      mutations_allowed: mutationsAllowed(env),
      allow_patterns: allowList(env),
      methods: listed,
      count: listed.length,
    }, {
      extra: {
        note:
          'enabled=false means the escape hatch is off entirely. call is restricted to allow_patterns, ' +
          'and a method marked mutating additionally needs ZCODE_MCP_PROTOCOL_ALLOW_MUTATIONS=1.',
      },
    });
  }

  if (action !== 'call') {
    return localEnvelope({ tool: 'zcode_protocol', action }, null, { ok: false, errors: [`unknown action: ${action}`] });
  }

  const runId = newRunId('zcode_protocol', 'call');
  const o = outcome('zcode_protocol', 'call', false);
  const method = String(args.method ?? '');

  if (!protocolEnabled(env)) {
    o.fail('the raw protocol passthrough is disabled (ZCODE_MCP_DISABLE_PROTOCOL). reasonCode: mcp.protocol.disabled');
    return finish(ctx, o, runId);
  }
  const patterns = allowList(env);
  if (!matchesAllow(method, patterns)) {
    o.fail(
      `method "${method}" is not in the allow list. Effective allow list: ${patterns.join(', ')}. ` +
        'reasonCode: mcp.protocol.method_not_allowed',
    );
    return finish(ctx, o, runId);
  }
  const declared = PROTOCOL_METHODS.find((m) => m.method === method);
  if (declared?.mutating && !mutationsAllowed(env)) {
    o.fail(
      `"${method}" is a mutating method and needs ZCODE_MCP_PROTOCOL_ALLOW_MUTATIONS=1. ` +
        'reasonCode: mcp.protocol.mutations_disabled',
    );
    return finish(ctx, o, runId);
  }

  const workspace = resolveWorkspace(ctx, args);
  if (!workspace) return workspaceRequired('zcode_protocol', action);
  const acq = await acquireOrFail(ctx, o, workspace, runId);
  if (!acq) return finish(ctx, o, runId);

  try {
    const value = await read(o, acq.runtime, method, (args.params as Record<string, unknown>) ?? {});
    o.result(value);
    o.readOnly();
    // Always: the typed tools exist precisely because they carry guarantees this does not.
    o.warn(
      'raw_protocol',
      'raw protocol call — no semantic validation, no read-back, and no schema guarantee were applied',
      'unreliable',
    );
  } catch (err) {
    if (declared?.note?.includes('-32601')) {
      o.warn('method_not_supported', `${method} is not implemented on a bare app-server (${declared.note})`, 'unreliable');
    }
    o.fail(describe(err));
  }
  return finish(ctx, o, runId);
}

// ── zcode_headless ───────────────────────────────────────────────────────────

const ACCEPTED = new Set<string>(VERIFIED_CLI_FLAGS.accepted as readonly string[]);

/**
 * Build argv using ONLY flags verified to parse.
 *
 * `zcode --help` advertises `--settings`, `--max-turns`, `--allowed-tools` and `--permission-mode`,
 * and the parser REJECTS all four (`util.parseArgs` runs with `strict: true`). Emitting one turns a
 * working call into a usage error, so an unverified request is reported as skipped instead.
 */
export function buildHeadlessArgs(args: Record<string, unknown>): { argv: string[]; skipped: string[] } {
  const argv: string[] = [];
  const skipped: string[] = [];
  const add = (flag: string, value: string) => {
    if (!ACCEPTED.has(flag)) {
      skipped.push(flag);
      return;
    }
    argv.push(flag, value);
  };

  argv.push('--prompt', String(args.text));
  argv.push('--json');
  if (typeof args.output === 'string' && args.output !== 'json') {
    add('--output-format', args.output);
  } else {
    add('--output-format', 'json');
  }
  if (typeof args.workspace === 'string') argv.push('--cwd', args.workspace);
  if (typeof args.mode === 'string') add('--mode', args.mode);
  if (typeof args.resume === 'string') add('--resume', args.resume);
  if (args.continue === true) argv.push('--continue');
  if (typeof args.target === 'string') add('--target', args.target);

  // Requested but never emitted: these are the advertised-but-rejected flags.
  for (const f of VERIFIED_CLI_FLAGS.rejected) {
    if (f in args) skipped.push(f);
  }
  return { argv, skipped };
}

export async function headlessDispatch(ctx: ServerContext, args: Record<string, unknown>): Promise<Envelope> {
  const action = String(args.action);
  const runId = AuditDb.newRunId('zcode_headless', action);

  if (action !== 'prompt') {
    return localEnvelope({ tool: 'zcode_headless', action }, null, { ok: false, errors: [`unknown action: ${action}`] });
  }

  const discovery = discoverRuntime();
  const o = new Outcome({ tool: 'zcode_headless', action, mode: 'headless', payloadSource: 'stdout' });
  if (!discovery.cli) {
    o.fail(discoveryFailure(discovery));
    return finish(ctx, o, runId);
  }

  const { argv, skipped } = buildHeadlessArgs(args);
  const node = resolveNode();
  const bin = discovery.cli;
  o.setRun({ wire: null, settings: null, command: `${node} ${bin} ${argv.join(' ')}` });
  for (const f of skipped) {
    o.warn(
      'flag_unverified',
      `${f} appears in \`zcode --help\` but the option parser rejects it, so it was NOT emitted. ` +
        'Emitting it would turn this call into a usage error.',
      'degraded',
    );
  }

  // A headless CLI is a SEPARATE process and does not inherit ZCODE_MCP_* — it needs the provider
  // under the names the CLI reads (ZCODE_MODEL / ZCODE_BASE_URL / ZCODE_API_KEY). Without this it
  // fails with "Model config is missing" even though this server is fully configured, which is
  // exactly what the first matrix run did.
  const workspaceForEnv = typeof args.workspace === 'string' ? args.workspace : (ctx.env.ZCODE_MCP_WORKSPACE ?? process.cwd());
  const target = targetFromEnv();
  const boot = bootstrapProvider({ workspace: workspaceForEnv, ...(target ? { target } : {}) });
  for (const w of boot.warnings) {
    if (w.code !== 'zc_base_url_dual_purpose') o.warn(w.code, w.detail, w.impact);
  }

  const timeout = typeof args.timeout_ms === 'number' ? args.timeout_ms : 600_000;
  const started = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(node, [bin, ...argv], {
      timeout,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      // The bootstrapped environment, which is already de-credentialed except for the one key.
      env: boot.childEnv,
    });
    o.setTimedOut(false);
    // stdout_raw is always returned: a caller must not be blocked by our parser being wrong about a
    // format we have not fully characterised.
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(stdout.trim());
    } catch {
      o.warn('stdout_not_json', 'stdout did not parse as JSON; returning it verbatim', 'degraded');
    }
    o.result({ stdout_raw: stdout, parsed, stderr_tail: stderr.slice(-2000), duration_ms: Date.now() - started });
    o.readBack(parsed !== null || stdout.trim().length > 0, 'the CLI produced output');
  } catch (err) {
    const e = err as { killed?: boolean; stdout?: string; stderr?: string; code?: number };
    o.setTimedOut(Boolean(e.killed)).setExitCode(typeof e.code === 'number' ? e.code : null);
    if (e.stdout) o.result({ stdout_raw: e.stdout, stderr_tail: (e.stderr ?? '').slice(-2000) });
    if (/Model config is missing/i.test(e.stderr ?? '')) {
      o.warn(
        'provider_not_configured',
        'the CLI has no model provider configured; set ZCODE_MCP_MODEL / ZCODE_MCP_BASE_URL and a key',
        'unreliable',
      );
    }
    if (/(--)?(settings|max-turns|allowed-tools|permission-mode)/.test(e.stderr ?? '')) {
      o.warn(
        'flag_unverified',
        'the CLI rejected a flag: this build advertises flags its parser does not accept. ' +
          'zcode_headless only emits verified ones, so this should not happen — please report the command line.',
        'unreliable',
      );
    }
    o.fail(describe(err));
  }
  return finish(ctx, o, runId);
}
