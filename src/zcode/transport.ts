/**
 * The stdio transport: one child ZCode agent runtime, spoken to in newline-delimited JSON.
 *
 * This is the project's critical path (tasks.md T015). Everything else is ordinary plumbing.
 *
 * Contract, all CONFIRMED against the real runtime:
 *   - spawn `node <zcode.cjs> app-server --stdio --cwd <workspace>`
 *   - `--stdio` is a declared no-op; framing is unconditional. It is passed anyway because it
 *     is correct in intent and harmless if a future build starts reading it.
 *   - the runtime redirects its own console to stderr, so **stderr is the log channel and must
 *     never be merged into stdout**
 *   - one JSON object per LF-terminated line, in both directions
 *   - envelope: {id,method,params} request | {id,result} | {id,error:{code,message,data}} |
 *     {method,params} notification | {id,method,params} server->client request (id "server-<n>")
 *   - there is no `jsonrpc` field
 *   - the runtime answers its first request ~1.1 s after launch
 *
 * Frames above ZCODE_FRAME_LIMIT_BYTES are refused *before* writing. The protocol can in fact
 * carry up to 16 MiB by fragmenting a logical frame (crc32, <=1024 fragments), but refusing is
 * the deliberate simplification: attachments are the sanctioned path for bulk data, and a
 * partial fragment implementation is a liability we do not need.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { wireLine } from './redact.js';

/** ZCode's `nn.maxFrameBytes`. */
export const ZCODE_FRAME_LIMIT_BYTES = 1024 * 1024;

export type Inbound =
  | { kind: 'result'; id: string | number; result: unknown }
  | { kind: 'error'; id: string | number; error: { code: number; message: string; data?: unknown } }
  | { kind: 'request'; id: string | number; method: string; params?: unknown; trace?: unknown }
  | { kind: 'notification'; method: string; params?: unknown; trace?: unknown }
  | { kind: 'invalid'; line: string; reason: string };

export interface CloseInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  reason?: string;
}

export interface TransportOptions {
  /** Absolute path to the runtime bundle. */
  cli: string;
  /** Node executable used to launch it. */
  node: string;
  /** Working directory for the child. Always an explicit workspace root. */
  cwd: string;
  /** Extra argv appended before our own flags. */
  extraArgs?: string[];
  /** Where to append the redacted wire log. Omit to disable file logging. */
  wireDir?: string;
  /** Directory for captured stderr. Omit to disable. */
  stderrDir?: string;
  /** Identifier used to name the wire and stderr files. */
  runId: string;
  /** Env for the child. The provider key is injected here, never written to a file. */
  env?: NodeJS.ProcessEnv;
  /** Bound on retained stderr lines. */
  stderrTailLimit?: number;
}

const DEFAULT_STDERR_TAIL = 50;

/** Classify one parsed line. Mirrors the runtime's own discrimination order. */
export function classify(parsed: unknown): Inbound | null {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const m = parsed as Record<string, unknown>;
  const hasId = 'id' in m && m.id !== undefined && m.id !== null;

  if (hasId && 'result' in m) return { kind: 'result', id: m.id as string | number, result: m.result };
  if (hasId && 'error' in m) {
    const e = m.error;
    if (e && typeof e === 'object') {
      const err = e as Record<string, unknown>;
      return {
        kind: 'error',
        id: m.id as string | number,
        error: {
          code: typeof err.code === 'number' ? err.code : -32603,
          message: typeof err.message === 'string' ? err.message : 'unknown error',
          ...(err.data !== undefined ? { data: err.data } : {}),
        },
      };
    }
    return { kind: 'error', id: m.id as string | number, error: { code: -32603, message: 'malformed error object' } };
  }
  if (hasId && typeof m.method === 'string') {
    return {
      kind: 'request',
      id: m.id as string | number,
      method: m.method,
      ...(m.params !== undefined ? { params: m.params } : {}),
      ...(m.trace !== undefined ? { trace: m.trace } : {}),
    };
  }
  if (!hasId && typeof m.method === 'string') {
    return {
      kind: 'notification',
      method: m.method,
      ...(m.params !== undefined ? { params: m.params } : {}),
      ...(m.trace !== undefined ? { trace: m.trace } : {}),
    };
  }
  return null;
}

/** Split an accumulating stdout buffer into complete lines, preserving the remainder. */
export function drainLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split('\n');
  const rest = parts.pop() ?? '';
  return { lines: parts.map((l) => l.replace(/\r$/, '')).filter((l) => l.trim().length > 0), rest };
}

export class ZCodeStdioTransport extends EventEmitter {
  readonly kind = 'stdio' as const;
  readonly pid: number | undefined;
  readonly startedAt = Date.now();

  private readonly child: ChildProcess;
  private readonly decoder = new StringDecoder('utf8');
  private stdoutBuf = '';
  private readonly stderrTail: string[] = [];
  private readonly wire: WriteStream | null;
  private readonly stderrSink: WriteStream | null;
  private disposed = false;
  private closed = false;
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private readonly sentIds = new Set<string>();

