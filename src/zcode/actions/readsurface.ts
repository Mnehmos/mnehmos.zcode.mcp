/**
 * `zcode_usage`, `zcode_automation`, `zcode_plugins`, `zcode_mcp` — the read-only surface.
 *
 * Grouped in one file because they share a shape: acquire a runtime, make one or two protocol
 * calls, report what came back. Splitting them across four near-identical files would be ceremony.
 *
 * The rule these four share: a read never pretends. If the runtime does not implement a method, the
 * envelope says `method_not_supported` with `impact: unreliable` rather than reporting an empty
 * result, because "nothing there" and "we could not ask" mean different things to a caller.
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ServerContext } from '../../context.js';
import type { Envelope } from '../../envelope.js';
import { isMethodNotFound } from '../protocol.js';
import { redact, isSensitiveKey, REDACTED } from '../redact.js';
import { acquireOrFail, describe, finish, newRunId, outcome, read, refOf, resolveWorkspace, workspaceRequired, write } from './_shared.js';

// ── zcode_usage ──────────────────────────────────────────────────────────────

export async function usageDispatch(ctx: ServerContext, args: Record<string, unknown>): Promise<Envelope> {
  const action = String(args.action);
  const runId = newRunId('zcode_usage', action);
  const o = outcome('zcode_usage', action);
  const workspace = resolveWorkspace(ctx, args);
  if (!workspace) return workspaceRequired('zcode_usage', action);

  const acq = await acquireOrFail(ctx, o, workspace, runId);
  if (!acq) return finish(ctx, o, runId);

  try {
    // `range` is mandatory: omitting it is -32602, confirmed by probe.
    const stats = await read(o, acq.runtime, 'usage/stats', { range: String(args.range) });
    o.result(stats);
  } catch (err) {
    o.fail(describe(err));
  }
  o.readOnly();
  return finish(ctx, o, runId);
}

// ── zcode_automation ─────────────────────────────────────────────────────────

export async function automationDispatch(ctx: ServerContext, args: Record<string, unknown>): Promise<Envelope> {
  const action = String(args.action);
  const runId = newRunId('zcode_automation', action);
  const o = outcome('zcode_automation', action, action !== 'list' && action !== 'check_binding');
  const workspace = resolveWorkspace(ctx, args);
  if (!workspace) return workspaceRequired('zcode_automation', action);

  const acq = await acquireOrFail(ctx, o, workspace, runId);
  if (!acq) return finish(ctx, o, runId);

  try {
    switch (action) {
      case 'list': {
        const res = await read<{ automations?: unknown[] }>(o, acq.runtime, 'automation/list', {});
        const list = res?.automations ?? [];
        o.result({ automations: list, count: list.length, capacity: 20 });
        // The 20 limit is the runtime's, and it is worth stating before a create fails on it.
        if (list.length >= 18) {
          o.warn(
            'automation_capacity',
            `${list.length} of 20 automations retained; a create beyond 20 fails with the runtime's own ` +
              'AutomationCreateLimitError',
            'advisory',
          );
        }
        o.readOnly();
        break;
      }
      case 'check_binding': {
        const res = await read<{ bound?: boolean }>(o, acq.runtime, 'automation/checkTaskBinding', {
          targetTaskId: String(args.target_task_id),
        });
        o.result(res);
        o.readOnly();
        break;
      }
      case 'create': {
        const payload: Record<string, unknown> = { prompt: String(args.prompt) };
        for (const k of ['title', 'cronExpr', 'relativeDelayMinutes', 'intervalUnit', 'interval', 'model', 'provider', 'mode', 'thoughtLevel', 'targetTaskId', 'recurring', 'maxRuns'] as const) {
          const snake = k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
          if (args[snake] !== undefined) payload[k] = args[snake];
        }
        // Exactly one scheduling form, or none for a plain delayed run. The runtime validates too,
        // but refusing here costs no process and names the problem earlier.
        const forms = [payload.cronExpr, payload.relativeDelayMinutes, payload.interval].filter((v) => v !== undefined).length;
        if (forms > 1) {
          o.fail('give at most one of cron_expr, relative_delay_minutes, interval(+interval_unit)');
          break;
        }
        const res = await write(o, acq.runtime, 'automation/create', payload);
        // Read back from the list rather than trusting the create response.
        const after = await read<{ automations?: Array<Record<string, unknown>> }>(o, acq.runtime, 'automation/list', {});
        const created = (res as { automation?: { automationId?: string } })?.automation?.automationId;
        const found = (after?.automations ?? []).some((a) => a.automationId === created);
        o.readBack(found, found ? undefined : `created ${created ?? '(unknown id)'} but it is not in automation/list`);
        o.result({ automation: (res as { automation?: unknown })?.automation ?? res, retained: (after?.automations ?? []).length });
        o.warn(
          'standing_authority',
          `this automation will run unattended at mode "${String(args.mode ?? 'the runtime default')}". ` +
            'Creation captures the mode; a later change to the workspace default does not affect it.',
          'advisory',
        );
        break;
      }
      case 'update':
      case 'delete': {
        const id = String(args.automation_id);
        const payload: Record<string, unknown> = { automationId: id };
        for (const k of ['title', 'cronExpr', 'prompt', 'recurring', 'maxRuns', 'intervalUnit', 'interval'] as const) {
          const snake = k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
          if (args[snake] !== undefined) payload[k] = args[snake];
        }
        const res = await write(o, acq.runtime, action === 'update' ? 'automation/update' : 'automation/delete', payload);
        const after = await read<{ automations?: Array<{ automationId?: string }> }>(o, acq.runtime, 'automation/list', {});
        const present = (after?.automations ?? []).some((a) => a.automationId === id);
        const expected = action === 'update';
        o.readBack(present === expected, `after ${action}, present=${present} (expected ${expected})`);
        o.result(res);
        break;
      }
      default:
        o.fail(`unknown action: ${action}`);
    }
  } catch (err) {
    if (isMethodNotFound(err)) {
      // CONFIRMED by probe: this build answers -32601 for automation/list. The methods exist in a
      // dispatch table inside the bundle, but not on the bare `app-server` we spawn — automation
      // appears to be a HOST-side capability. Reported as a capability gap rather than a failure,
      // because nothing is wrong with the call.
      o.warn(
        'method_not_supported',
        'automation/* is not implemented on a bare app-server (this build answers -32601). ' +
          'Scheduling appears to be a host-side capability, so this tool cannot work in the ' +
          'owned-runtime configuration. See .re/findings_ADDENDUM.md A22.',
        'unreliable',
      );
    }
    o.fail(describe(err));
  }
  return finish(ctx, o, runId);
}

// ── zcode_plugins ────────────────────────────────────────────────────────────

const PLUGIN_MUTATING = new Set(['set_enabled', 'configure', 'reset_config', 'install', 'update', 'uninstall', 'marketplace']);

export async function pluginsDispatch(ctx: ServerContext, args: Record<string, unknown>): Promise<Envelope> {
  const action = String(args.action);
  const runId = newRunId('zcode_plugins', action);
  const o = outcome('zcode_plugins', action, PLUGIN_MUTATING.has(action));
  const workspace = resolveWorkspace(ctx, args);
  if (!workspace) return workspaceRequired('zcode_plugins', action);

  const acq = await acquireOrFail(ctx, o, workspace, runId);
  if (!acq) return finish(ctx, o, runId);
  const ref = refOf(acq.runtime);

  try {
    switch (action) {
      case 'list': {
        const res = await read<{ plugins?: Array<Record<string, unknown>> }>(o, acq.runtime, 'plugins/list', { workspace: ref });
        const plugins = res?.plugins ?? [];
        o.result({ plugins, count: plugins.length });
        budgetWarning(o, plugins);
        o.readOnly();
        break;
      }
      case 'overview': {
        o.result(await read(o, acq.runtime, 'plugins/overview', { workspace: ref }));
        o.readOnly();
        break;
      }
      case 'describe': {
        o.result(await read(o, acq.runtime, 'plugins/describe', { workspace: ref, pluginId: String(args.plugin_id) }));
        o.readOnly();
        break;
      }
      case 'validate': {
        const params: Record<string, unknown> = { workspace: ref };
        if (args.plugin_id !== undefined) params.pluginId = args.plugin_id;
        o.result(await read(o, acq.runtime, 'plugins/validate', params));
        o.readOnly();
        break;
      }
      case 'set_enabled':
      case 'configure':
      case 'reset_config':
      case 'install':
      case 'update':
      case 'uninstall': {
        if (!requireGuard(o, action)) break;
        const method = {
          set_enabled: 'plugins/setEnabled',
          configure: 'plugins/configure',
          reset_config: 'plugins/resetConfig',
          install: 'plugins/install',
          update: 'plugins/update',
          uninstall: 'plugins/uninstall',
        }[action]!;
        const params: Record<string, unknown> = { workspace: ref, pluginId: String(args.plugin_id) };
        if (action === 'set_enabled') params.enabled = Boolean(args.enabled);
        if (action === 'configure') params.config = args.config ?? {};

        const before = (await read<{ plugins?: Array<Record<string, unknown>> }>(o, acq.runtime, 'plugins/list', { workspace: ref }))?.plugins ?? [];
        await write(o, acq.runtime, method, params);
        const after = (await read<{ plugins?: Array<Record<string, unknown>> }>(o, acq.runtime, 'plugins/list', { workspace: ref }))?.plugins ?? [];
        const find = (list: Array<Record<string, unknown>>) => list.find((p) => String(p.id) === String(args.plugin_id));
        const b = find(before);
        const a = find(after);
        if (action === 'set_enabled') {
          const want = Boolean(args.enabled);
          o.readBack(a?.enabled === want, `requested enabled=${want}, observed ${String(a?.enabled)}`);
        } else {
          o.readBack(Boolean(a), `plugin ${String(args.plugin_id)} present after ${action}: ${Boolean(a)}`);
        }
        o.result({ plugin: a ?? null, before: b ? { enabled: b.enabled, version: b.version } : null });
        budgetWarning(o, after);
        break;
      }
      case 'cancel_operation': {
        o.result(await write(o, acq.runtime, 'plugins/cancelOperation', { operationId: String(args.operation_id) }));
        o.readBackUnavailable('the runtime acknowledges the cancellation without echoing operation state');
        break;
      }
      case 'marketplace': {
        if (!requireGuard(o, action)) break;
        const method = {
          add: 'plugins/marketplace/add',
          remove: 'plugins/marketplace/remove',
          update: 'plugins/marketplace/update',
        }[String(args.marketplace_action)] ?? null;
        if (!method) {
          o.fail(`unknown marketplace_action: ${String(args.marketplace_action)}`);
          break;
        }
        await write(o, acq.runtime, method, { workspace: ref, target: String(args.target) });
        const after = (await read<{ plugins?: unknown[] }>(o, acq.runtime, 'plugins/list', { workspace: ref }))?.plugins ?? [];
        o.readBack(true, 'marketplace operation accepted');
        o.result({ target: String(args.target), plugin_count: after.length });
        break;
      }
      default:
        o.fail(`unknown action: ${action}`);
    }
  } catch (err) {
    o.fail(describe(err));
  }
  return finish(ctx, o, runId);
}

/** Install/update/uninstall execute third-party code, so they need the opt-in flag. */
function requireGuard(o: ReturnType<typeof outcome>, action: string): boolean {
  const guarded = new Set(['install', 'update', 'uninstall', 'marketplace']);
  if (!guarded.has(action)) return true;
  if ((process.env.ZCODE_MCP_ALLOW_PLUGIN_INSTALL ?? '').trim() === '1') return true;
  o.fail(
    `${action} is gated: it executes third-party code. Set ZCODE_MCP_ALLOW_PLUGIN_INSTALL=1 to permit it. ` +
      'reasonCode: mcp.plugin_install.disabled',
  );
  return false;
}

