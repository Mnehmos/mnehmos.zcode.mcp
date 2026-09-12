/**
 * Provider bootstrap: give a spawned runtime a model provider.
 *
 * Two sources, in order: this process's environment, then ZCode's own provider registry when the
 * environment supplies nothing (`resolveApiKey`). The environment wins because it is the explicit
 * act. The registry fallback exists because the runtime reads no config of its own, so a user who
 * configured their model in ZCode — which should be the only place they have to — would otherwise
 * have to enter the key a second time. See A25/A26 in `.re/findings_ADDENDUM.md`.
 *
 * Why any of this is needed (audited, CONFIRMED): a bare `app-server` has no provider and no
 * credentials. It reports `model.current = {modelId:"missing-model", providerId:"zcode-unconfigured"}`
 * and `zcode --prompt` fails with "Model config is missing". The desktop owns the provider registry
 * and pushes it into its own children; we are not the desktop, so we must supply one.
 *
 * How (found by static analysis, then PROVEN by observing the error change):
 *
 *   the agent builds a config layer from the environment at priority 40 (`parseEnvConfig`):
 *
 *     ZCODE_MODEL     = "<model>" or "<provider>/<model>"      -> model.main
 *     ZCODE_BASE_URL  = base URL                               -> model.main.baseURL
 *     ZCODE_API_KEY   = the credential (via apiKeyEnvCandidates)
 *
 *   and `WRo` hardcodes `kind:"anthropic"` for this path, with `defaultProviderId:"anthropic"`.
 *
 * Verified: with ZCODE_MODEL set, a spawned runtime stops reporting "Model config is missing" and
 * attempts the call (in the test, to an unresolvable host, so it costs nothing). Without it, the
 * error stands.
 *
 * Deliberately NOT done: writing a provider config file. An earlier design wrote
 * `<workspace>/.zcode/config.json`, which pollutes a user's working tree to configure a process we
 * own. It also did not work — the project/user config layers rejected the minimal shape — while the
 * environment path does. Environment-first is both cleaner and the one that actually functions.
 *
 * Constitution Article IV: the key is passed through the child's environment and is never written
 * to any file, never logged, and never echoed in a result.
 */
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

import { isSensitiveKey } from './redact.js';

export interface ModelTarget {
  /** Model id, or `<provider>/<model>`. */
  model: string;
  /** Provider id. Optional: it can be encoded as the prefix of `model`. */
  provider?: string;
  baseURL?: string;
  /**
   * NOTE: the environment path pins this to "anthropic". Recorded so the caller is not surprised;
   * a non-anthropic provider must be configured by the user in their own config file.
   */
  kind?: 'anthropic';
}

export interface BootstrapResult {
  /** Set when a credential-shaped variable was withheld from the child, for disclosure. */
  withheldCredentials?: string[];
  /** Where the effective provider came from. */
  source: 'environment' | 'user-config' | 'existing-project-config' | 'none';
  /** Env entries to merge into the child's environment. Never contains a file path key. */
  childEnv: Record<string, string>;
  /** The config path we found, when a file already supplies the provider. */
  configPath: string | null;
  warnings: Array<{ code: string; detail: string; impact: 'advisory' | 'degraded' | 'unreliable' }>;
}

/**
 * The env var names the agent checks for a provider key, in its own order
 * (`apiKeyEnvCandidates`): kind-specific first, then derived from the provider id, then ZCODE_API_KEY.
 */
export function apiKeyEnvCandidates(provider: string): string[] {
  const norm = (s: string) => s.trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
  const names: string[] = [];
  // Provider-specific FIRST. The runtime's own order puts the kind-generic key ahead, which is fine
  // for a single-provider config and wrong for a shared .env holding several: naming
  // `deepseek/...` must select the DeepSeek key, not ANTHROPIC_API_KEY.
  for (const n of [provider, provider.replace(/^default[-_]/, '')]) {
    const k = norm(n);
    if (k && !names.includes(`${k}_API_KEY`)) names.push(`${k}_API_KEY`);
  }
  names.push('ANTHROPIC_API_KEY'); // kind is pinned to anthropic on the env path
  names.push('ZCODE_API_KEY');
  return names;
}

/**
 * Variables that must never be inherited by a spawned runtime.
 *
 * Reuses the redaction vocabulary rather than inventing a second list, so "what counts as a
 * credential" has exactly one definition in this codebase.
 */
export function isCredentialEnvVar(name: string): boolean {
  return isSensitiveKey(name);
}

