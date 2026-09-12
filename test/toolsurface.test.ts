/**
 * The published tool surface — what a client actually receives from `tools/list`.
 *
 * This file exists because nothing checked it, and it was broken: 13 of 15 tools published an
 * `inputSchema` with no root `type`, because `zodToJsonSchema` renders a discriminated union as a
 * bare `anyOf`. ZCode's client refused the entire list with
 * `Invalid input: expected "object"` at `tools[n].inputSchema.type`, so the server registered zero
 * tools.
 *
 * The validator is the MCP SDK's own `ListToolsResultSchema` rather than a hand-written assertion:
 * it is the independent check that rejected us, and it is what a conforming client uses.
 */
import { describe, expect, it } from '@jest/globals';
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';

import { TOOL_REGISTRY, TOOL_NAMES, toolInputSchema } from '../src/schema/tools.js';

/** Exactly the payload the list handler returns. */
const listing = {
  tools: TOOL_REGISTRY.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: toolInputSchema(t.schema),
  })),
};

/** The `anyOf` branches of a published schema, if it has any. */
function branches(tool: { inputSchema: unknown } | undefined): unknown[] | undefined {
  const s = tool?.inputSchema as Record<string, unknown> | undefined;
  return Array.isArray(s?.anyOf) ? (s.anyOf as unknown[]) : undefined;
}

describe('tools/list', () => {
  it('the MCP SDK accepts the whole list', () => {
    const r = ListToolsResultSchema.safeParse(listing);
    // Report the offending paths rather than just false, so a failure names the tool at fault.
    const issues = r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')} — ${i.message}`);
    expect(issues).toEqual([]);
  });

  it('every tool publishes type:object at the root', () => {
    for (const t of listing.tools) {
      expect([t.name, t.inputSchema.type]).toEqual([t.name, 'object']);
    }
  });

  it('keeps the union intact rather than flattening it away', () => {
    // The fix adds a root type; it must not cost the per-action validation that Article III relies on.
    const chat = listing.tools.find((t) => t.name === 'zcode_chat');
    expect(branches(chat)?.length).toBeGreaterThan(1);
  });

  it('publishes exactly the tools that have a dispatcher', () => {
    // Membership is deliberate, and this list is the contract. `zcode_command` was advertised in
    // tools/list with no dispatcher anywhere, so every call to it returned `unknown tool` — an
    // advertised tool that cannot work is worse than an absent one, and it is withheld until it has
    // a dispatcher, a contract and tests. Adding a name here means wiring it in src/index.ts.
    expect(TOOL_NAMES).toEqual([
      'zcode_status',
      'zcode_session',
      'zcode_chat',
      'zcode_conversation',
      'zcode_files',
      'zcode_settings',
      'zcode_plugins',
      'zcode_mcp',
      'zcode_automation',
      'zcode_usage',
      'zcode_models',
      'zcode_approval',
      'zcode_headless',
      'zcode_protocol',
    ]);
  });

  it('every tool carries a distinct name and a real description', () => {
    expect(new Set(TOOL_NAMES).size).toBe(TOOL_NAMES.length);
    for (const t of listing.tools) {
      // A stub description would be a tool the calling model cannot use correctly (FR-045).
      expect((t.description ?? '').length).toBeGreaterThan(30);
    }
  });

  it('does not overwrite a root type that is already present', () => {
    // A plain object schema must come through with its own shape, not gain a union wrapper.
    const usage = listing.tools.find((t) => t.name === 'zcode_usage');
    expect(Object.keys(usage?.inputSchema ?? {})).toContain('properties');
    expect(branches(usage)).toBeUndefined();
  });
});
