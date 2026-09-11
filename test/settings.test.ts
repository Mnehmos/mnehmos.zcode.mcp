/**
 * Provider-bootstrap unit tests. No process is spawned and no credential is read: these cover the
 * decisions (which env vars get built, when we refuse, when we stay out of the way).
 *
 * The end-to-end proof that a spawned runtime actually consumes ZCODE_MODEL lives in
 * integration.test.ts, because only a real runtime can demonstrate it.
 */
import { describe, expect, it } from '@jest/globals';

import {
  apiKeyEnvCandidates,
  bootstrapProvider,
  buildChildEnv,
  isCredentialEnvVar,
  configHasModel,
  hasAmbientKey,
  resolveApiKey,
  splitModelRef,
  targetFromEnv,
  validateTarget,
} from '../src/zcode/settings.js';

describe('splitModelRef', () => {
  it('reads a bare model id', () => {
    expect(splitModelRef('glm-4')).toEqual({ model: 'glm-4' });
  });
  it('reads provider/model', () => {
    expect(splitModelRef('zai/glm-4')).toEqual({ provider: 'zai', model: 'glm-4' });
  });
  it('treats a leading slash as part of the model, not a provider', () => {
    expect(splitModelRef('/weird')).toEqual({ model: '/weird' });
  });
});

describe('apiKeyEnvCandidates', () => {
  it('always includes ANTHROPIC_API_KEY and ZCODE_API_KEY, because the env path pins kind', () => {
    const c = apiKeyEnvCandidates('zai');
    expect(c).toContain('ANTHROPIC_API_KEY');
    expect(c).toContain('ZCODE_API_KEY');
  });

  it('derives a provider-specific name and normalises it', () => {
    expect(apiKeyEnvCandidates('my-provider')).toContain('MY_PROVIDER_API_KEY');
  });

  it('strips a default- prefix so the same key works under either id', () => {
    const c = apiKeyEnvCandidates('default-zai');
    expect(c).toContain('ZAI_API_KEY');
    expect(c).toContain('DEFAULT_ZAI_API_KEY');
  });
});

