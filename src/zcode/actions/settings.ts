/**
 * `zcode_settings` — read and change configuration.
 *
 * Two backends, and the envelope always says which one answered, because they differ in when a
 * change takes effect:
 *
 *   protocol    takes effect immediately; verified by a read-back
 *   filesystem  read by ZCode at STARTUP, so the result carries `restart_required: advisory`
 *
 * Secrets: `get` redacts. Not cosmetically — `~/.zcode/v2/config.json` stores provider API keys in
 * plaintext (CONFIRMED during the audit), so an unredacted read would put live credentials into a
 * model's context. That is not something a caller can opt out of; `ZCODE_MCP_REDACT` relaxes wire
 * logging, never this.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ServerContext } from '../../context.js';
import type { Envelope } from '../../envelope.js';
import { takeBackup } from '../backup.js';
import { isSensitiveKey, REDACTED } from '../redact.js';
import { acquireOrFail, describe, finish, newRunId, outcome, read, refOf, resolveWorkspace, workspaceRequired, write } from './_shared.js';

export async function settingsDispatch(ctx: ServerContext, args: Record<string, unknown>): Promise<Envelope> {
  const action = String(args.action);
  const runId = newRunId('zcode_settings', action);
  const writesZcode = action !== 'read_state' && action !== 'get';
  const o = outcome('zcode_settings', action, writesZcode);

  // ── file-backed actions need no runtime ───────────────────────────────────
  if (action === 'get') {
    return settingsGet(ctx, o, String(args.file), runId);
  }
  if (action === 'set_desktop') {
    return settingsSetDesktop(ctx, o, args.patch as Record<string, unknown>, runId);
  }

  const workspace = resolveWorkspace(ctx, args);
  if (!workspace) return workspaceRequired('zcode_settings', action);
  const acq = await acquireOrFail(ctx, o, workspace, runId);
  if (!acq) return finish(ctx, o, runId);
  const ref = refOf(acq.runtime);

  try {
    switch (action) {
      case 'read_state': {
        o.result(await read(o, acq.runtime, 'workspace/readState', { workspace: ref }));
        o.readOnly();
        break;
      }

      case 'set_default_model':
      case 'set_default_mode':
      case 'set_default_thought_level': {
        const method = {
          set_default_model: 'workspace/setDefaultModel',
          set_default_mode: 'workspace/setDefaultMode',
          set_default_thought_level: 'workspace/setDefaultThoughtLevel',
        }[action]!;
        const field =
          action === 'set_default_model' ? 'model' : action === 'set_default_mode' ? 'mode' : 'thoughtLevel';
        const want = String(args[action === 'set_default_model' ? 'model' : action === 'set_default_mode' ? 'mode' : 'thought_level']);

        await write(o, acq.runtime, method, { workspace: ref, [field]: want });
        const after = await read<{ settings?: Record<string, { current?: unknown }> }>(
          o,
          acq.runtime,
          'workspace/readState',
          { workspace: ref },
        );
        const observed = after?.settings?.[field === 'thoughtLevel' ? 'thoughtLevel' : field]?.current;
        const agrees = JSON.stringify(observed ?? null).includes(want);
        o.readBack(agrees, agrees ? undefined : `requested ${field}=${want}, workspace reports ${JSON.stringify(observed)}`);
        o.result({ [field]: observed ?? null, requested: want });
        break;
      }

      case 'update_interaction_prefs': {
        await write(o, acq.runtime, 'workspace/updateInteractionPreferences', {
          workspace: ref,
          preferences: { askUserQuestionAutoResolutionEnabled: Boolean(args.ask_user_question_auto_resolution) },
        });
        o.result({ ask_user_question_auto_resolution: Boolean(args.ask_user_question_auto_resolution) });
        o.readBackUnavailable('the runtime acknowledges the preference without echoing it; re-read to confirm');
        break;
      }

      case 'update_model_io_prefs': {
        await write(o, acq.runtime, 'workspace/updateModelIoPreferences', {
          workspace: ref,
          preferences: { fullRetentionEnabled: Boolean(args.full_retention) },
        });
        o.result({ full_retention: Boolean(args.full_retention) });
        o.readBackUnavailable('the runtime acknowledges the preference without echoing it; re-read to confirm');
        break;
      }

      case 'upsert_provider':
      case 'remove_provider':
      case 'update_provider_registry': {
        // The highest-blast-radius operation in the server: a bad registry silently breaks model
        // access for the user's desktop, not just for us.
        if ((process.env.ZCODE_MCP_ALLOW_PROVIDER_EDIT ?? '').trim() !== '1') {
          o.fail(
            `${action} is gated: it changes which models ZCode can reach, including for the desktop. ` +
              'Set ZCODE_MCP_ALLOW_PROVIDER_EDIT=1 to permit it. reasonCode: mcp.provider_edit.disabled',
          );
          break;
        }
        const provider = args.provider as Record<string, unknown> | undefined;
        if (action === 'upsert_provider' && provider && 'apiKey' in provider) {
          o.fail(
            'refusing to accept an apiKey here: pass the credential through the process environment ' +
              '(ZCODE_API_KEY / <PROVIDER>_API_KEY) so it is never written to a file',
          );
          break;
        }
        if (action === 'update_provider_registry') {
          const applied = await write(o, acq.runtime, 'workspace/updateProviderRegistry', {
            workspace: ref,
            registry: args.registry,
            includeWorkspaceState: true,
          });
          const a = applied as { appliedProviderRevision?: unknown; providerCount?: unknown } | undefined;
          // The runtime reports what it applied; that echo IS the read-back.
          o.readBack(
            a?.appliedProviderRevision !== undefined,
            a?.appliedProviderRevision === undefined ? `no appliedProviderRevision in ${JSON.stringify(applied).slice(0, 200)}` : undefined,
          );
          o.result(applied);
          break;
        }
        const method = action === 'upsert_provider' ? 'workspace/upsertModelProvider' : 'workspace/removeModelProvider';
        const params: Record<string, unknown> = { workspace: ref };
        if (action === 'upsert_provider') params.provider = provider;
        else params.providerId = String(args.provider_id);
        await write(o, acq.runtime, method, params);
        const after = await read<{ modelCatalog?: { providers?: unknown[]; revision?: number } }>(
          o,
          acq.runtime,
          'workspace/readState',
          { workspace: ref },
        );
        o.result({ provider_count: after?.modelCatalog?.providers?.length ?? null, revision: after?.modelCatalog?.revision ?? null });
        o.readBackUnavailable('the provider catalogue is pushed by the host, so it may not change here; a restart may be required');
        break;
      }

      case 'hook_trust_grant': {
        const res = await write(o, acq.runtime, 'workspace/hooks/trustGrant', { workspace: ref });
        const accepted = Boolean((res as { accepted?: unknown } | undefined)?.accepted);
        o.result(res);
        o.readBack(accepted, accepted ? undefined : 'the runtime did not accept the trust grant');
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

// ── file-backed ──────────────────────────────────────────────────────────────

function configPathFor(file: string): string | null {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? homedir();
  switch (file) {
    case 'agent_config':
      return join(home, '.zcode', 'cli', 'config.json');
    case 'desktop_settings':
      return join(home, '.zcode', 'v2', 'setting.json');
    case 'provider_registry':
      return join(home, '.zcode', 'v2', 'config.json');
    default:
      return null;
  }
}

function settingsGet(ctx: ServerContext, o: ReturnType<typeof outcome>, file: string, runId: string): Envelope {
  const p = configPathFor(file);
  if (!p) {
    o.fail(`unknown file: ${file}. One of: agent_config, desktop_settings, provider_registry`);
    return finish(ctx, o, runId);
  }
  if (!existsSync(p)) {
    o.warn('file_absent', `no file at ${p}`, 'advisory');
    o.result({ file, path: p, exists: false, value: null });
    return finish(ctx, o, runId);
  }
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as unknown;
    o.setPayloadSource('filesystem');
    o.result({ file, path: p, exists: true, value: redactDeep(parsed) });
    o.readOnly();
  } catch (err) {
    o.fail(`could not parse ${p}: ${describe(err)}`);
  }
  return finish(ctx, o, runId);
}

/** Redact by key name at any depth. Never returns a live credential. */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 12) return value;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSensitiveKey(k) ? REDACTED : redactDeep(v, depth + 1);
  }
  return out;
}

