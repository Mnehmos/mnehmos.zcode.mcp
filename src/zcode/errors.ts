/**
 * Error formatting. A leaf module on purpose: `describe` is needed by every dispatcher, and the
 * obvious-looking home for it (`actions/status.ts`) pulls in `storage/db.ts` and therefore
 * `node:sqlite`. A file utility that only formats an error string should not require a SQLite build.
 */
export function describe(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
    const e = err as { code: number; message: string };
    return `${e.message} (${e.code})`;
  }
  return err instanceof Error ? err.message : String(err);
}
