/**
 * Taking a backup that can actually be restored from.
 *
 * Every mutating file action in this server backs up first. A backup the caller cannot open is
 * worse than no backup, because the envelope reports a safety net that does not exist — so this
 * module's whole job is to make "there is a backup" a *verified* claim, not an intended one.
 *
 * Two hazards this exists to close, both of which shipped in an earlier revision:
 *
 *  - **A name ending in `.` or a space.** `new Date().toISOString()` with `[-:T]` stripped is
 *    `20260912151327.123Z`; slicing that to 15 characters makes the millisecond dot the *final*
 *    character. Such a name is legal at the NTFS level, so the copy succeeds and the file appears
 *    in a directory listing — but every Win32 path API strips the trailing dot, so `exists()`
 *    returns False and `open()` throws `ENOENT`/`WinError 2` forever. The file is on disk and
 *    unreachable, including by the `\\?\` per-component path that the read-back below would need.
 *    A stamp is therefore built from a full-seconds ISO string, never a slice of a longer one.
 *
 *  - **Same-second collisions.** At second resolution a second edit in the same second overwrites
 *    the first generation silently. The suffix loop keeps both.
 *
 * The read-back is deliberately the strong form: the backup must be byte-identical to the source,
 * not merely present and non-empty. A short or partial copy is the failure mode that matters, and
 * "the file exists" does not detect it.
 */
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { describe } from './errors.js';

/** `YYYYMMDD-HHMMSS`, matching ZCode's own `config.json.bak-20260910-210504` convention. */
export function backupStamp(now: Date = new Date()): string {
  return now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
}

/**
 * A path for the next backup generation of `p`.
 *
 * `label` distinguishes the writer, so a backup taken by `set_desktop` is not confused with one
 * taken when adding an MCP server.
 */
export function uniqueBackupPath(p: string, label?: string, stamp = backupStamp()): string {
  const infix = label ? `-${label}` : '';
  let candidate = `${p}.bak${infix}-${stamp}`;
  for (let n = 2; existsSync(candidate); n++) candidate = `${p}.bak${infix}-${stamp}-${n}`;
  return candidate;
}

export type BackupResult =
  /** `path` is null when the original did not exist, so there was nothing to preserve. */
  | { ok: true; path: string | null }
  | { ok: false; reason: string };

/**
 * Copy `p` aside and prove the copy is restorable.
 *
 * A caller that gets `ok: false` **must not write** — there is no backup.
 */
export function takeBackup(p: string, label?: string): BackupResult {
  if (!existsSync(p)) return { ok: true, path: null };

  const backup = uniqueBackupPath(p, label);
  try {
    copyFileSync(p, backup);
  } catch (err) {
    return { ok: false, reason: `backup at ${backup} could not be written (${describe(err)})` };
  }

  // Verify by reading BACK, which is also what catches an unaddressable name: a trailing dot or
  // space makes this throw, so the write is refused instead of proceeding unbacked.
  try {
    const restored = readFileSync(backup, 'utf8');
    const original = readFileSync(p, 'utf8');
    if (restored !== original) {
      return {
        ok: false,
        reason:
          `backup at ${backup} does not match ${p} on read-back ` +
          `(${restored.length} vs ${original.length} bytes)`,
      };
    }
  } catch (err) {
    return { ok: false, reason: `backup at ${backup} cannot be read back (${describe(err)})` };
  }

  return { ok: true, path: backup };
}
