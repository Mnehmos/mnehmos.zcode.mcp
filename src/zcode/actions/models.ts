/**
 * `zcode_models` — model and provider discovery, and selection.
 *
 * Deliberately factual rather than opinionated. This tool does not rank, score or "recommend"; it
 * answers what exists, what is reachable with the credentials this server holds, and what is
 * currently selected — and then applies a choice the caller made. Picking a model from the facts is
 * the calling model's job, and baking a heuristic in here would replace its judgement with mine.
 *
 * Three sources, kept distinct because they answer different questions:
 *
 *   catalog    what ZCode knows how to talk to          (a resource file)
 *   available  what THIS runtime has wired up right now (the live protocol)
 *   current    what a session or workspace is using     (the live protocol)
 */
import { join } from 'node:path';

import type { ServerContext } from '../../context.js';
import { Outcome, localEnvelope, type Envelope } from '../../envelope.js';
import { AuditDb } from '../../storage/db.js';
import {
  anthropicBaseURL,
  filterModels,
  findModels,
  findProvider,
  loadModelCatalog,
  normalizeModelRef,
  type CatalogModel,
  type CatalogProvider,
} from '../model-catalog.js';
import { apiKeyEnvCandidates, resolveApiKey } from '../settings.js';
import { describe, resolveWorkspace, workspaceRequired } from './status.js';

interface ModelRef {
  providerId?: string;
  modelId?: string;
  variant?: string;
}

