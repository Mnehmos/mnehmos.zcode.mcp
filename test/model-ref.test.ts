/**
 * The `provider/model` string a caller writes becomes a `ModelRef` object the protocol accepts.
 *
 * `session/setModel` rejects a string with `-32602 Invalid params — model: expected object, received
 * string`, which is how both `zcode_models select scope:"session"` and `zcode_session set_model`
 * were found to be broken. These cases pin the conversion and the refusal.
 */
import { describe, expect, it } from '@jest/globals';

import { modelRefObject, normalizeModelRef } from '../src/zcode/model-catalog.js';
import { ProviderBlock } from '../src/schema/tools.js';

describe('normalizeModelRef', () => {
  it('splits on the FIRST slash, because model ids can contain slashes', () => {
    // OpenRouter ids look like `google/gemini-3.8-flash`, so the ref is `<provider>/google/gemini-…`.
    expect(normalizeModelRef('deepseek/deepseek-v4-pro')).toEqual({ provider: 'deepseek', model: 'deepseek-v4-pro' });
    expect(normalizeModelRef('uuid-here/google/gemini-3.8-flash')).toEqual({
      provider: 'uuid-here',
      model: 'google/gemini-3.8-flash',
    });
  });
});

describe('modelRefObject', () => {
  it('builds the object the protocol wants', () => {
    expect(modelRefObject('deepseek/deepseek-v4-pro')).toEqual({
      modelId: 'deepseek-v4-pro',
      providerId: 'deepseek',
    });
  });

  it('keeps a slashed model id intact', () => {
    expect(modelRefObject('uuid/google/gemini-3.8-flash')).toEqual({
      modelId: 'google/gemini-3.8-flash',
      providerId: 'uuid',
    });
  });

  it('accepts an explicit provider that overrides the ref prefix', () => {
    expect(modelRefObject('deepseek-v4-pro', 'f4f09303-abc')).toEqual({
      modelId: 'deepseek-v4-pro',
      providerId: 'f4f09303-abc',
    });
  });

  it('refuses a bare model id rather than inventing a provider', () => {
    // Provider ids are UUIDs in a user's config, so there is nothing to guess FROM.
    expect(modelRefObject('deepseek-v4-pro')).toBeNull();
  });

  it('refuses an empty ref or a leading slash', () => {
    expect(modelRefObject('')).toBeNull();
    expect(modelRefObject('/deepseek-v4-pro')).toBeNull();
    expect(modelRefObject('deepseek/')).toBeNull();
  });
});

/**
 * `ProviderBlock` must match the runtime's own schema, which is strict. The previous version required
 * `{provider, model}` and could never succeed: the runtime wants `providerId`, `kind` and a non-empty
 * `models` array, and rejects the two extra keys outright. These cases are the runtime's shape read
 * out of `zcode.cjs`, where widening `models` is what makes models switchable without a respawn.
 */
describe('ProviderBlock', () => {
  const minimal = {
    providerId: 'deepseek',
    kind: 'anthropic' as const,
    models: [{ modelId: 'deepseek-v4-pro' }, { modelId: 'deepseek-v4-flash' }],
  };

  it('accepts the shape the runtime accepts', () => {
    expect(ProviderBlock.safeParse(minimal).success).toBe(true);
  });

  it('rejects the shape that was invented last time', () => {
    // This is what the action used to send, and the runtime answered:
    //   provider.providerId: expected string, received undefined; ... Unrecognized keys: "provider", "model"
    const r = ProviderBlock.safeParse({ provider: 'deepseek', model: 'deepseek-v4-pro', kind: 'anthropic' });
    expect(r.success).toBe(false);
  });

  it('requires at least one model — the point of the action is the list', () => {
    expect(ProviderBlock.safeParse({ ...minimal, models: [] }).success).toBe(false);
    expect(ProviderBlock.safeParse({ providerId: 'd', kind: 'anthropic' }).success).toBe(false);
  });

  it('requires a kind, because the runtime does', () => {
    expect(ProviderBlock.safeParse({ providerId: 'd', models: [{ modelId: 'm' }] }).success).toBe(false);
  });

  it('accepts optional model metadata without demanding it', () => {
    const rich = { ...minimal, models: [{ modelId: 'm', contextWindow: 1_000_000, supportsTools: true }] };
    expect(ProviderBlock.safeParse(rich).success).toBe(true);
  });
});