/**
 * Enabling plugins consumes the model's tool budget.
 *
 * CONFIRMED from the runtime's own profile tooling: the provider rejects requests above roughly
 * 89-94 registered tools with `[1210] Invalid API parameter`. Worth saying before a caller
 * discovers it as an opaque model failure.
 */
function budgetWarning(o: ReturnType<typeof outcome>, plugins: Array<Record<string, unknown>>): void {
  const budget = Number(process.env.ZCODE_MCP_TOOL_BUDGET ?? 88);
  const enabled = plugins.filter((p) => p.enabled === true);
  const counted = enabled.reduce((n, p) => {
    const components = Array.isArray(p.components) ? (p.components as Array<{ kind?: string; items?: unknown[] }>) : [];
    const mcp = components.filter((c) => c.kind === 'mcp').reduce((k, c) => k + (c.items?.length ?? 0), 0);
    return n + mcp;
  }, 0);
  if (enabled.length > 0 && counted >= budget) {
    o.warn(
      'tool_budget',
      `${enabled.length} enabled plugin(s) contribute ${counted} MCP tools toward a budget of ${budget}. ` +
        'The provider may reject requests with [1210] Invalid API parameter.',
      'degraded',
    );
  }
}

// ── zcode_mcp ────────────────────────────────────────────────────────────────