export async function modelsDispatch(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Envelope> {
  const action = String(args.action);

  // ── discovery actions answer from a file or from configuration: no runtime needed ──
  if (action === 'catalog') return catalog(ctx, args);

  const workspace = resolveWorkspace(ctx, args);
  if (!workspace) return workspaceRequired('zcode_models', action);

  const runId = AuditDb.newRunId('zcode_models', action);
  const o = new Outcome({
    tool: 'zcode_models',
    action,
    mode: 'child',
    payloadSource: 'protocol',
    mutates: action === 'select',
  });

  const t0 = Date.now();
  let acquired;
  try {
    acquired = await ctx.acquire({ workspacePath: workspace });
    o.method('runtime/acquire', true, Date.now() - t0);
  } catch (err) {
    o.method('runtime/acquire', false, Date.now() - t0, describe(err));
    o.fail(err instanceof Error ? err.message : String(err));
    return finish(ctx, o, runId);
  }
  const { runtime } = acquired;
  o.setRuntime(ctx.runtimeIdentity(runtime));
  o.setRun({ wire: join(ctx.dirs.wire, '*.ndjson'), settings: runtime.settings.configPath, command: runtime.commandLine });

  try {
    if (action === 'available') return await available(ctx, o, runtime, args, runId);
    if (action === 'current') return await current(ctx, o, runtime, args, runId);
    if (action === 'select') return await select(ctx, o, runtime, workspace, args, runId);
    o.fail(`unknown action: ${action}`);
    return finish(ctx, o, runId);
  } catch (err) {
    o.fail(describe(err));
    o.setStderrTail(runtime.transport.stderrLines);
    return finish(ctx, o, runId);
  }
}

/** Which providers this server can actually reach, given its own environment. */
function credentialStatus(ctx: ServerContext, providers: CatalogProvider[]): Array<{
  provider: string;
  has_credential: boolean;
  credential_var: string | null;
  how_to_set: string[];
}> {
  const env = process.env;
  return providers.map((p) => {
    const key = resolveApiKey(p.id, env);
    return {
      provider: p.id,
      has_credential: key !== null,
      credential_var: key?.name ?? null,
      how_to_set: apiKeyEnvCandidates(p.id),
    };
  });
}

function defaultSelection(ctx: ServerContext): { model: string | null; base_url: string | null; source: string } {
  const model = ctx.activeTarget()?.model ?? null;
  return { model, base_url: ctx.activeTarget()?.baseURL ?? null, source: model ? 'ZCODE_MCP_MODEL' : 'unset' };
}

async function catalog(ctx: ServerContext, args: Record<string, unknown>): Promise<Envelope> {
  const cat = loadModelCatalog();
  if (!cat) {
    return localEnvelope({ tool: 'zcode_models', action: 'catalog' }, null, {
      ok: false,
      errors: [
        'no model catalogue available: neither the installed ZCode resource nor the vendored copy ' +
          'at data/model_catalog.json could be read',
      ],
    });
  }

  const filtered = filterModels(cat, {
    ...(typeof args.provider === 'string' ? { provider: args.provider } : {}),
    ...(typeof args.min_context === 'number' ? { minContext: args.min_context } : {}),
    ...(typeof args.input_modality === 'string' ? { inputModality: args.input_modality } : {}),
    ...(typeof args.reasoning_level === 'string' ? { reasoningLevel: args.reasoning_level } : {}),
    ...(typeof args.kind === 'string' ? { kind: args.kind } : {}),
  });

  const statuses = credentialStatus(ctx, cat.providers);
  const byProvider = new Map(statuses.map((s) => [s.provider, s]));

  // Group back by provider so the shape stays decision-ready rather than a flat 130-row list.
  const grouped = new Map<string, { provider: CatalogProvider; reachable: boolean; models: CatalogModel[] }>();
  for (const { provider, model } of filtered) {
    if (!grouped.has(provider.id)) {
      grouped.set(provider.id, {
        provider,
        reachable: byProvider.get(provider.id)?.has_credential ?? false,
        models: [],
      });
    }
    grouped.get(provider.id)!.models.push(model);
  }

  const providers = [...grouped.values()].map((g) => ({
    id: g.provider.id,
    name: g.provider.name,
    reachable: g.reachable,
    anthropic_base_url: anthropicBaseURL(g.provider),
    default_kind: g.provider.defaultKind,
    model_count: g.models.length,
    models: g.models.map((m) => ({
      id: m.id,
      kinds: m.kinds,
      context_window: m.contextWindow,
      max_output_tokens: m.maxOutputTokens,
      input_modalities: m.modalities?.input ?? ['text'],
      reasoning_levels: m.reasoningLevels ?? [],
    })),
  }));

  return localEnvelope({ tool: 'zcode_models', action: 'catalog' }, {
    catalogue: { schema_version: cat.schemaVersion, source: cat.source, path: cat.sourcePath },
    server_default: defaultSelection(ctx),
    // Stated so a caller does not have to infer it from an absence.
    unattached_credentials: statuses.filter((s) => !s.has_credential).map((s) => ({ provider: s.provider, how_to_set: s.how_to_set })),
    providers,
    total_models: providers.reduce((n, p) => n + p.model_count, 0),
  }, {
    extra: {
      note:
        'This lists what ZCode can talk to. Whether a given model is wired up for a running session ' +
        'is a different question: use action "available".',
    },
  });
}

async function available(
  ctx: ServerContext,
  o: Outcome,
  runtime: Awaited<ReturnType<ServerContext['acquire']>>['runtime'],
  args: Record<string, unknown>,
  runId: string,
): Promise<Envelope> {
  const t = Date.now();
  const state = await runtime.client.request<{
    modelCatalog?: { providers?: unknown[]; available?: unknown[]; revision?: number };
    settings?: { model?: { current?: ModelRef; available?: unknown[]; lastUsed?: ModelRef } };
  }>('workspace/readState', {
    workspace: { workspacePath: runtime.workspacePath, workspaceKey: runtime.workspaceKey },
  });
  o.method('workspace/readState', true, Date.now() - t);

  // Read back from the session too when a session was named: workspace state and session state can
  // legitimately differ, and reporting only one of them would be misleading.
  let sessionModel: ModelRef | null = null;
  if (typeof args.session_id === 'string') {
    try {
      const t2 = Date.now();
      const read = await runtime.client.request<{ model?: ModelRef }>('session/read', { sessionId: args.session_id });
      o.method('session/read', true, Date.now() - t2);
      sessionModel = read?.model ?? null;
    } catch (err) {
      o.method('session/read', false, 0, describe(err));
      o.warn('session_read_failed', `could not read the session model: ${describe(err)}`, 'degraded');
    }
  }

  o.result({
    runtime_transport: runtime.transport.alive ? 'ready' : 'dead',
    provider_registry: {
      revision: state?.modelCatalog?.revision ?? null,
      provider_count: state?.modelCatalog?.providers?.length ?? 0,
    },
    workspace_settings: {
      current: state?.settings?.model?.current ?? null,
      last_used: state?.settings?.model?.lastUsed ?? null,
      available_count: state?.settings?.model?.available?.length ?? 0,
      available: state?.settings?.model?.available ?? [],
    },
    session_model: sessionModel,
  });
  o.readBackUnavailable('this action reports live state; it changes none');
  return finish(ctx, o, runId);
}

async function current(
  ctx: ServerContext,
  o: Outcome,
  runtime: Awaited<ReturnType<ServerContext['acquire']>>['runtime'],
  args: Record<string, unknown>,
  runId: string,
): Promise<Envelope> {
  if (typeof args.session_id === 'string') {
    const t = Date.now();
    const read = await runtime.client.request<{ model?: ModelRef; status?: string; mode?: string; thoughtLevel?: string }>(
      'session/read',
      { sessionId: args.session_id },
    );
    o.method('session/read', true, Date.now() - t);
    o.result({
      scope: 'session',
      session_id: args.session_id,
      model: read?.model ?? null,
      thought_level: read?.thoughtLevel ?? null,
      mode: read?.mode ?? null,
      status: read?.status ?? null,
    });
  } else {
    const t = Date.now();
    const state = await runtime.client.request<{ settings?: { model?: { current?: ModelRef } } }>('workspace/readState', {
      workspace: { workspacePath: runtime.workspacePath, workspaceKey: runtime.workspaceKey },
    });
    o.method('workspace/readState', true, Date.now() - t);
    o.result({ scope: 'workspace', workspace_key: runtime.workspaceKey, model: state?.settings?.model?.current ?? null });
  }
  o.readBackUnavailable('this action reports live state; it changes none');
  return finish(ctx, o, runId);
}

/**
 * Apply a model choice.
 *
 * Three scopes, and the honesty is in what each one can actually promise:
 *   session    immediate, read back from the session
 *   workspace  the workspace default, read back from workspace state
 *   server     THIS PROCESS's default for newly spawned runtimes. It does not rewrite .env and
 *              does not touch already-running runtimes, and the result says both things.
 */
async function select(
  ctx: ServerContext,
  o: Outcome,
  runtime: Awaited<ReturnType<ServerContext['acquire']>>['runtime'],
  workspace: string,
  args: Record<string, unknown>,
  runId: string,
): Promise<Envelope> {
  const ref = String(args.model ?? '');
  const { provider: providerFromRef, model: modelId } = normalizeModelRef(ref);
  const provider = typeof args.provider === 'string' ? args.provider : providerFromRef;

  if (!ref) {
    o.fail('model is required, as "<model>" or "<provider>/<model>"');
    return finish(ctx, o, runId);
  }

  const cat = loadModelCatalog();
  const known = cat ? findModels(cat, modelId, provider) : [];
  if (cat && known.length === 0) {
    // Not fatal: a config may carry a model the catalogue does not list. Say so rather than refuse.
    o.warn(
      'model_not_in_catalogue',
      `"${ref}" is not in the model catalogue (${cat.source}). Proceeding, but the runtime may reject it.`,
      'degraded',
    );
  }

  const scope = String(args.scope ?? 'session');

  if (scope === 'server') {
    if (!provider) {
      o.fail('scope "server" needs a provider, because the base URL and credential are chosen per provider');
      return finish(ctx, o, runId);
    }
    const p = cat ? findProvider(cat, provider) : null;
    const baseURL = p ? anthropicBaseURL(p) : null;
    if (!baseURL) {
      o.fail(
        `cannot switch the server default to provider "${provider}": ` +
          (p ? 'it has no Anthropic-format endpoint in the catalogue' : 'the provider is not in the catalogue'),
      );
      return finish(ctx, o, runId);
    }
    const key = resolveApiKey(provider, process.env);
    if (!key) {
      o.warn(
        'provider_key_missing',
        `no credential for "${provider}" (tried ${apiKeyEnvCandidates(provider).join(', ')})`,
        'degraded',
      );
    }

    const previous = ctx.activeTarget()?.model ?? null;
    ctx.setActiveTarget({ model: `${provider}/${modelId}`, provider, baseURL });
    o.result({
      scope: 'server',
      model: `${provider}/${modelId}`,
      base_url: baseURL,
      previous_model: previous,
      credential_var: key?.name ?? null,
    });
    // Read-back: the in-process default really changed.
    o.readBack(ctx.activeTarget()?.model === `${provider}/${modelId}`, 'server default is set in this process');
    o.warn(
      'server_scoped_change',
      'this changes the default for runtimes THIS PROCESS spawns from now on. It does not rewrite ' +
        '.env, so it is lost on restart, and already-running runtimes keep their model until evicted. ' +
        `To persist it, set ZCODE_MCP_MODEL=${provider}/${modelId} and ZCODE_MCP_BASE_URL=${baseURL}.`,
      'advisory',
    );
    return finish(ctx, o, runId);
  }

  if (scope === 'workspace') {
    const t = Date.now();
    await runtime.client.request('workspace/setDefaultModel', {
      workspace: { workspacePath: workspace, workspaceKey: runtime.workspaceKey },
      model: ref,
    });
    o.method('workspace/setDefaultModel', true, Date.now() - t);
    const t2 = Date.now();
    const read = await runtime.client.request<{ settings?: { model?: { current?: ModelRef } } }>('workspace/readState', {
      workspace: { workspacePath: workspace, workspaceKey: runtime.workspaceKey },
    });
    o.method('workspace/readState', true, Date.now() - t2);
    const seen = read?.settings?.model?.current ?? null;
    const agrees = seen ? JSON.stringify(seen).includes(modelId) : false;
    o.readBack(agrees, agrees ? undefined : `requested ${ref}, workspace reports ${JSON.stringify(seen)}`);
    o.result({ scope: 'workspace', requested: ref, observed: seen });
    return finish(ctx, o, runId);
  }

  // session (default)
  const sessionId = typeof args.session_id === 'string' ? args.session_id : '';
  if (!sessionId) {
    o.fail('scope "session" needs a session_id');
    return finish(ctx, o, runId);
  }
  const t = Date.now();
  await runtime.client.request('session/setModel', { sessionId, model: ref });
  o.method('session/setModel', true, Date.now() - t);
  const t2 = Date.now();
  const read = await runtime.client.request<{ model?: ModelRef }>('session/read', { sessionId });
  o.method('session/read', true, Date.now() - t2);
  const seen = read?.model ?? null;
  const agrees = seen ? JSON.stringify(seen).includes(modelId) : false;
  o.readBack(agrees, agrees ? undefined : `requested ${ref}, session reports ${JSON.stringify(seen)}`);
  o.result({ scope: 'session', session_id: sessionId, requested: ref, observed: seen });
  return finish(ctx, o, runId);
}

function finish(ctx: ServerContext, o: Outcome, runId: string): Envelope {
  const env = o.finalise();
  ctx.record(env, runId);
  return env;
}