  constructor(private readonly opts: TransportOptions) {
    super();
    this.child = spawn(
      opts.node,
      [opts.cli, 'app-server', '--stdio', '--cwd', opts.cwd, ...(opts.extraArgs ?? [])],
      {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        // Own process group on POSIX so we can signal the whole tree. On Windows the tree is
        // killed with taskkill /T instead.
        detached: process.platform !== 'win32',
        windowsHide: true,
      },
    );
    this.pid = this.child.pid;

    this.wire = opts.wireDir ? createWriteStream(path.join(opts.wireDir, `${opts.runId}.ndjson`), { flags: 'a' }) : null;
    this.stderrSink = opts.stderrDir ? createWriteStream(path.join(opts.stderrDir, `${opts.runId}.log`), { flags: 'a' }) : null;
    if (opts.wireDir) mkdirSync(opts.wireDir, { recursive: true });
    if (opts.stderrDir) mkdirSync(opts.stderrDir, { recursive: true });

    this.child.stdout?.on('data', (chunk: Buffer) => this.onStdout(chunk));
    this.child.stderr?.on('data', (chunk: Buffer) => this.onStderr(chunk));
    this.child.stdin?.on('error', (err: Error) => {
      // EPIPE here means the child died; the exit handler reports it. Not fatal on its own.
      this.pushStderr(`stdin error: ${err.message}`);
    });
    this.child.once('error', (err: Error) => this.fireClose({ code: null, signal: null, reason: err.message }));
    this.child.once('exit', (code, signal) => {
      this.exitInfo = { code, signal };
      this.fireClose({ code, signal });
    });
  }

  get alive(): boolean {
    return !this.disposed && !this.closed && this.exitInfo === null;
  }

  /** Recent stderr lines, for diagnostics on a failure. */
  get stderrLines(): string[] {
    return [...this.stderrTail];
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBuf += this.decoder.write(chunk);
    const { lines, rest } = drainLines(this.stdoutBuf);
    this.stdoutBuf = rest;
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        this.emit('message', {
          kind: 'invalid',
          line: line.slice(0, 400),
          reason: err instanceof Error ? err.message : 'parse error',
        } satisfies Inbound);
        continue;
      }
      this.writeWire('in', parsed);
      const msg = classify(parsed);
      if (msg) this.emit('message', msg);
      else this.emit('message', { kind: 'invalid', line: line.slice(0, 400), reason: 'unrecognised envelope shape' } satisfies Inbound);
    }
  }

  private onStderr(chunk: Buffer): void {
    const text = this.decoder.write(chunk);
    this.stderrSink?.write(text);
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) this.pushStderr(line);
    }
  }

  private pushStderr(line: string): void {
    const limit = this.opts.stderrTailLimit ?? DEFAULT_STDERR_TAIL;
    this.stderrTail.push(line);
    while (this.stderrTail.length > limit) this.stderrTail.shift();
  }

  private writeWire(dir: 'in' | 'out', msg: unknown): void {
    this.wire?.write(`${wireLine(dir, msg)}\n`);
  }

  /**
   * Write one NDJSON frame. Enforces the frame limit before touching the pipe, so an oversized
   * payload costs nothing and cannot be half-written.
   */
  async send(message: unknown): Promise<void> {
    if (!this.alive) throw new Error('ZCode agent stdio transport is closed');

    const line = `${JSON.stringify(message)}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytes > ZCODE_FRAME_LIMIT_BYTES) {
      throw new Error(
        `payload exceeds the 1 MiB inline frame limit (${bytes} bytes); ` +
          'use the attachment path (zcode_files put_attachment) for bulk data',
      );
    }

    if (typeof message === 'object' && message !== null && 'id' in message) {
      this.sentIds.add(String((message as { id: unknown }).id));
    }
    this.writeWire('out', message);

    await new Promise<void>((resolve, reject) => {
      const stdin = this.child.stdin;
      if (!stdin || !stdin.writable) {
        reject(new Error('ZCode agent stdio transport is closed'));
        return;
      }
      stdin.write(line, (err) => (err ? reject(err) : resolve()));
    });
  }

  private fireClose(info: CloseInfo): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', info);
  }

  /** Stop reading and close log sinks. Does not kill the child. */
  private releaseLocal(): void {
    this.child.stdout?.removeAllListeners();
    this.child.stderr?.removeAllListeners();
    this.wire?.end();
    this.stderrSink?.end();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseLocal();
    if (this.exitInfo === null) this.killTree();
  }

  async disposeAndWait(graceMs = 3_000): Promise<void> {
    if (this.disposed && this.exitInfo !== null) return;
    this.disposed = true;
    if (this.exitInfo === null) {
      await this.killTreeAndWait(graceMs);
    }
    this.releaseLocal();
  }

  private killTree(): void {
    const pid = this.child.pid;
    if (pid === undefined) return;
    try {
      if (process.platform === 'win32') {
        // child.kill() does not reach grandchildren on Windows; /T walks the tree.
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } else {
        try {
          process.kill(-pid, 'SIGTERM'); // negative pid = the whole process group
        } catch {
          this.child.kill('SIGTERM');
        }
      }
    } catch {
      /* the process may already be gone */
    }
  }

  private hasExited(): boolean {
    return this.exitInfo !== null;
  }

  /**
   * Kill the process group and verify it is gone. Constitution Article VI: no orphan processes,
   * on every exit path.
   */
  async killTreeAndWait(graceMs = 3_000): Promise<void> {
    const pid = this.child.pid;
    if (pid === undefined) return;
    this.killTree();

    const deadline = Date.now() + graceMs;
    while (!this.hasExited() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (this.hasExited()) return;

    // Escalate.
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } else {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          this.child.kill('SIGKILL');
        }
      }
    } catch {
      /* already gone */
    }
    const hardDeadline = Date.now() + 2_000;
    while (!this.hasExited() && Date.now() < hardDeadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

/** Convenience factory, mirroring the shape of the options the registry passes. */
export function createTransport(opts: TransportOptions): ZCodeStdioTransport {
  return new ZCodeStdioTransport(opts);
}
