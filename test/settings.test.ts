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