/**
 * Build the environment for a spawned ZCode runtime.
 *
 * Inherit everything EXCEPT credential-shaped variables, then add back the single key we resolved.
 * Inheritance is broad on purpose — the runtime needs PATH, HOME/USERPROFILE, TEMP and the Windows
 * essentials to function — but an ambient credential it was not given is a leak, not a convenience.
 * With several providers configured in one .env, inheriting all of them would also make the runtime
 * pick whichever matched first rather than the one that was actually selected.
 *
 * `ZCODE_MCP_CHILD_ENV_PASSTHROUGH` (comma-separated names) re-admits specific variables for a user
 * who genuinely wants the agent's shell to have them, e.g. a git token.
 */
export function buildChildEnv(
  resolvedKey: { name: string; value: string } | null,
  parent: NodeJS.ProcessEnv = process.env,
  passthrough: string[] = [],
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined) continue;
    if (isCredentialEnvVar(k)) continue;
    out[k] = v;
  }
  for (const name of passthrough) {
    const v = parent[name];
    if (v !== undefined) out[name] = v;
  }
  if (resolvedKey) out.ZCODE_API_KEY = resolvedKey.value;
  return out;
}

export interface RegistryHint {
  /** The endpoint the runtime is about to call — the strongest match, since the key must belong to it. */
  baseURL?: string;
  /** The model id, checked against each provider's own model list. A weaker signal than the URL. */
  model?: string;
}

interface RegistryProvider {
  enabled?: boolean;
  options?: { apiKey?: string; baseURL?: string };
  models?: Record<string, unknown>;
}

const normURL = (u?: string): string => (u ?? '').trim().replace(/\/+$/, '').toLowerCase();

/**
 * How strongly two endpoints are the same provider: 3 exact, 2 one is a path-prefix of the other,
 * 0 unrelated.
 *
 * Exact equality is not enough. A registry entry for DeepSeek stores `https://api.deepseek.com`
 * while the runtime is configured with `https://api.deepseek.com/anthropic` — the same provider, one
 * path segment apart, and an equality test silently finds nothing.
 */
function urlScore(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 3;
  const atBoundary = (short: string, long: string): boolean =>
    long.startsWith(short.endsWith('/') ? short : `${short}/`);
  return atBoundary(a, b) || atBoundary(b, a) ? 2 : 0;
}

/**
 * A credential from ZCode's own provider registry, for when the environment did not supply one.
 *
 * Why this exists: a spawned runtime reads NO config — not even ZCode's own provider registry (A25).
 * So a user who configured their model in the model menu, which is the one place they should have to
 * configure it, had to enter the key a SECOND time somewhere this server could see. That duplication
 * was the whole reason setup was confusing. Reading it here removes the second entry.
 *
 * Deliberately narrow:
 *   - read-only, and only `options.apiKey` for the provider that matches
 *   - `~/.zcode/v2/credentials.json` is never touched — a different file, a machine-derivable cipher,
 *     and Constitution Article IV keeps it off-limits regardless of feasibility
 *   - the value never reaches a log, an envelope or a tool result; only `name` does, and `name` is a
 *     label, not the secret
 *
 * Matching is scored, endpoint first, because provider ids are UUIDs or `builtin:*` and the
 * `deepseek` in `deepseek/…` matches nothing. Both signals were got wrong the first time: the URL
 * needs a prefix relationship, not equality, and the model must be compared WITHOUT its provider
 * prefix (the registry lists `deepseek-v4.1-…`, the ref is `deepseek/deepseek-v4.1-…`).
 */