export async function zcodeMcpDispatch(ctx: ServerContext, args: Record<string, unknown>): Promise<Envelope> {
  const action = String(args.action);
  const runId = newRunId('zcode_mcp', action === 'list' || action === 'status' ? action : 'servers');
  const o = outcome('zcode_mcp', action, action === 'add_server' || action === 'remove_server');

  // `servers` reads configuration and starts nothing, so it needs no runtime.
  if (action === 'servers') {
    const cfg = readAgentConfig(o);
    if (cfg === null) return finish(ctx, o, runId);
    const servers = Object.entries(cfg.servers ?? {}).map(([name, spec]) => {
      const s = (spec ?? {}) as Record<string, unknown>;
      return {
        name,
        command: typeof s.command === 'string' ? s.command : null,
        arg_count: Array.isArray(s.args) ? s.args.length : 0,
        // Names only: an env block is where credentials live.
        env_keys: s.env && typeof s.env === 'object' ? Object.keys(s.env as object) : [],
      };
    });
    o.result({ servers, count: servers.length, config_path: cfg.path });
    o.readOnly();
    return finish(ctx, o, runId);
  }

  const workspace = resolveWorkspace(ctx, args);
  if (!workspace) return workspaceRequired('zcode_mcp', action);
  const acq = await acquireOrFail(ctx, o, workspace, runId);
  if (!acq) return finish(ctx, o, runId);

  try {
    if (action === 'list' || action === 'status') {
      const res = await read<{ statuses?: Record<string, Record<string, unknown>> }>(o, acq.runtime, 'mcp/list', { workspace: refOf(acq.runtime) });
      const statuses = res?.statuses ?? {};
      const entries = Object.entries(statuses);
      // CONFIRMED side effect: this call STARTS the configured servers.
      o.warn(
        'processes_started',
        `listing MCP servers starts them; ${entries.length} server(s) are now involved. Use action "servers" ` +
          'to read the configuration without starting anything.',
        'advisory',
      );
      if (action === 'status') {
        const one = statuses[String(args.server)];
        if (!one) {
          o.fail(`unknown MCP server: ${String(args.server)}. Known: ${entries.map(([k]) => k).join(', ') || '(none)'}`);
        } else {
          o.result({ server: String(args.server), ...one });
        }
      } else {
        const totalTools = entries.reduce((n, [, v]) => n + (typeof v.toolCount === 'number' ? v.toolCount : 0), 0);
        o.result({
          statuses,
          total_tools: totalTools,
          failed: entries.filter(([, v]) => v.status === 'failed').map(([k]) => k),
        });

        // Report failures as data, not as tool errors: a server that will not start is a fact about
        // the environment, and the caller may still want the rest of the inventory.
        const failed = entries.filter(([, v]) => v.status === 'failed');
        if (failed.length > 0 && failed.length === entries.length) {
          o.warn('all_servers_failed', 'every configured MCP server failed to start', 'degraded');
        } else if (failed.length > 0) {
          o.warn(
            'some_servers_failed',
            `${failed.length} of ${entries.length} server(s) failed: ` +
              failed.map(([k, v]) => `${k} (${String(v.failureKind ?? v.error ?? 'unknown')})`).join(', '),
            'advisory',
          );
        }

        // The provider rejects requests above roughly 89-94 registered tools with
        // `[1210] Invalid API parameter`, so the count is a real budget and not trivia.
        const budget = Number(process.env.ZCODE_MCP_TOOL_BUDGET ?? 88);
        if (totalTools >= budget) {
          o.warn(
            'tool_budget',
            `${totalTools} MCP tools are registered against a budget of ${budget}; these count toward ` +
              'the model request, and the provider may reject it with [1210] Invalid API parameter. ' +
              'Use the mcp-profile tooling to trim.',
            'degraded',
          );
        }
      }
      o.readOnly();
      return finish(ctx, o, runId);
    }

    if (action === 'add_server' || action === 'remove_server') {
      if ((process.env.ZCODE_MCP_ALLOW_MCP_CONFIG_EDIT ?? '').trim() !== '1') {
        o.fail(
          `${action} is gated: it makes ZCode execute an arbitrary command. ` +
            'Set ZCODE_MCP_ALLOW_MCP_CONFIG_EDIT=1 to permit it. reasonCode: mcp.mcp_config_edit.disabled',
        );
        return finish(ctx, o, runId);
      }
      const edited = editAgentConfig(o, action, args);
      if (!edited) return finish(ctx, o, runId);
      o.result(edited);
      o.warn(
        'restart_required',
        'the agent reads MCP configuration at startup; the change takes effect for new sessions after a restart',
        'advisory',
      );
      return finish(ctx, o, runId);
    }

    o.fail(`unknown action: ${action}`);
  } catch (err) {
    o.fail(describe(err));
  }
  return finish(ctx, o, runId);
}

