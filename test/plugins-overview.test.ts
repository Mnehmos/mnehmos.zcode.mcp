/**
 * Bounding the tool result for `zcode_plugins overview`.
 *
 * A real call returned 227 KB — both marketplaces in full, every plugin with i18n descriptions and
 * icons. That does not inform the caller, it evicts their context. These cases pin the behaviour:
 * small payloads pass through untouched, large ones are summarised, and the summariser never claims
 * to have withheld nothing.
 */
import { describe, expect, it } from '@jest/globals';

import { summarisePluginOverview } from '../src/zcode/actions/readsurface.js';

const plugin = (i: number, installed = false) => ({
  id: `plugin-${i}@market`,
  name: `plugin-${i}`,
  marketplace: 'market',
  installed,
  componentTypes: ['skill'],
  description: 'x'.repeat(400),
  listing: { descriptionI18n: { en: 'y'.repeat(400), 'zh-CN': 'z'.repeat(400) }, icon: 'https://…' },
});

const big = { marketplaces: [{ id: 'market', name: 'market', pluginCount: 50 }], availablePlugins: Array.from({ length: 50 }, (_, i) => plugin(i, i === 3)) };

describe('summarisePluginOverview', () => {
  it('passes a small payload through untouched', () => {
    const small = { marketplaces: [{ id: 'm' }], availablePlugins: [plugin(1)] };
    const { value, omitted } = summarisePluginOverview(small);
    expect(value).toBe(small); // identity, not a copy — nothing to summarise
    expect(omitted).toBeNull();
  });

  it('summarises a large payload and says what it withheld', () => {
    const { value, omitted } = summarisePluginOverview(big);
    expect(omitted).not.toBeNull();
    expect(omitted?.plugins).toBe(50);
    // The warning detail needs both numbers, so they must be real measurements.
    expect(omitted?.bytes).toBeGreaterThan(60_000);
    expect(value.catalogue_omitted).toBe(true);
    expect(value.catalogue_plugins).toBe(50);
  });

  it('shrinks the result enough to be worth doing', () => {
    const { value } = summarisePluginOverview(big);
    const before = JSON.stringify(big).length;
    const after = JSON.stringify(value).length;
    expect(after).toBeLessThan(before / 10);
  });

  it('keeps the installed plugins, which are the ones a caller cares about', () => {
    const { value } = summarisePluginOverview(big);
    const installed = value.installed_plugins as Array<Record<string, unknown>>;
    expect(installed.map((p) => p.name)).toEqual(['plugin-3']);
    expect(installed[0]?.installed).toBe(true);
    expect(value.installed_count).toBe(1);
  });

  it('keeps the marketplace size, so the shape is still visible', () => {
    const { value } = summarisePluginOverview(big);
    expect(value.marketplaces).toEqual([{ id: 'market', name: 'market', pluginCount: 50, lastUpdated: undefined, isOfficial: undefined }]);
  });

  it('handles a malformed payload without throwing', () => {
    expect(() => summarisePluginOverview({})).not.toThrow();
    expect(summarisePluginOverview({}).omitted).toBeNull();
    const weird = { marketplaces: 'not an array', availablePlugins: { nope: true } };
    expect(() => summarisePluginOverview(weird)).not.toThrow();
  });
});