describe('resolveApiKey', () => {
  it('prefers ANTHROPIC_API_KEY, matching the agent order', () => {
    const found = resolveApiKey('zai', { ANTHROPIC_API_KEY: 'a', ZCODE_API_KEY: 'b' } as NodeJS.ProcessEnv);
    expect(found).toEqual({ name: 'ANTHROPIC_API_KEY', value: 'a' });
  });

  it('falls back to ZCODE_API_KEY', () => {
    expect(resolveApiKey('zai', { ZCODE_API_KEY: 'b' } as NodeJS.ProcessEnv)).toEqual({
      name: 'ZCODE_API_KEY',
      value: 'b',
    });
  });

  it('returns null when nothing is set, rather than inventing a value', () => {
    expect(resolveApiKey('zai', {} as NodeJS.ProcessEnv)).toBeNull();
  });

  it('ignores blank values', () => {
    expect(resolveApiKey('zai', { ZCODE_API_KEY: '   ' } as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe('buildChildEnv — credential isolation', () => {
  const parent = {
    PATH: '/usr/bin',
    HOME: '/home/u',
    USERPROFILE: 'C:/Users/u',
    TEMP: '/tmp',
    SystemRoot: 'C:/Windows',
    DEEPSEEK_API_KEY: 'ds-secret',
    OPENROUTER_API_KEY: 'or-secret',
    ZAI_API_KEY: 'zai-secret',
    ANTHROPIC_API_KEY: 'anthropic-secret',
    GITHUB_TOKEN: 'gh-secret',
    ZCODE_CREDENTIAL_SECRET: 'cipher-secret',
    NORMAL_VAR: 'keep-me',
  } as NodeJS.ProcessEnv;

  it('keeps the variables a runtime needs to function', () => {
    const env = buildChildEnv(null, parent);
    for (const k of ['PATH', 'HOME', 'USERPROFILE', 'TEMP', 'SystemRoot', 'NORMAL_VAR']) {
      expect(env[k]).toBe(parent[k]);
    }
  });

  it('withholds EVERY credential-shaped variable when none was resolved', () => {
    // The point of the .env holding three provider keys is that only the SELECTED one reaches the
    // runtime. Inheriting all three would let it pick whichever matched first.
    const env = buildChildEnv(null, parent);
    for (const k of ['DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'ZAI_API_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'ZCODE_CREDENTIAL_SECRET']) {
      expect(env[k]).toBeUndefined();
    }
  });

  it('adds back exactly the one key that was resolved', () => {
    const env = buildChildEnv({ name: 'DEEPSEEK_API_KEY', value: 'the-one' }, parent);
    expect(env.ZCODE_API_KEY).toBe('the-one');
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('re-admits only explicitly named variables via passthrough', () => {
    const env = buildChildEnv(null, parent, ['GITHUB_TOKEN']);
    expect(env.GITHUB_TOKEN).toBe('gh-secret');
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
  });

  it('never mutates the parent environment', () => {
    buildChildEnv(null, parent);
    expect(parent.DEEPSEEK_API_KEY).toBe('ds-secret');
  });

  it('classifies credential-shaped names and leaves ordinary ones alone', () => {
    for (const k of ['DEEPSEEK_API_KEY', 'GITHUB_TOKEN', 'MY_SECRET', 'DB_PASSWORD', 'AWS_CREDENTIAL']) {
      expect(isCredentialEnvVar(k)).toBe(true);
    }
    for (const k of ['PATH', 'USERPROFILE', 'TEMP', 'LANG', 'NODE_ENV', 'ZCODE_MODEL']) {
      expect(isCredentialEnvVar(k)).toBe(false);
    }
  });
});

describe('apiKeyEnvCandidates — provider-specific wins', () => {
  it('puts the named provider first, so a shared .env selects the right key', () => {
    const c = apiKeyEnvCandidates('deepseek');
    expect(c[0]).toBe('DEEPSEEK_API_KEY');
    expect(c).toContain('ANTHROPIC_API_KEY');
    expect(c).toContain('ZCODE_API_KEY');
  });

  it('resolves the DeepSeek key even when ANTHROPIC_API_KEY is also set', () => {
    const env = { ANTHROPIC_API_KEY: 'wrong', DEEPSEEK_API_KEY: 'right' } as NodeJS.ProcessEnv;
    expect(resolveApiKey('deepseek', env)).toEqual({ name: 'DEEPSEEK_API_KEY', value: 'right' });
  });

  it('falls back to the kind-generic key when the provider has none', () => {
    const env = { ANTHROPIC_API_KEY: 'generic' } as NodeJS.ProcessEnv;
    expect(resolveApiKey('some-unknown-provider', env)).toEqual({ name: 'ANTHROPIC_API_KEY', value: 'generic' });
  });
});

describe('validateTarget', () => {
  it('accepts provider/model and a bare model', () => {
    expect(validateTarget({ model: 'zai/glm-4' })).toBeNull();
    expect(validateTarget({ model: 'glm-4' })).toBeNull();
  });
  it('rejects an empty model', () => {
    expect(validateTarget({ model: '  ' })).toMatch(/model is required/);
  });
});

describe('bootstrapProvider', () => {
  it('builds ZCODE_MODEL and the key, and never writes a file', () => {
    const r = bootstrapProvider({
      workspace: 'C:/nonexistent-workspace',
      target: { model: 'zai/glm-4', baseURL: 'https://api.example/v1' },
      env: { ZCODE_API_KEY: 'secret-value', USERPROFILE: 'C:/no-such-home' } as NodeJS.ProcessEnv,
    });
    expect(r.source).toBe('environment');
    expect(r.childEnv.ZCODE_MODEL).toBe('zai/glm-4');
    expect(r.childEnv.ZCODE_BASE_URL).toBe('https://api.example/v1');
    expect(r.childEnv.ZCODE_API_KEY).toBe('secret-value');
    expect(r.configPath).toBeNull();
  });

  it('warns that ZCODE_BASE_URL is dual-purpose rather than silently setting it', () => {
    const r = bootstrapProvider({
      workspace: 'C:/nonexistent',
      target: { model: 'm', baseURL: 'https://api.example/v1' },
      env: { ZCODE_API_KEY: 'k' } as NodeJS.ProcessEnv,
    });
    expect(r.warnings.map((w) => w.code)).toContain('zc_base_url_dual_purpose');
  });

  it('warns with the exact variable names when no key is available', () => {
    const r = bootstrapProvider({
      workspace: 'C:/nonexistent',
      target: { model: 'zai/glm-4' },
      env: {} as NodeJS.ProcessEnv,
    });
    const w = r.warnings.find((x) => x.code === 'provider_key_missing');
    expect(w).toBeDefined();
    expect(w!.detail).toContain('ZCODE_API_KEY');
    expect(w!.impact).toBe('degraded');
  });

  it('stays out of the way when a config file already supplies a model', () => {
    // A workspace whose .zcode/config.json we cannot see resolves to "user-config" or "none"
    // depending on the machine, so assert only that no env override is injected.
    const r = bootstrapProvider({ workspace: 'C:/nonexistent', env: {} as NodeJS.ProcessEnv });
    expect(r.childEnv).toEqual({});
    expect(['user-config', 'existing-project-config', 'none']).toContain(r.source);
  });

  it('reports unreliable, not silence, when nothing is configured', () => {
    const r = bootstrapProvider({ workspace: 'C:/nonexistent', env: {} as NodeJS.ProcessEnv });
    if (r.source === 'none') {
      const w = r.warnings.find((x) => x.code === 'provider_not_configured');
      expect(w?.impact).toBe('unreliable');
      expect(w?.detail).toContain('ZCODE_MCP_MODEL');
    }
  });

  it('refuses an invalid target instead of spawning a doomed runtime', () => {
    const r = bootstrapProvider({ workspace: 'C:/x', target: { model: '' }, env: {} as NodeJS.ProcessEnv });
    expect(r.source).toBe('none');
    expect(r.warnings[0]?.code).toBe('provider_config_invalid');
  });
});

describe('configHasModel', () => {
  it('is true only when provider and model are both present', () => {
    expect(configHasModel({ model: { main: { provider: 'p', model: 'm' } } })).toBe(true);
    expect(configHasModel({ model: { main: { provider: 'p' } } })).toBe(false);
    expect(configHasModel({ model: {} })).toBe(false);
    expect(configHasModel(null)).toBe(false);
  });
});

describe('hasAmbientKey', () => {
  it('spots the known names and any *_API_KEY', () => {
    expect(hasAmbientKey({ ZCODE_API_KEY: 'x' } as NodeJS.ProcessEnv)).toBe(true);
    expect(hasAmbientKey({ SOMETHING_API_KEY: 'x' } as NodeJS.ProcessEnv)).toBe(true);
    expect(hasAmbientKey({} as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('targetFromEnv', () => {
  it('reads ZCODE_MCP_MODEL and infers the provider', () => {
    expect(targetFromEnv({ ZCODE_MCP_MODEL: 'zai/glm-4' } as NodeJS.ProcessEnv)).toEqual({
      model: 'zai/glm-4',
      provider: 'zai',
    });
  });
  it('returns undefined when unset', () => {
    expect(targetFromEnv({} as NodeJS.ProcessEnv)).toBeUndefined();
  });
});