function settingsSetDesktop(
  ctx: ServerContext,
  o: ReturnType<typeof outcome>,
  patch: Record<string, unknown>,
  runId: string,
): Envelope {
  const p = configPathFor('desktop_settings');
  if (!p || !patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).length === 0) {
    o.fail('set_desktop needs a non-empty patch object');
    return finish(ctx, o, runId);
  }
  try {
    // Additive, never a wholesale replace: ZCode maintains `*MigrationInitialized` flags and
    // forward-migrates this file, so dropping keys we do not recognise would corrupt its state.
    const current = existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>) : {};
    const merged = { ...current, ...patch };
    // A backup proven restorable, or no write at all. The stamp here used to be
    // `iso.replace(/[-:T]/g,'').slice(0,15)`, which ends in the millisecond dot — a name Windows
    // creates but cannot open. See src/zcode/backup.ts.
    const taken = takeBackup(p, 'mcp');
    if (!taken.ok) {
      o.fail(`${taken.reason}; refusing to modify ${p}`);
      return finish(ctx, o, runId);
    }
    const backup = taken.path;
    writeFileSync(p, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');

    const verify = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
    const applied = Object.keys(patch).filter((k) => JSON.stringify(verify[k]) === JSON.stringify(patch[k]));
    o.readBack(applied.length === Object.keys(patch).length, `applied ${applied.length}/${Object.keys(patch).length} keys on re-read`);
    o.setPayloadSource('filesystem');
    o.result({ path: p, backup, applied_keys: applied });
    o.warn(
      'restart_required',
      'ZCode reads desktop settings at startup, so this change is not live until it restarts. ' +
        'The file write is verified; the effect is not.',
      'advisory',
    );
  } catch (err) {
    o.fail(`could not write ${p}: ${describe(err)}`);
  }
  return finish(ctx, o, runId);
}
