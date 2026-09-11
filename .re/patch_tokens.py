"""Ground logtokens in the real field names, and wire fileChanges/fileRewindPreview to it.

CONFIRMED by probe:
  v4/conversation/rowsRange -> { rows, atSeq, atLogEpoch, hasMore }
  v4/conversation/fileChanges requires baseRevision (number) and baseLogEpoch (string),
  and rejects a wrong epoch with `proto.staleLogEpoch`.

So atSeq/atLogEpoch ARE the tokens. One rowsRange call yields both the row target and the tokens,
which means the diff tools need one read, not two.

python .re/patch_tokens.py
"""
import io, sys

def patch(path, pairs, required=True):
    s = io.open(path, encoding="utf-8").read()
    for old, new in pairs:
        if old not in s:
            if required:
                print(f"  !! NOT FOUND in {path}: {old[:80]!r}"); sys.exit(1)
            print(f"  -- absent, skipped in {path}"); continue
        s = s.replace(old, new, 1)
    io.open(path, "w", encoding="utf-8", newline="").write(s)
    print(f"  patched {path}")

# ── logtokens: the real token shape ─────────────────────────────────────────
patch("src/zcode/logtokens.ts", [
    ("""export interface LogTokens {
  logEpoch?: string;
  revision?: number;
}""",
     """/**
 * The conversation log tokens.
 *
 * CONFIRMED by probe against `v4/conversation/rowsRange`, which returns the current values under
 * the names `atLogEpoch` and `atSeq`. Those are what `fileChanges` and `fileRewindPreview` want as
 * `baseLogEpoch` and `baseRevision`, and passing a wrong epoch is rejected with
 * `proto.staleLogEpoch` — so the compare-and-swap IS enforced on those paths.
 *
 * Note `rowsRange` itself does NOT enforce it (it accepted a fabricated epoch and returned rows),
 * so tokens are optional there and required here.
 */
export interface LogTokens {
  logEpoch?: string;
  revision?: number;
}

/** Read the tokens out of a `rowsRange` response. Returns null when the response carries none. */
export function tokensFromRowWindow(res: unknown): LogTokens | null {
  if (!res || typeof res !== 'object') return null;
  const r = res as Record<string, unknown>;
  const logEpoch = typeof r.atLogEpoch === 'string' ? r.atLogEpoch : undefined;
  const seq = typeof r.atSeq === 'number' ? r.atSeq : undefined;
  if (logEpoch === undefined && seq === undefined) return null;
  return { ...(logEpoch !== undefined ? { logEpoch } : {}), ...(seq !== undefined ? { revision: seq } : {}) };
}

/** Fold tokens into the wire names fileChanges expects. */
export function tokenParams(t: LogTokens): Record<string, unknown> {
  return {
    ...(t.logEpoch !== undefined ? { baseLogEpoch: t.logEpoch } : {}),
    ...(t.revision !== undefined ? { baseRevision: t.revision } : {}),
  };
}"""),
])

