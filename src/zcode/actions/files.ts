/**
 * `zcode_files` — what a turn changed, rewind preview, and attachments.
 *
 * The declared non-capability is the important part of this tool. ZCode has **no editor document
 * service**: there is no protocol method to read or write a file as the editor sees it, no "active
 * editor", no selection. What exists is the conversation's record of file changes, addressed by row.
 *
 * That is why file mutation routes through the agent's own `Write`/`Edit` tools instead: only that
 * path produces `checkpoint.created`, records a file change against the row, and participates in
 * `rewind.triggered`. A direct filesystem write from here would produce no checkpoint, be invisible
 * to rewind, and be unreviewable.
 *
 * `rewind_apply` is the one destructive action in the whole server. It requires `confirm: true`.
 */
import type { ServerContext } from '../../context.js';
import type { Envelope, Outcome } from '../../envelope.js';
import { acquireOrFail, describe, finish, newRunId, outcome, read, resolveWorkspace, workspaceRequired, write } from './_shared.js';
import type { Runtime } from '../registry.js';
import { isStale, tokenParams, tokensFromRowWindow, type LogTokens } from '../logtokens.js';

type RuntimeFor = Runtime;
import { isMethodNotFound } from '../protocol.js';

/** The attachment ceilings, from the audited limits object. */
const ATTACH_MAX_BYTES = 20 * 1024 * 1024;
const ATTACH_CHUNK_BYTES = 512 * 1024;
const ATTACH_MAX_CHUNKS = 64;
const ATTACH_READ_MAX = 31_457_280;


/**
 * Resolve a conversation row target.
 *
 * CONFIRMED by probe: `v4/conversation/fileChanges` requires `target: {rowId: number, entityId:
 * string}`. A caller holding a row id from `rowsRange` should not have to dig out `entityId` as
 * well, so it is looked up here when not supplied. One extra read, on a path that is already
 * read-only, beats making the internal row shape part of the tool's contract.
 */
async function rowWindow(
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
}


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

