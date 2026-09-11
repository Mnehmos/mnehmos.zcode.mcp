/**
 * The protocol client: request/response correlation over a transport.
 *
 * Mirrors the shape and behaviour of ZCode's own ZCodeProtocolClient, because the failure modes
 * we must handle are the ones it handles:
 *   - a monotonically increasing string id per request
 *   - a per-request timeout (ZCode's own default is 180 s, also our default)
 *   - abort support, so a cancelled call is never left pending
 *   - server->client requests surfaced separately from notifications, because they MUST be
 *     answered or the turn deadlocks
 *   - close rejects everything pending, so nothing hangs forever on a dead child
 */
import { EventEmitter } from 'node:events';

import type { Inbound, ZCodeStdioTransport } from './transport.js';

/** Mirrors the runtime's `ZCodeProtocolClientError`. */
export class ZCodeProtocolError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'ZCodeProtocolError';
  }
}

export class ZCodeProtocolTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly requestId: number,
    readonly timeoutMs: number,
  ) {
    super(`ZCode Protocol request timed out: ${method}`);
    this.name = 'ZCodeProtocolTimeoutError';
  }
}

export class ZCodeTransportClosedError extends Error {
  constructor(reason?: string) {
    super(`ZCode agent stdio transport is closed${reason ? `: ${reason}` : ''}`);
    this.name = 'ZCodeTransportClosedError';
  }
}

/** Error codes the runtime uses. Kept explicit so callers can branch without magic numbers. */
export const ERROR_CODES = {
  ParseError: -32700,
  InvalidMessage: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  Internal: -32603,
  SessionUnavailable: -32004,
  PromptAlreadyRunning: -32010,
  NoClient: -32020,
  ClientCancelled: -32021,
  ClientTimedOut: -32022,
  RestoreWarning: -32031,
} as const;

/** Documented handler errors, so a caller can distinguish "retry" from "stop". */
export const REASON_CODES = {
  CommandNotImplemented: 'fault.command.notImplemented',
  CommandExecutionFailed: 'fault.command.executionFailed',
  PayloadTooLarge: 'proto.payloadTooLarge',
  SubscriptionNotOwned: 'fault.subscription.notOwned',
  FileChangesUnsupported: 'fault.fileChanges.unsupported',
  FileRewindUnsupported: 'fault.fileRewindPreview.unsupported',
  AttachmentPutUnsupported: 'fault.attachment.putUnsupported',
  AttachmentPreviewNotMedia: 'fault.attachment.previewNotMedia',
  AttachmentPreviewTooLarge: 'fault.attachment.previewTooLarge',
  StaleLogEpoch: 'proto.staleLogEpoch',
  StaleRevision: 'proto.staleRevision',
} as const;

export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface Pending {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  cleanup: () => void;
}

export interface ProtocolEvents {
  notification: (method: string, params: unknown) => void;
  request: (id: string | number, method: string, params: unknown) => void;
  close: (reason?: string) => void;
}

export class ZCodeProtocolClient {
  private readonly pending = new Map<string, Pending>();
  private nextId = 1;
  private disposed = false;
  private closed = false;
  private readonly emitter = new EventEmitter();

