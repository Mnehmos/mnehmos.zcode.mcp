/**
 * The model catalogue: what ZCode knows how to talk to, as data.
 *
 * Two sources, live-first:
 *   1. the installed ZCode's own `resources/model-providers/models_catalog_*.json`
 *   2. a vendored copy in `data/model_catalog.json`, so the tool still answers when the install
 *      moves, or on a machine where ZCode is somewhere unusual
 *
 * The envelope reports which source answered. Neither is a protocol method — the catalogue is a
 * resource file, the same class of dependency as a config file (control-surface rating B).
 *
 * The live runtime's own `workspace/readState` is a THIRD source and a different thing: it reports
 * only what is actually configured for that runtime. `available` uses that, because "what could I
 * use" and "what is wired up right now" are different questions and conflating them would mislead.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { discoverRuntime } from '../schema/env.js';

export interface CatalogModel {
  id: string;
  name?: string;
  kinds: string[];
  modalities?: { input?: string[]; output?: string[] };
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoningLevels?: string[];
  reasoningDefault?: string;
}

export interface CatalogProvider {
  id: string;
  name?: string;
  baseURL?: string;
  /** The path that speaks the Anthropic wire format, if the provider offers one. */
  anthropicPath?: string;
  openaiCompatiblePath?: string;
  defaultKind?: string;
  models: CatalogModel[];
}

export interface ModelCatalog {
  schemaVersion?: string;
  source: 'install' | 'vendored';
  sourcePath: string;
  providers: CatalogProvider[];
}

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Normalise a catalogue file.
 *
 * The install file and the vendored copy differ in shape: the install file nests transport details
 * under `endpoints: {baseURL, paths: {anthropic, openai-compatible}}`, while the vendored copy is
 * flattened. Reading the install file through the flat interface silently yielded `baseURL: undefined`
 * — which is exactly the kind of failure that looks like "the provider has no endpoint" rather than
 * "we parsed it wrong".
 */
export function normalizeCatalog(raw: Record<string, unknown>, source: ModelCatalog['source'], sourcePath: string): ModelCatalog | null {
  const providers = raw.providers;
  if (!Array.isArray(providers) || providers.length === 0) return null;

  const flat: CatalogProvider[] = [];
  for (const p of providers as Array<Record<string, unknown>>) {
    const endpoints = (p.endpoints ?? {}) as { baseURL?: string; paths?: Record<string, string> };
    const paths = endpoints.paths ?? {};
    const models = (Array.isArray(p.models) ? p.models : []).map((m) => {
      const mm = m as Record<string, unknown>;
      const r = (mm.reasoning ?? {}) as { levels?: Record<string, unknown>; defaultLevel?: string };
      return {
        id: String(mm.id ?? ''),
        name: typeof mm.name === 'string' ? mm.name : undefined,
        kinds: Array.isArray(mm.kinds) ? (mm.kinds as string[]) : [],
        modalities: mm.modalities as CatalogModel['modalities'],
        contextWindow: typeof mm.contextWindow === 'number' ? mm.contextWindow : undefined,
        maxOutputTokens: typeof mm.maxOutputTokens === 'number' ? mm.maxOutputTokens : undefined,
        reasoningLevels: r.levels ? Object.keys(r.levels) : undefined,
        reasoningDefault: r.defaultLevel,
      };
    });

    flat.push({
      id: String(p.id ?? ''),
      name: typeof p.name === 'string' ? p.name : undefined,
      baseURL: typeof endpoints.baseURL === 'string' ? endpoints.baseURL : (p.baseURL as string | undefined),
      anthropicPath: paths['anthropic'] ?? (p.anthropicPath as string | undefined),
      openaiCompatiblePath: paths['openai-compatible'] ?? (p.openaiCompatiblePath as string | undefined),
      defaultKind: typeof p.defaultKind === 'string' ? p.defaultKind : undefined,
      models,
    });
  }

  return {
    schemaVersion: typeof raw.schemaVersion === 'string' ? raw.schemaVersion : undefined,
    source,
    sourcePath,
    providers: flat,
  };
}

function readCatalogFile(p: string, source: ModelCatalog['source']): ModelCatalog | null {
  try {
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
    return normalizeCatalog(raw, source, p);
  } catch {
    return null;
  }
}