# ── files: one rowsRange yields target AND tokens; retry re-reads both ───────
patch("src/zcode/actions/files.ts", [
    ("import { withStaleRetry, isStale } from '../logtokens.js';",
     "import { withStaleRetry, isStale, tokenParams, tokensFromRowWindow, type LogTokens } from '../logtokens.js';"),

    ("""async function resolveTarget(
  o: Outcome,
  runtime: RuntimeFor,
  sessionId: string,
  rowId: number,
  explicitEntityId?: string,
): Promise<{ rowId: number; entityId: string }> {
  if (explicitEntityId) return { rowId, entityId: explicitEntityId };
  const res = await read<{ rows?: Array<{ rowId?: number; entityId?: string }> }>(
    o,
    runtime,
    'v4/conversation/rowsRange',
    { sessionId, limit: 200 },
  );
  const hit = (res?.rows ?? []).find((r) => r.rowId === rowId);
  if (!hit?.entityId) {
    throw new Error(
      `no conversation row with rowId=${rowId} in this session (looked at ${(res?.rows ?? []).length} rows). ` +
        'Use zcode_conversation rows to list them.',
    );
  }
  return { rowId, entityId: hit.entityId };
}""",
     """async function rowWindow(
  o: Outcome,
  runtime: RuntimeFor,
  sessionId: string,
  rowId: number,
  explicitEntityId?: string,
): Promise<{ target: { rowId: number; entityId: string }; tokens: LogTokens }> {
  const res = await read<{ rows?: Array<{ rowId?: number; entityId?: string }>; atSeq?: number; atLogEpoch?: string }>(
    o,
    runtime,
    'v4/conversation/rowsRange',
    { sessionId, limit: 200 },
  );
  const tokens = tokensFromRowWindow(res) ?? {};

  if (explicitEntityId) return { target: { rowId, entityId: explicitEntityId }, tokens };

  const hit = (res?.rows ?? []).find((r) => r.rowId === rowId);
  if (!hit?.entityId) {
    throw new Error(
      `no conversation row with rowId=${rowId} in this session (looked at ${(res?.rows ?? []).length} rows). ` +
        'Use zcode_conversation rows to list them.',
    );
  }
  return { target: { rowId, entityId: hit.entityId }, tokens };
}"""),

    ("""        const rowId = Number(args.row_id);
        const target = await resolveTarget(
          o,
          runtime,
          sessionId,
          rowId,
          typeof args.entity_id === 'string' ? args.entity_id : undefined,
        );
        const { value, recoveredFromStale } = await withStaleRetry(
          o,
          runtime,
          'fileChanges',
          () => read(o, runtime, 'v4/conversation/fileChanges', { sessionId, target }),
          async () => null,
        );""",
     """        const rowId = Number(args.row_id);
        const explicit = typeof args.entity_id === 'string' ? args.entity_id : undefined;
        const first = await rowWindow(o, runtime, sessionId, rowId, explicit);
        const { value, recoveredFromStale } = await withStaleRetry(
          o,
          runtime,
          'fileChanges',
          (tokens) =>
            read(o, runtime, 'v4/conversation/fileChanges', {
              sessionId,
              target: first.target,
              ...tokenParams(Object.keys(tokens).length > 0 ? tokens : first.tokens),
            }),
          // On staleness, re-read the window: it yields fresh tokens AND the current target.
          async () => (await rowWindow(o, runtime, sessionId, rowId, explicit)).tokens,
        );"""),

    ("""        const rowId = Number(args.row_id);
        const target = await resolveTarget(
          o,
          runtime,
          sessionId,
          rowId,
          typeof args.entity_id === 'string' ? args.entity_id : undefined,
        );
        const value = await read(o, runtime, 'v4/conversation/fileRewindPreview', { sessionId, target });""",
     """        const rowId = Number(args.row_id);
        const w = await rowWindow(
          o,
          runtime,
          sessionId,
          rowId,
          typeof args.entity_id === 'string' ? args.entity_id : undefined,
        );
        const value = await read(o, runtime, 'v4/conversation/fileRewindPreview', {
          sessionId,
          target: w.target,
          ...tokenParams(w.tokens),
        });"""),
])

# ── conversation rows: report the REAL token names ─────────────────────────
patch("src/zcode/actions/conversation.ts", [
    ("import { withStaleRetry, isStale } from '../logtokens.js';",
     "import { withStaleRetry, isStale, tokensFromRowWindow } from '../logtokens.js';"),
    ("""        o.result({
          rows: value?.rows ?? [],
          count: (value?.rows ?? []).length,
          limit,
          log_epoch: value?.logEpoch ?? null,
          revision: value?.revision ?? null,
          recovered_from_stale: recoveredFromStale,
        });""",
     """        // The runtime's own names, verbatim. `atLogEpoch`/`atSeq` are what the diff tools need as
        // `baseLogEpoch`/`baseRevision`, so a caller can thread them through without guessing.
        o.result({
          rows: value?.rows ?? [],
          count: (value?.rows ?? []).length,
          limit,
          at_log_epoch: value?.atLogEpoch ?? null,
          at_seq: value?.atSeq ?? null,
          has_more: value?.hasMore ?? false,
          tokens: tokensFromRowWindow(value),
          recovered_from_stale: recoveredFromStale,
        });"""),
])
print("done")
