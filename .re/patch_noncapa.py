"""Declare fileChanges/fileRewindPreview a non-capability, honestly.

Evidence: every derivable baseRevision is rejected with `proto.staleRevision` —
stateRevision (0), atSeq (10), atSeq-1, createdAtSeq, 0. baseLogEpoch from rowsRange IS accepted
(no staleLogEpoch), so the epoch is right and the REVISION is the unobtainable one. The
conversation-subscribe call that would establish a publisher rejects `subscriptionId` as an
unrecognized key, so its shape differs from the host-side form extracted from the bundle.

A retry loop that can never succeed is worse than a clear statement. Replace it.

python .re/patch_noncapa.py
"""
import io, sys

p = "src/zcode/actions/files.ts"
s = io.open(p, encoding="utf-8").read()

old_rows = """        const rowId = Number(args.row_id);
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
        );
        o.result({ changes: value, recovered_from_stale: recoveredFromStale });
        o.readOnly();
        break;"""

new_rows = """        const rowId = Number(args.row_id);
        const explicit = typeof args.entity_id === 'string' ? args.entity_id : undefined;
        const w = await rowWindow(o, runtime, sessionId, rowId, explicit);
        try {
          const value = await read(o, runtime, 'v4/conversation/fileChanges', {
            sessionId,
            target: w.target,
            ...tokenParams(w.tokens),
          });
          o.result({ changes: value, target: w.target });
          o.readOnly();
        } catch (err) {
          throw reviseIfUnobtainable(err);
        }
        break;"""

old_preview = """        const rowId = Number(args.row_id);
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
        });
        o.result({ preview: value });"""

new_preview = """        const rowId = Number(args.row_id);
        const w = await rowWindow(
          o,
          runtime,
          sessionId,
          rowId,
          typeof args.entity_id === 'string' ? args.entity_id : undefined,
        );
        let value: unknown;
        try {
          value = await read(o, runtime, 'v4/conversation/fileRewindPreview', {
            sessionId,
            target: w.target,
            ...tokenParams(w.tokens),
          });
        } catch (err) {
          throw reviseIfUnobtainable(err);
        }
        o.result({ preview: value });"""

for old, new in [(old_rows, new_rows), (old_preview, new_preview)]:
    if old not in s:
        print(f"  !! NOT FOUND: {old[:70]!r}"); sys.exit(1)
    s = s.replace(old, new, 1)

# the discriminating helper, and a marker error the catch block recognises
helper = '''
/**
 * Distinguish "the token is unobtainable" from "the token was stale".
 *
 * CONFIRMED by probe: `baseLogEpoch` from `rowsRange.atLogEpoch` IS accepted, but NO derivable
 * `baseRevision` is — `stateRevision` (0), `atSeq` (10), `atSeq-1`, `createdAtSeq` and `0` were all
 * rejected with `proto.staleRevision`. The revision the runtime compares against is not exposed to
 * a bare app-server's client, and the `v4/conversation/subscribe` call that would establish a
 * publisher rejects `subscriptionId` as an unrecognized key, so its shape differs from the
 * host-side form extracted from the bundle.
 *
 * Retrying cannot fix that, and a retry loop that always fails is worse than a clear statement. So
 * this rethrows with a marker the dispatcher turns into a declared non-capability.
 */
export class TokenUnobtainableError extends Error {
  readonly original: unknown;
  constructor(original: unknown) {
    super(
      'the runtime rejected baseRevision and no revision obtainable from a bare app-server is ' +
        'accepted, so this read cannot be authorised from here',
    );
    this.name = 'TokenUnobtainableError';
    this.original = original;
  }
}

function reviseIfUnobtainable(err: unknown): unknown {
  const msg = err instanceof Error ? err.message : String(err);
  if (/staleRevision|staleLogEpoch/.test(msg)) return new TokenUnobtainableError(err);
  return err;
}
'''
s = s.replace("export async function filesDispatch(", helper + "\nexport async function filesDispatch(")

# report it as a non-capability rather than a failure
s = s.replace("""    if (isMethodNotFound(err)) {
      o.warn(
        'method_not_supported',
        `${action} is not implemented on a bare app-server (this build answers -32601).`,
        'unreliable',
      );
    } else if (isStale(err)) {
      o.warn('stale_after_retry', 'still stale after a retry', 'degraded');
    }
    o.fail(describe(err));""",
"""    if (err instanceof TokenUnobtainableError) {
      o.warn(
        'token_unobtainable',
        'the runtime requires a baseRevision that a bare app-server does not expose to its client. ' +
          'baseLogEpoch is accepted from rowsRange, but every derivable revision is rejected with ' +
          'proto.staleRevision. File-change and rewind-preview reads therefore do not work in the ' +
          'owned-runtime configuration; they appear to need a host-established conversation ' +
          'publisher. See .re/findings_ADDENDUM.md A23. Actions that do work: read_attachment, ' +
          'put_attachment, rewind_apply (as a fork).',
        'unreliable',
      );
      o.fail(describe(err.original));
    } else if (isMethodNotFound(err)) {
      o.warn(
        'method_not_supported',
        `${action} is not implemented on a bare app-server (this build answers -32601).`,
        'unreliable',
      );
      o.fail(describe(err));
    } else {
      o.fail(describe(err));
    }""")
io.open(p, "w", encoding="utf-8", newline="").write(s)
print("  patched src/zcode/actions/files.ts")

# withStaleRetry is now unused in files.ts
if "withStaleRetry" not in s.split("import")[1].split("\n")[0] and "withStaleRetry(" not in s:
    s = s.replace("import { withStaleRetry, isStale, tokenParams, tokensFromRowWindow, type LogTokens } from '../logtokens.js';",
                  "import { isStale, tokenParams, tokensFromRowWindow, type LogTokens } from '../logtokens.js';")
    io.open(p, "w", encoding="utf-8", newline="").write(s)
    print("  dropped the unused withStaleRetry import")
print("done")
