/**
 * Audit-DB tests. Exercises the real SQLite file (in a temp dir) rather than a mock, because the
 * only thing worth testing here is that the DDL and the statements actually agree.
 */
import { afterEach, describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { AuditDb, openAuditDb } from '../src/storage/db.js';

let tmp: string | null = null;
function tempDb(): string {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-mcp-db-'));
  return path.join(tmp, 'audit.db');
}

afterEach(() => {
  // Windows keeps a brief lock on the WAL/SHM files after close, so retry rather than flake.
  if (tmp) {
    for (let i = 0; i < 5; i++) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
        break;
      } catch {
        /* still locked; try again */
      }
    }
  }
  tmp = null;
});

describe('AuditDb', () => {
  it('creates its schema and accepts a run row', () => {
    const db = new AuditDb(tempDb());
    db.recordRun({ runId: 'r1', tool: 'zcode_status', action: 'probe', ok: true, durationMs: 5 });
    expect(db.runCount()).toBe(1);
    db.close();
  });

  it('is idempotent across reopen — migrations run twice without error', () => {
    const p = tempDb();
    const a = new AuditDb(p);
    a.recordRun({ runId: 'r1', tool: 't', action: 'a', ok: true });
    a.close();
    const b = new AuditDb(p);
    expect(b.runCount()).toBe(1);
    b.recordRun({ runId: 'r2', tool: 't', action: 'a', ok: false });
    expect(b.runCount()).toBe(2);
    b.close();
  });

  it('upserts rather than duplicating on the same run id', () => {
    const db = new AuditDb(tempDb());
    db.recordRun({ runId: 'same', tool: 't', action: 'a', ok: true });
    db.recordRun({ runId: 'same', tool: 't', action: 'a', ok: false });
    expect(db.runCount()).toBe(1);
    db.close();
  });

  it('stores warnings as JSON and returns them on read', () => {
    const db = new AuditDb(tempDb());
    db.recordRun({
      runId: 'r1',
      tool: 't',
      action: 'a',
      ok: true,
      warnings: [{ code: 'restart_required', impact: 'advisory' }],
    });
    const rows = db.recentRuns(1) as Array<Record<string, unknown>>;
    expect(String(rows[0]!.warnings)).toContain('restart_required');
    db.close();
  });

  it('records artifacts keyed by run, kind and path, replacing on re-record', () => {
    const db = new AuditDb(tempDb());
    db.recordArtifact({ runId: 'r1', kind: 'wire', path: 'work/wire/x.ndjson', bytes: 100, sha256: 'abc' });
    db.recordArtifact({ runId: 'r1', kind: 'wire', path: 'work/wire/x.ndjson', bytes: 200, sha256: 'def' });
    db.recordArtifact({ runId: 'r1', kind: 'report', path: 'work/reports/r1.json', bytes: 10, sha256: 'ghi' });

    const rows = db.artifactsFor('r1') as Array<{ kind: string; bytes: number; sha256: string }>;
    // Same primary key replaced rather than duplicated; a different kind is a separate row.
    expect(rows).toHaveLength(2);
    const wire = rows.find((r) => r.kind === 'wire')!;
    expect(wire.bytes).toBe(200);
    expect(wire.sha256).toBe('def');
    db.close();
  });

  it('returns protocol calls for a run in sequence order', () => {
    const db = new AuditDb(tempDb());
    db.recordProtocolCall({ runId: 'r1', seq: 2, direction: 'in', method: 'session/list', requestId: '1', ok: true, ms: 13 });
    db.recordProtocolCall({ runId: 'r1', seq: 1, direction: 'out', method: 'session/list', requestId: '1', ok: true, ms: 12 });
    const rows = db.callsFor('r1') as Array<{ seq: number }>;
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
    db.close();
  });

  it('returns most recent runs first', () => {
    const db = new AuditDb(tempDb());
    db.recordRun({ runId: 'older', tool: 't', action: 'a', ok: true });
    db.recordRun({ runId: 'newer', tool: 't', action: 'a', ok: true });
    const rows = db.recentRuns(10) as Array<{ run_id: string }>;
    expect(rows[0]!.run_id).toBe('newer');
    db.close();
  });

  it('generates sortable, greppable run ids', () => {
    const id = AuditDb.newRunId('zcode_chat', 'send');
    expect(id).toMatch(/^\d{14}-zcode_chat-send-[a-z0-9]{6}$/);
    const a = AuditDb.newRunId('t', 'a');
    const b = AuditDb.newRunId('t', 'a');
    expect(a).not.toBe(b);
  });

  it('survives use after close without throwing', () => {
    const db = new AuditDb(tempDb());
    db.close();
    expect(() => db.recordRun({ runId: 'x', tool: 't', action: 'a', ok: true })).not.toThrow();
    expect(db.runCount()).toBe(0);
  });
});

describe('openAuditDb', () => {
  it('returns a handle for a writable path', () => {
    const db = openAuditDb(tempDb());
    expect(db).not.toBeNull();
    db!.close();
  });

  it('returns null rather than throwing when the path is unusable', () => {
    // A path whose parent is a file, not a directory.
    const p = tempDb();
    fs.writeFileSync(p, 'not a directory');
    const db = openAuditDb(path.join(p, 'nested', 'audit.db'));
    expect(db).toBeNull();
  });
});
