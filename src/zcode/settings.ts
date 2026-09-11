/**
 * Provider bootstrap: give a spawned runtime a model provider, using ONLY environment variables.
 *
 * Why this is needed (audited, CONFIRMED): a bare `app-server` has no provider and no credentials.
 * It reports `model.current = {modelId:"missing-model", providerId:"zcode-unconfigured"}` and
 * `zcode --prompt` fails with "Model config is missing". The desktop owns the provider registry
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
import * as path from 'node:path';

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
  const names = new Set<string>();
  names.add('ANTHROPIC_API_KEY'); // WRo pins kind to anthropic, so this is always a candidate
  for (const n of [provider, provider.replace(/^default[-_]/, '')]) {
    const k = norm(n);
    if (k) names.add(`${k}_API_KEY`);
  }
  names.add('ZCODE_API_KEY');
  return [...names];
}

/**
 * Pick a key from OUR OWN process environment. We never read ZCode's credential store: values there
 * are AES-256-GCM with a machine-derivable fallback key, which is exactly the sort of thing
 * Constitution Article IV forbids touching even though it is technically possible.
 */
export function resolveApiKey(provider: string, env: NodeJS.ProcessEnv = process.env): { name: string; value: string } | null {
  for (const name of apiKeyEnvCandidates(provider)) {
    const v = env[name];
    if (v && v.trim()) return { name, value: v.trim() };
  }
  return null;
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

  if (opts.target) {
    const invalid = validateTarget(opts.target);
    if (invalid) {
      warnings.push({ code: 'provider_config_invalid', detail: invalid, impact: 'unreliable' });
      return { source: 'none', childEnv: {}, configPath: null, warnings };
    }

    const childEnv: Record<string, string> = { ZCODE_MODEL: opts.target.model };
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

    const provider = opts.target.provider ?? splitModelRef(opts.target.model).provider ?? 'anthropic';
    const key = resolveApiKey(provider, env);
    if (key) {
      childEnv.ZCODE_API_KEY = key.value;
    } else {
      warnings.push({
        code: 'provider_key_missing',
        detail:
          `No credential found for provider "${provider}". Set one of: ` +
          `${apiKeyEnvCandidates(provider).join(', ')}. Model calls will fail with an auth error.`,
        impact: 'degraded',
      });
    }

    return { source: 'environment', childEnv, configPath: null, warnings };
  }

  // No target supplied: is the runtime already configured by a file we did not write?
  const paths = configPaths(opts.workspace, env);
  if (paths.projectDotZcode && configHasModel(readJsonIfPresent(paths.projectDotZcode))) {
    return { source: 'existing-project-config', childEnv: {}, configPath: paths.projectDotZcode, warnings };
  }
  if (paths.projectZcodeJson && configHasModel(readJsonIfPresent(paths.projectZcodeJson))) {
    return { source: 'existing-project-config', childEnv: {}, configPath: paths.projectZcodeJson, warnings };
  }
  if (paths.user && configHasModel(readJsonIfPresent(paths.user))) {
    return { source: 'user-config', childEnv: {}, configPath: paths.user, warnings };
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
  return { source: 'none', childEnv: {}, configPath: null, warnings };
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