export function keyFromProviderRegistry(
  hint: RegistryHint,
  home: string = homedir(),
): { name: string; value: string } | null {
  let cfg: { provider?: Record<string, RegistryProvider> };
  try {
    const p = path.join(home, '.zcode', 'v2', 'config.json');
    if (!fs.existsSync(p)) return null;
    cfg = JSON.parse(fs.readFileSync(p, 'utf8')) as typeof cfg;
  } catch {
    return null; // unreadable or malformed is simply "no key here", never a thrown error
  }

  const wanted = normURL(hint.baseURL);
  const candidates = Object.entries(cfg.provider ?? {})
    .filter(([, v]) => v?.enabled !== false && typeof v?.options?.apiKey === 'string' && v.options.apiKey.trim() !== '')
    .map(([id, v]) => {
      const url = urlScore(wanted, normURL(v.options?.baseURL));
      const model = hint.model && v.models && hint.model in v.models ? 1 : 0;
      // URL is weighted far above the model list: the key has to belong to the endpoint we are about
      // to call, whereas a provider may serve a model it does not advertise. The model list is what
      // rescues a machine whose registry stores an endpoint we cannot relate to ours.
      return { id, key: v.options!.apiKey!.trim(), score: url * 10 + model };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);

  const hit = candidates[0];
  if (!hit) return null;
  return { name: `zcode provider registry:${hit.id}`, value: hit.key };
}

/** True when a key came from the registry rather than the environment, so callers can say so. */
export const isRegistryKey = (k: { name: string } | null): boolean =>
  !!k && k.name.startsWith('zcode provider registry:');

/**
 * Pick a key: our own process environment first, then ZCode's provider registry.
 *
 * The environment wins because it is the explicit act — a caller who set `DEEPSEEK_API_KEY` meant
 * that one, and it must keep working on a machine where the registry holds something different.
 */
export function resolveApiKey(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
  hint: RegistryHint = {},
): { name: string; value: string } | null {
  for (const name of apiKeyEnvCandidates(provider)) {
    const v = env[name];
    if (v && v.trim()) return { name, value: v.trim() };
  }
  return keyFromProviderRegistry(hint);
}

/** `provider/model` is split by the agent itself; we do the same to derive a key-var name. */
export function splitModelRef(ref: string): { provider?: string; model: string } {
  const t = ref.trim();
  const i = t.indexOf('/');
  if (i <= 0) return { model: t };
  return { provider: t.slice(0, i), model: t.slice(i + 1) };
}

/** Reject shapes the agent rejects, before we spawn anything. */
export function validateTarget(t: ModelTarget): string | null {
  if (!t.model?.trim()) return 'model is required (ZCODE_MODEL, as "<model>" or "<provider>/<model>")';
  const { provider, model } = splitModelRef(t.model);
  if (!provider && !t.provider) {
    // Not fatal: the agent defaults the provider to "anthropic". Worth a note, not a refusal.
    return null;
  }
  if (!model) return `could not read a model id out of "${t.model}"`;
  return null;
}

function readJsonIfPresent(p: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(p)) return null;
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Does a config file already supply `model.main` with a provider and a model? */
export function configHasModel(cfg: Record<string, unknown> | null): boolean {
  const main = (cfg?.model as Record<string, unknown> | undefined)?.main as Record<string, unknown> | undefined;
  return Boolean(main && typeof main.provider === 'string' && typeof main.model === 'string');
}

/** Where the runtime would look for each config layer, for diagnostics and for "is it configured?". */
export function configPaths(workspace: string, env: NodeJS.ProcessEnv = process.env) {
  const home = env.USERPROFILE ?? env.HOME ?? '';
  return {
    user: home ? path.join(home, '.zcode', 'cli', 'config.json') : null,
    projectZcodeJson: path.join(workspace, 'zcode.json'),
    projectDotZcode: path.join(workspace, '.zcode', 'config.json'),
  };
}

export interface BootstrapOptions {
  workspace: string;
  /** The provider to install when nothing else supplies one. */
  target?: ModelTarget;
  env?: NodeJS.ProcessEnv;
}

/**
 * Ensure the spawned runtime will have a model provider.
 *
 * Order of precedence, matching the agent's own layering (env is priority 40, above the project and
 * user layers at 20 and 10):
 *
 *   1. if the caller supplied a target -> inject ZCODE_MODEL (+ ZCODE_BASE_URL, + ZCODE_API_KEY)
 *   2. else if a config layer already has a model -> do nothing, the runtime will find it
 *   3. else -> report `none` with the exact variables to set; never invent a provider
 */
export function bootstrapProvider(opts: BootstrapOptions): BootstrapResult {
  const env = opts.env ?? process.env;
  const warnings: BootstrapResult['warnings'] = [];
  const passthrough = (env.ZCODE_MCP_CHILD_ENV_PASSTHROUGH ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  /** Every credential-shaped variable we are deliberately NOT handing to the child. */
  const withheld = Object.keys(env).filter((k) => isCredentialEnvVar(k));

  if (opts.target) {
    const invalid = validateTarget(opts.target);
    if (invalid) {
      warnings.push({ code: 'provider_config_invalid', detail: invalid, impact: 'unreliable' });
      return { source: 'none', childEnv: buildChildEnv(null, env, passthrough) as Record<string, string>, configPath: null, warnings, withheldCredentials: withheld };
    }

    const providerForKeys = opts.target.provider ?? splitModelRef(opts.target.model).provider ?? 'anthropic';
    // The registry lists bare ids (`deepseek-v4.1-…`), never `provider/model`, so the hint uses the
    // split id. Passing the raw ref matches nothing — that was bug #2 in this fallback.
    const hint = { baseURL: opts.target.baseURL, model: splitModelRef(opts.target.model).model };
    const childEnv: Record<string, string> = {
      ...(buildChildEnv(resolveApiKey(providerForKeys, env, hint), env, passthrough) as Record<string, string>),
      ZCODE_MODEL: opts.target.model,
    };
    if (opts.target.baseURL) {
      childEnv.ZCODE_BASE_URL = opts.target.baseURL;
      warnings.push({
        code: 'zc_base_url_dual_purpose',
        detail:
          'ZCODE_BASE_URL configures the model base URL AND the ZCode control-plane endpoint origin. ' +
          'For a local agent runtime the control-plane origin is unused, but do not point this at an ' +
          'endpoint you would not also accept as the API origin.',
        impact: 'advisory',
      });
    }

    const key = resolveApiKey(providerForKeys, env, hint);
    if (!key) {
      warnings.push({
        code: 'provider_key_missing',
        detail:
          `No credential found for provider "${providerForKeys}". Set one of: ` +
          `${apiKeyEnvCandidates(providerForKeys).join(', ')}, or configure the provider in ZCode ` +
          `itself. Model calls will fail with an auth error.`,
        impact: 'degraded',
      });
    } else if (isRegistryKey(key)) {
      // Say where it came from. A key the caller did not set, that we found in a file, is worth
      // naming — otherwise "it works" hides which credential is being spent.
      warnings.push({
        code: 'provider_key_from_registry',
        detail:
          `No credential in the environment for "${providerForKeys}"; using the one configured in ` +
          `ZCode's provider registry (${key.name.slice('zcode provider registry:'.length)}). ` +
          `Set ${apiKeyEnvCandidates(providerForKeys)[0]} to choose a different one.`,
        impact: 'advisory',
      });
    }

    return { source: 'environment', childEnv, configPath: null, warnings, withheldCredentials: withheld };
  }

  // No target supplied: is the runtime already configured by a file we did not write?
  const paths = configPaths(opts.workspace, env);
  if (paths.projectDotZcode && configHasModel(readJsonIfPresent(paths.projectDotZcode))) {
    return { source: 'existing-project-config', childEnv: buildChildEnv(null, env, passthrough) as Record<string, string>, configPath: paths.projectDotZcode, warnings, withheldCredentials: withheld };
  }
  if (paths.projectZcodeJson && configHasModel(readJsonIfPresent(paths.projectZcodeJson))) {
    return { source: 'existing-project-config', childEnv: buildChildEnv(null, env, passthrough) as Record<string, string>, configPath: paths.projectZcodeJson, warnings, withheldCredentials: withheld };
  }
  if (paths.user && configHasModel(readJsonIfPresent(paths.user))) {
    return { source: 'user-config', childEnv: buildChildEnv(null, env, passthrough) as Record<string, string>, configPath: paths.user, warnings, withheldCredentials: withheld };
  }

  warnings.push({
    code: 'provider_not_configured',
    detail:
      'No model provider is configured, so model-dependent calls will fail with the runtime\'s own ' +
      '"Model config is missing" message. Fix it either by setting ZCODE_MCP_MODEL ' +
      '("<model>" or "<provider>/<model>") plus ZCODE_MCP_BASE_URL and a key in the environment, or ' +
      `by creating ${paths.user ?? '~/.zcode/cli/config.json'} with a "model" block yourself.`,
    impact: 'unreliable',
  });
  return { source: 'none', childEnv: buildChildEnv(null, env, passthrough) as Record<string, string>, configPath: null, warnings, withheldCredentials: withheld };
}

/** Read a provider target from this server's own environment. */
export function targetFromEnv(env: NodeJS.ProcessEnv = process.env): ModelTarget | undefined {
  const ref = env.ZCODE_MCP_MODEL?.trim();
  if (!ref) return undefined;
  const baseURL = env.ZCODE_MCP_BASE_URL?.trim();
  const { provider } = splitModelRef(ref);
  return {
    model: ref,
    ...(provider ? { provider } : {}),
    ...(baseURL ? { baseURL } : {}),
  };
}

/** Does the process environment hold any credential we could use? Reported, never printed. */
export function hasAmbientKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return Object.keys(env).some(
    (k) => k === 'ZCODE_API_KEY' || k === 'ANTHROPIC_API_KEY' || k === 'OPENAI_API_KEY' || k.endsWith('_API_KEY'),
  );
}