/** Find `models_catalog_*.json` under a ZCode install root. */
function installCatalogPath(): string | null {
  const discovery = discoverRuntime();
  if (!discovery.cli) return null;
  // <install>/resources/glm/zcode.cjs -> <install>/resources/model-providers/
  const resources = path.resolve(path.dirname(discovery.cli), '..');
  const dir = path.join(resources, 'model-providers');
  try {
    const hit = fs.readdirSync(dir).find((f) => f.startsWith('models_catalog_') && f.endsWith('.json'));
    return hit ? path.join(dir, hit) : null;
  } catch {
    return null;
  }
}

/** Load the catalogue, live install first. */
export function loadModelCatalog(): ModelCatalog | null {
  const install = installCatalogPath();
  if (install) {
    const c = readCatalogFile(install, 'install');
    if (c) return c;
  }
  return readCatalogFile(path.join(packageRoot, 'data', 'model_catalog.json'), 'vendored');
}

/** Normalise `provider/model` or a bare model id into parts. */
export function normalizeModelRef(ref: string): { provider: string | null; model: string } {
  const i = ref.indexOf('/');
  if (i <= 0) return { provider: null, model: ref };
  return { provider: ref.slice(0, i), model: ref.slice(i + 1) };
}

/** Find a provider by id, tolerating the `builtin:` prefix used in config files. */
export function findProvider(catalog: ModelCatalog, id: string): CatalogProvider | null {
  const want = id.replace(/^builtin:/, '').toLowerCase();
  return (
    catalog.providers.find((p) => p.id.toLowerCase() === want) ??
    catalog.providers.find((p) => p.id.toLowerCase().includes(want) || want.includes(p.id.toLowerCase())) ??
    null
  );
}

/** Find a model by id within a provider, or across the whole catalogue. */
export function findModels(
  catalog: ModelCatalog,
  modelId: string,
  providerId?: string | null,
): Array<{ provider: CatalogProvider; model: CatalogModel }> {
  const pools = providerId ? [findProvider(catalog, providerId)].filter(Boolean) as CatalogProvider[] : catalog.providers;
  const want = modelId.toLowerCase();
  const out: Array<{ provider: CatalogProvider; model: CatalogModel }> = [];
  for (const p of pools) {
    for (const m of p.models) {
      // Exact first; then a prefix match, because config files carry dated aliases like
      // `deepseek-v4.1-flash-expires-on-0910` whose canonical id is `deepseek-v4-flash`.
      if (m.id.toLowerCase() === want) out.unshift({ provider: p, model: m });
      else if (m.id.toLowerCase().startsWith(want) || want.startsWith(m.id.toLowerCase())) out.push({ provider: p, model: m });
    }
  }
  return out;
}

export interface CatalogFilter {
  provider?: string;
  /** Only models whose context window is at least this. */
  minContext?: number;
  /** Only models accepting this input modality, e.g. "image". */
  inputModality?: string;
  /** Only models offering this reasoning level. */
  reasoningLevel?: string;
  /** Only models of this wire kind. */
  kind?: string;
}

/** Factual filtering. No ranking, no "recommended" score — choosing is the caller's job. */
export function filterModels(
  catalog: ModelCatalog,
  filter: CatalogFilter,
): Array<{ provider: CatalogProvider; model: CatalogModel }> {
  const out: Array<{ provider: CatalogProvider; model: CatalogModel }> = [];
  for (const p of catalog.providers) {
    if (filter.provider && findProvider(catalog, filter.provider)?.id !== p.id) continue;
    for (const m of p.models) {
      if (filter.minContext !== undefined && (m.contextWindow ?? 0) < filter.minContext) continue;
      if (filter.inputModality && !(m.modalities?.input ?? []).includes(filter.inputModality)) continue;
      if (filter.kind && !(m.kinds ?? []).includes(filter.kind)) continue;
      if (filter.reasoningLevel && !(m.reasoningLevels ?? []).includes(filter.reasoningLevel)) continue;
      out.push({ provider: p, model: m });
    }
  }
  return out;
}

/** The base URL a provider should be reached at for the Anthropic wire format. */
export function anthropicBaseURL(provider: CatalogProvider): string | null {
  if (!provider.baseURL || !provider.anthropicPath) return null;
  // paths look like "/api/anthropic/v1/messages"; the base we hand the runtime is the prefix
  const p = provider.anthropicPath.replace(/\/v1\/messages$/, '');
  return `${provider.baseURL.replace(/\/+$/, '')}${p}`;
}
