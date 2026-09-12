/**
 * Backup-helper unit tests. Real files in a temp dir, no process spawned and no module mocked —
 * matching the rest of the suite, which prefers real filesystem behaviour to stubs.
 *
 * The `backupStamp` cases are the regression that matters. An earlier revision named the backup
 * with `iso.replace(/[-:T]/g,'').slice(0, 15)`, which leaves the millisecond dot as the last
 * character: `config.json.bak-20260912151327.`. Windows *creates* such a file — NTFS allows a
 * trailing dot — and then cannot address it, because every Win32 path API strips it. So the
 * envelope reported a backup that no restore could ever open, and that file had to be deleted
 * through a `\\?\` path by hand.
 */
import { describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { backupStamp, takeBackup, uniqueBackupPath } from '../src/zcode/backup.js';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'zcode-backup-'));
}

describe('backupStamp', () => {
  it('never ends in a dot, whatever the milliseconds are', () => {
    // Each of these would end the name with '.' under the old slice(0, 15) — including '000Z',
    // which is why the bug was intermittent rather than obviously broken.
    for (const ms of ['000Z', '001Z', '123Z', '500Z', '999Z']) {
      const stamp = backupStamp(new Date(`2026-09-12T15:13:27.${ms}`));
      expect(stamp).toBe('20260912-151327');
      expect(stamp.endsWith('.')).toBe(false);
      expect(stamp.endsWith(' ')).toBe(false);
    }
  });

  it('keeps the shape ZCode itself uses', () => {
    expect(backupStamp(new Date('2026-09-10T21:05:04.999Z'))).toMatch(/^\d{8}-\d{6}$/);
  });
});

describe('uniqueBackupPath', () => {
  it('produces a name that can be listed and read back', () => {
    const dir = scratch();
    try {
      const p = uniqueBackupPath(join(dir, 'config.json'));
      writeFileSync(p, 'x', 'utf8');
      expect(readdirSync(dir)).toContain(p.slice(dir.length + 1));
      expect(readFileSync(p, 'utf8')).toBe('x');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('suffixes rather than overwriting a generation taken in the same second', () => {
    const dir = scratch();
    try {
      const target = join(dir, 'config.json');
      const stamp = backupStamp();
      const first = uniqueBackupPath(target, undefined, stamp);
      writeFileSync(first, '1', 'utf8');
      const second = uniqueBackupPath(target, undefined, stamp);
      expect(second).not.toBe(first);
      expect(second.endsWith('-2')).toBe(true);
      writeFileSync(second, '2', 'utf8');
      expect(uniqueBackupPath(target, undefined, stamp).endsWith('-3')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the two writers distinguishable', () => {
    const target = join(scratch(), 'config.json');
    expect(uniqueBackupPath(target, 'mcp')).toContain('.bak-mcp-');
    expect(uniqueBackupPath(target)).toContain('.bak-');
  });
});

describe('takeBackup', () => {
  it('reports a null path when there is nothing to preserve', () => {
    const dir = scratch();
    try {
      expect(takeBackup(join(dir, 'absent.json'))).toEqual({ ok: true, path: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns a copy that reads back byte-identical', () => {
    const dir = scratch();
    try {
      const target = join(dir, 'config.json');
      const body = JSON.stringify({ mcp: { servers: { a: { command: 'node' } } } }, null, 2);
      writeFileSync(target, body, 'utf8');

      const r = takeBackup(target);
      if (!r.ok || r.path === null) throw new Error(`expected a backup, got ${JSON.stringify(r)}`);
      expect(readdirSync(dir)).toContain(r.path.slice(dir.length + 1));
      // Reading through the ordinary API is the real assertion: an unaddressable name throws
      // ENOENT here even though the copy call itself reported success.
      expect(readFileSync(r.path, 'utf8')).toBe(body);
      expect(readFileSync(target, 'utf8')).toBe(body);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses, rather than reporting a backup, when the copy cannot be made', () => {
    const dir = scratch();
    try {
      // A directory as the source: `copyFileSync` raises EPERM while `existsSync` is true, which
      // is the shape of every "the copy did not happen" fault. A caller getting this must not
      // write — the byte-comparison branch below it is unreachable without a partial-copy fault,
      // which is exactly why the check is there rather than a "was it created" check.
      const asDir = join(dir, 'config.json');
      mkdirSync(asDir);
      const r = takeBackup(asDir);
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('unreachable');
      expect(r.reason).toContain('could not be written');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves the original untouched', () => {
    const dir = scratch();
    try {
      const target = join(dir, 'config.json');
      writeFileSync(target, '{"a":1}', 'utf8');
      takeBackup(target);
      expect(readFileSync(target, 'utf8')).toBe('{"a":1}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
