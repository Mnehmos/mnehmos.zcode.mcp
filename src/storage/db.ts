/**
 * Provenance: one row per call, one row per artifact, one row per protocol exchange.
 *
 * Uses `node:sqlite` (DatabaseSync) rather than a native module — it is the same API the ZCode
 * runtime itself uses, and it removes the only native build dependency on Windows.
 *
 * Constitution Article VII: the repo is the memory. Because ZCode also logs every turn as structured
 * JSONL with sessionId/turnId/traceId, our rows join to its logs, so an end-to-end trace spans both
 * processes without either one knowing about the other.
 */
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DDL = `
CREATE TABLE IF NOT EXISTS runs (
  run_id         TEXT PRIMARY KEY,
  ts             INTEGER NOT NULL,
  tool           TEXT NOT NULL,
  action         TEXT NOT NULL,
  workspace_key  TEXT,
  session_id     TEXT,
  ok             INTEGER NOT NULL,
  payload_source TEXT,
  exit_code      INTEGER,
  duration_ms    INTEGER,
  timed_out      INTEGER,
  runtime_version TEXT,
  protocol_version INTEGER,
  command        TEXT,
  warnings       TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_ws_ts   ON runs(workspace_key, ts);
CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id, ts);

CREATE TABLE IF NOT EXISTS artifacts (
  run_id  TEXT NOT NULL,
  kind    TEXT NOT NULL,
  path    TEXT NOT NULL,
  bytes   INTEGER,
  sha256  TEXT,
  PRIMARY KEY (run_id, kind, path)
);

CREATE TABLE IF NOT EXISTS protocol_calls (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  direction  TEXT NOT NULL,
  method     TEXT,
  request_id TEXT,
  ok         INTEGER,
  error_code INTEGER,
  ms         INTEGER,
  bytes      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_calls_run ON protocol_calls(run_id, seq);
`;

export interface RunRow {
  runId: string;
  tool: string;
  action: string;
  workspaceKey?: string | null;
  sessionId?: string | null;
  ok: boolean;
  payloadSource?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
  timedOut?: boolean;
  runtimeVersion?: string | null;
  protocolVersion?: number | null;
  command?: string | null;
  warnings?: unknown;
}

export interface ArtifactRow {
  runId: string;
  kind: 'wire' | 'stdout' | 'stderr' | 'settings' | 'attachment' | 'report';
  path: string;
  bytes?: number | null;
  sha256?: string | null;
}

export interface ProtocolCallRow {
  runId: string;
  seq: number;
  direction: 'out' | 'in' | 'notification' | 'request';
  method?: string | null;
  requestId?: string | null;
  ok?: boolean | null;
  errorCode?: number | null;
  ms?: number | null;
  bytes?: number | null;
}

export class AuditDb {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    // WAL keeps a reader (us) from blocking ZCode's own writers on the same directory, and
    // survives an abrupt kill without a repair step.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(DDL);
  }

  /** New run id. Time-prefixed so rows sort sensibly and a log line is greppable. */
  static newRunId(tool: string, action: string): string {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const rand = Math.random().toString(36).slice(2, 8);
    return `${stamp}-${tool}-${action}-${rand}`;
  }

  recordRun(r: RunRow): void {
    if (this.closed) return;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO runs
         (run_id, ts, tool, action, workspace_key, session_id, ok, payload_source, exit_code,
          duration_ms, timed_out, runtime_version, protocol_version, command, warnings)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        r.runId,
        Date.now(),
        r.tool,
        r.action,
        r.workspaceKey ?? null,
        r.sessionId ?? null,
        r.ok ? 1 : 0,
        r.payloadSource ?? null,
        r.exitCode ?? null,
        r.durationMs ?? null,
        r.timedOut ? 1 : 0,
        r.runtimeVersion ?? null,
        r.protocolVersion ?? null,
        r.command ?? null,
        r.warnings === undefined ? null : JSON.stringify(r.warnings),
      );
  }

  recordArtifact(a: ArtifactRow): void {
    if (this.closed) return;
    this.db
      .prepare('INSERT OR REPLACE INTO artifacts (run_id, kind, path, bytes, sha256) VALUES (?,?,?,?,?)')
      .run(a.runId, a.kind, a.path, a.bytes ?? null, a.sha256 ?? null);
  }

  recordProtocolCall(c: ProtocolCallRow): void {
    if (this.closed) return;
    this.db
      .prepare(
        `INSERT INTO protocol_calls
         (run_id, seq, direction, method, request_id, ok, error_code, ms, bytes)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        c.runId,
        c.seq,
        c.direction,
        c.method ?? null,
        c.requestId ?? null,
        c.ok === undefined || c.ok === null ? null : c.ok ? 1 : 0,
        c.errorCode ?? null,
        c.ms ?? null,
        c.bytes ?? null,
      );
  }

  recentRuns(limit = 50): unknown[] {
    if (this.closed) return [];
    // Order by ts, then rowid: two calls in the same millisecond must still come back in the order
    // they happened, or "most recent" is a coin flip.
    return this.db
      .prepare(
        `SELECT run_id, ts, tool, action, workspace_key, session_id, ok, payload_source,
                exit_code, duration_ms, timed_out, runtime_version, protocol_version,
                command, warnings
         FROM runs ORDER BY ts DESC, rowid DESC LIMIT ?`,
      )
      .all(limit);
  }

  /** Artifacts recorded for a run — the evidence trail behind one call. */
  artifactsFor(runId: string): unknown[] {
    if (this.closed) return [];
    return this.db
      .prepare('SELECT kind, path, bytes, sha256 FROM artifacts WHERE run_id = ? ORDER BY kind, path')
      .all(runId);
  }

  /** Protocol exchanges for a run, in order. */
  callsFor(runId: string): unknown[] {
    if (this.closed) return [];
    return this.db
      .prepare(
        `SELECT seq, direction, method, request_id, ok, error_code, ms, bytes
         FROM protocol_calls WHERE run_id = ? ORDER BY seq`,
      )
      .all(runId);
  }

  runCount(): number {
    if (this.closed) return 0;
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n?: number } | undefined;
    return row?.n ?? 0;
  }

  close(): void {
    if (this.closed) return;
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
    this.closed = true;
  }
}

/**
 * Open the audit DB, or return null if it cannot be opened.
 *
 * An unwritable audit trail must not stop the server from working — but it must not be silent
 * either, so the caller is expected to warn when this returns null.
 */
export function openAuditDb(dbPath: string): AuditDb | null {
  try {
    return new AuditDb(dbPath);
  } catch {
    return null;
  }
}