  constructor(
    private readonly transport: ZCodeStdioTransport,
    private readonly defaultTimeoutMs = 180_000,
  ) {
    transport.on('message', (m: Inbound) => this.handle(m));
    transport.on('close', (info: { code: number | null; signal: NodeJS.Signals | null; reason?: string }) => {
      const why = info.reason ?? (info.code !== null ? `exit ${info.code}` : info.signal ? `signal ${info.signal}` : undefined);
      this.closed = true;
      this.rejectAll(new ZCodeTransportClosedError(why));
      this.emitter.emit('close', why);
    });
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  on<K extends keyof ProtocolEvents>(event: K, listener: ProtocolEvents[K]): this {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  off<K extends keyof ProtocolEvents>(event: K, listener: ProtocolEvents[K]): this {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
    return this;
  }

  private handle(m: Inbound): void {
    if (m.kind === 'result') {
      this.settle(String(m.id), null, m.result);
      return;
    }
    if (m.kind === 'error') {
      const err = new ZCodeProtocolError(m.error.message, m.error.code, m.error.data);
      this.settle(String(m.id), err);
      return;
    }
    if (m.kind === 'request') {
      // Answering is the caller's job (the policy module). We only route.
      this.emitter.emit('request', m.id, m.method, m.params);
      return;
    }
    if (m.kind === 'notification') {
      this.emitter.emit('notification', m.method, m.params);
      return;
    }
    // An unparseable line is not fatal: the runtime may emit a partial frame that the transport
    // already reassembled, or a log line that leaked to stdout. Report it, do not throw.
    this.emitter.emit('invalid', m.line, m.reason);
  }

  private settle(key: string, err: Error | null, value?: unknown): void {
    const p = this.pending.get(key);
    if (!p) return; // a reply to something we already timed out on
    clearTimeout(p.timer);
    p.cleanup();
    this.pending.delete(key);
    if (err) p.reject(err);
    else p.resolve(value);
  }

  private rejectAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.cleanup();
      p.reject(err);
    }
    this.pending.clear();
  }

  /** Send a request and await its result. Rejects — never resolves — on error or timeout. */
  async request<T = unknown>(method: string, params?: unknown, opts: RequestOptions = {}): Promise<T> {
    if (this.disposed) throw new Error('ZCode Protocol client is disposed');
    if (this.closed) throw new ZCodeTransportClosedError();

    const id = this.nextId++;
    const key = String(id);
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;

    const result = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        cleanup();
        reject(new ZCodeProtocolTimeoutError(method, id, timeoutMs));
      }, timeoutMs);

      const onAbort = () => {
        this.pending.delete(key);
        clearTimeout(timer);
        cleanup();
        const reason = opts.signal?.reason;
        reject(reason instanceof Error ? reason : new DOMException('Request aborted', 'AbortError'));
      };
      const cleanup = () => opts.signal?.removeEventListener('abort', onAbort);

      this.pending.set(key, {
        method,
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        cleanup,
      });

      if (opts.signal?.aborted) {
        onAbort();
        return;
      }
      opts.signal?.addEventListener('abort', onAbort, { once: true });
    });

    try {
      await this.transport.send({ id, method, ...(params !== undefined ? { params } : {}) });
    } catch (err) {
      const p = this.pending.get(key);
      if (p) {
        clearTimeout(p.timer);
        p.cleanup();
        this.pending.delete(key);
      }
      throw err;
    }

    return result;
  }

  /** Fire-and-forget notification. */
  async notify(method: string, params?: unknown): Promise<void> {
    if (this.disposed || this.closed) throw new ZCodeTransportClosedError();
    await this.transport.send({ method, ...(params !== undefined ? { params } : {}) });
  }

  /** Answer a server->client request. */
  async respond(id: string | number, result: unknown): Promise<void> {
    if (this.disposed || this.closed) throw new ZCodeTransportClosedError();
    await this.transport.send({ id, result });
  }

  /** Refuse a server->client request. */
  async respondError(id: string | number, error: { code: number; message: string; data?: unknown }): Promise<void> {
    if (this.disposed || this.closed) throw new ZCodeTransportClosedError();
    await this.transport.send({ id, error });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectAll(new Error('ZCode Protocol client disposed'));
    this.emitter.removeAllListeners();
  }
}

/** Extract the zod message from an "Invalid params — <path>: <issue>" reply, if present. */
export function invalidParamsDetail(err: unknown): string | null {
  if (!(err instanceof ZCodeProtocolError) || err.code !== ERROR_CODES.InvalidParams) return null;
  return err.message.startsWith('Invalid params') ? err.message : null;
}

/** True when the runtime does not implement a method — a capability gap, not a bug in us. */
export function isMethodNotFound(err: unknown): boolean {
  return err instanceof ZCodeProtocolError && err.code === ERROR_CODES.MethodNotFound;
}