export async function filesDispatch(ctx: ServerContext, args: Record<string, unknown>): Promise<Envelope> {
  const action = String(args.action);
  const runId = newRunId('zcode_files', action);
  const o = outcome('zcode_files', action, action === 'rewind_apply' || action === 'put_attachment');

  const sessionId = typeof args.session_id === 'string' ? args.session_id : '';
  if (action !== 'read_attachment' && action !== 'put_attachment' && !sessionId) {
    o.fail('session_id is required');
    return finish(ctx, o, runId);
  }
  const workspace = resolveWorkspace(ctx, args);
  if (!workspace) return workspaceRequired('zcode_files', action);

  const acq = await acquireOrFail(ctx, o, workspace, runId);
  if (!acq) return finish(ctx, o, runId);
  const { runtime } = acq;

  try {
    switch (action) {
      case 'changes': {
        const rowId = Number(args.row_id);
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
        break;
      }

      case 'rewind_preview': {
        const rowId = Number(args.row_id);
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
        o.result({ preview: value });
        o.warn(
          'preview_only',
          'this is a dry run: nothing on disk has changed. Applying it requires rewind_apply with confirm:true.',
          'advisory',
        );
        o.readOnly();
        break;
      }

      case 'rewind_apply': {
        if (args.confirm !== true) {
          o.fail('rewind_apply requires confirm:true — it restores files on disk, overwriting current content');
          break;
        }
        // The safe form is a fork: it keeps the current state reachable. A bare rewind discards it.
        const params: Record<string, unknown> = { sessionId };
        if (typeof args.checkpoint_id === 'string') params.checkpointId = args.checkpoint_id;
        const value = await write(o, runtime, 'session/fork', params);
        const forked = (value as { sessionId?: unknown } | undefined)?.sessionId;
        o.result({ forked_to: typeof forked === 'string' ? forked : null, result: value });
        o.readBack(typeof forked === 'string', forked ? undefined : 'fork returned no sessionId; the rewind may not have happened');
        o.warn(
          'rewind_via_fork',
          'applied as a fork rather than an in-place rewind, so the pre-rewind state remains reachable',
          'advisory',
        );
        break;
      }

      case 'read_attachment': {
        const maxBytes = typeof args.max_bytes === 'number' ? Math.min(args.max_bytes, ATTACH_READ_MAX) : ATTACH_READ_MAX;
        const params: Record<string, unknown> = { sessionId, ref: String(args.ref), maxBytes };
        if (typeof args.mime === 'string') params.mime = args.mime;
        if (typeof args.message_id === 'string') params.messageId = args.message_id;
        if (typeof args.attachment_index === 'number') params.attachmentIndex = args.attachment_index;
        const value = await read(o, runtime, 'v4/attachment/read', params);
        // An attachment can be a screenshot or a document; report its size rather than its content
        // in the diagnostics, because the content may be megabytes.
        const bytes =
          value && typeof value === 'object' && 'bytes' in value && (value as { bytes?: unknown }).bytes instanceof Uint8Array
            ? (value as { bytes: Uint8Array }).bytes.byteLength
            : null;
        o.result({ attachment: value, byte_length: bytes });
        o.readOnly();
        break;
      }

      case 'put_attachment': {
        const { readFileSync, statSync } = await import('node:fs');
        const p = String(args.path);
        let size: number;
        try {
          size = statSync(p).size;
        } catch (err) {
          o.fail(`cannot read ${p}: ${describe(err)}`);
          break;
        }
        if (size > ATTACH_MAX_BYTES) {
          o.fail(
            `${p} is ${size} bytes, over the ${ATTACH_MAX_BYTES}-byte attachment limit. ` +
              'ZCode will not accept it; there is no larger path.',
          );
          break;
        }
        const chunks = Math.ceil(size / ATTACH_CHUNK_BYTES);
        if (chunks > ATTACH_MAX_CHUNKS) {
          o.fail(`${p} needs ${chunks} chunks, over the ${ATTACH_MAX_CHUNKS}-chunk limit`);
          break;
        }

        const begin = await write(o, runtime, 'v4/attachment/begin', { sessionId, bytes: size });
        const uploadId =
          begin && typeof begin === 'object'
            ? ((begin as { uploadId?: unknown }).uploadId ?? (begin as { id?: unknown }).id ?? null)
            : null;
        if (typeof uploadId !== 'string') {
          o.fail(`v4/attachment/begin returned no upload id; response was ${JSON.stringify(begin).slice(0, 300)}`);
          break;
        }

        const buf = readFileSync(p);
        for (let i = 0; i < chunks; i++) {
          const slice = buf.subarray(i * ATTACH_CHUNK_BYTES, Math.min((i + 1) * ATTACH_CHUNK_BYTES, size));
          await write(o, runtime, 'v4/attachment/chunk', {
            sessionId,
            uploadId,
            index: i,
            // base64 because the frame is JSON: a raw buffer would not survive the encoding, and
            // 512 KiB of base64 is ~683 KiB, still under the 1 MiB frame limit.
            dataBase64: slice.toString('base64'),
          });
        }
        const committed = await write(o, runtime, 'v4/attachment/commit', { sessionId, uploadId });
        const ref =
          committed && typeof committed === 'object'
            ? ((committed as { ref?: unknown }).ref ?? null)
            : null;
        o.result({ ref, upload_id: uploadId, bytes: size, chunks });
        // Read back: a committed attachment must be retrievable by its ref.
        if (typeof ref === 'string') {
          try {
            const back = await read(o, runtime, 'v4/attachment/read', { sessionId, ref, maxBytes: Math.min(size, ATTACH_READ_MAX) });
            o.readBack(Boolean(back), back ? undefined : 'committed ref could not be read back');
          } catch (err) {
            o.readBack(false, `committed ref could not be read back: ${describe(err)}`);
          }
        } else {
          o.readBackUnavailable('commit returned no ref, so the attachment cannot be confirmed');
        }
        break;
      }

      default:
        o.fail(`unknown action: ${action}`);
    }
  } catch (err) {
    if (err instanceof TokenUnobtainableError) {
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
    }
  }
  return finish(ctx, o, runId);
}