function agentConfigPath(): string {
  return process.env.USERPROFILE || process.env.HOME
    ? join(process.env.USERPROFILE ?? process.env.HOME ?? homedir(), '.zcode', 'cli', 'config.json')
    : join(homedir(), '.zcode', 'cli', 'config.json');
}

/** Read the agent config, reporting a missing or unparseable file rather than an empty result. */
function readAgentConfig(o: ReturnType<typeof outcome>): { path: string; servers?: Record<string, unknown> } | null {
  const p = agentConfigPath();
  if (!existsSync(p)) {
    o.warn('file_absent', `no agent config at ${p}`, 'advisory');
    o.result({ servers: [], count: 0, config_path: p });
    return { path: p, servers: {} };
  }
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
    const mcp = (raw.mcp ?? {}) as { servers?: Record<string, unknown> };
    return { path: p, servers: mcp.servers ?? {} };
  } catch (err) {
    o.fail(`could not parse ${p}: ${describe(err)}`);
    return null;
  }
}

/**
 * Add or remove one server, additively.
 *
 * ZCode maintains its own backups as `config.json.bak-<ts>`, and so do we: a wholesale replace
 * would drop `plugins` and every key we do not know about.
 */
function editAgentConfig(
  o: ReturnType<typeof outcome>,
  action: 'add_server' | 'remove_server',
  args: Record<string, unknown>,
): Record<string, unknown> | null {
  const p = agentConfigPath();
  let raw: Record<string, unknown>;
  try {
    raw = existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>) : {};
  } catch (err) {
    o.fail(`could not parse ${p}: ${describe(err)}`);
    return null;
  }

  const mcp = { ...((raw.mcp ?? {}) as Record<string, unknown>) };
  const servers = { ...((mcp.servers ?? {}) as Record<string, unknown>) };
  const name = String(args.name);

  if (action === 'add_server') {
    const spec = args.spec as { command?: string; args?: string[]; env?: Record<string, string> } | undefined;
    if (!spec?.command) {
      o.fail('spec.command is required');
      return null;
    }
    servers[name] = {
      command: spec.command,
      ...(spec.args ? { args: spec.args } : {}),
      ...(spec.env ? { env: spec.env } : {}),
    };
  } else {
    if (!(name in servers)) {
      o.fail(`no MCP server named ${name} in ${p}`);
      return null;
    }
    delete servers[name];
  }

  mcp.servers = servers;
  raw.mcp = mcp;

  try {
    const backup = `${p}.bak-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)}`;
    if (existsSync(p)) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('node:fs').copyFileSync(p, backup);
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('node:fs').writeFileSync(p, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    const verify = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
    const nowServers = ((verify.mcp as { servers?: Record<string, unknown> })?.servers ?? {}) as Record<string, unknown>;
    const present = name in nowServers;
    o.readBack(present === (action === 'add_server'), `${action} ${name}: present=${present}`);
    return { config_path: p, backup, server_count: Object.keys(nowServers).length, servers: Object.keys(nowServers) };
  } catch (err) {
    o.fail(`could not write ${p}: ${describe(err)}`);
    return null;
  }
}

export { isMethodNotFound, redact, isSensitiveKey, REDACTED };
