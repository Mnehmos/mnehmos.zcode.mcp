/**
 * The response envelope. Every tool answers with the same shape so a caller can route mixed output
 * mechanically instead of re-reading prose.
 *
 *   ok        did the WHOLE operation succeed, as evidenced by a read-back
 *   result    the operation's own data, produced by ZCode
 *   evidence  how the answer was obtained, and every warning with its impact tag
 *   run       where the wire log, generated settings and command line are
 *
 * `evidence.warnings[].impact` is the routing key: "advisory" (note it), "degraded" (usable but
 * incomplete), "unreliable" (do not act on this).
 *
 * Constitution Article II lives in this file: `finalise()` refuses to let a mutating action report
 * success without either a read-back or an explicit degraded/unreliable warning.
 */
import type { Warning, WarningImpact } from './warnings.js';

export interface RuntimeIdentity {
  version: string;
  protocol: { name: string; version: number };
  transport: 'stdio' | 'websocket';
  workspace_key: string;
  /** Which discovery rule matched, so a surprising pick is explicable. */
  discovered_via: string | null;
}

export interface MethodDiagnostic {
  method: string;
  ok: boolean;
  ms: number;
  error?: string;
}

export interface RunLocation {
  /** Redacted NDJSON of everything sent and received. */
  wire: string | null;
  /** A generated provider config, if one was used. Always null for the env-only bootstrap. */
  settings: string | null;
  /** The exact command line, so a surprising result is attributable. */
  command: string;
}

export interface Envelope {
  ok: boolean;
  tool: string;
  action: string;
  mode: 'local' | 'child' | 'headless';
  runtime: RuntimeIdentity | null;
  evidence: {
    payload_source: 'protocol' | 'filesystem' | 'stdout' | 'local';
    exit_code: number | null;
    duration_ms: number;
    timed_out: boolean;
    warnings: Warning[];
    errors: string[];
  };
  diagnostics: {
    methods: MethodDiagnostic[];
    stderr_tail: string[];
  };
  result: unknown;
  run: RunLocation | null;
}

export interface OutcomeInit {
  tool: string;
  action: string;
  mode?: Envelope['mode'];
  payloadSource?: Envelope['evidence']['payload_source'];
  runtime?: RuntimeIdentity | null;
  run?: RunLocation | null;
  /** Whether this action changes ZCode state. Drives the read-back rule below. */
  mutates?: boolean;
}

/**
 * Accumulates the evidence for one call. Dispatchers use `warn`, `error`, `method` and `readBack`;
 * `finalise` assembles the envelope and enforces the honesty rule.
 */
export class Outcome {
  readonly tool: string;
  readonly action: string;
  readonly mode: Envelope['mode'];
  readonly mutates: boolean;

  private payloadSource: Envelope['evidence']['payload_source'];
  private runtime: RuntimeIdentity | null;
  private run: RunLocation | null;
  private readonly started = Date.now();
  private readonly warnings: Warning[] = [];
  private readonly errors: string[] = [];
  private readonly methods: MethodDiagnostic[] = [];
  private readonly stderrTail: string[] = [];

  private readBackState:
    | { attempted: true; agreed: boolean; detail?: string }
    | { attempted: false }
    | null = null;

  private value: unknown = undefined;
  private okFlag = true;
  private timedOut = false;
  private exitCode: number | null = null;

  constructor(init: OutcomeInit) {
    this.tool = init.tool;
    this.action = init.action;
    this.mode = init.mode ?? 'local';
    this.mutates = init.mutates ?? false;
    this.payloadSource = init.payloadSource ?? 'local';
    this.runtime = init.runtime ?? null;
    this.run = init.run ?? null;
  }

  warn(code: string, detail: string, impact: WarningImpact = 'advisory'): this {
    this.warnings.push({ code, detail, impact });
    return this;
  }

  error(detail: string): this {
    this.errors.push(detail);
    this.okFlag = false;
    return this;
  }

  fail(detail: string, opts: { warn?: { code: string; detail: string; impact?: WarningImpact } } = {}): this {
    this.error(detail);
    if (opts.warn) this.warn(opts.warn.code, opts.warn.detail, opts.warn.impact ?? 'degraded');
    return this;
  }

  method(method: string, ok: boolean, ms: number, error?: string): this {
    this.methods.push({ method, ok, ms, ...(error ? { error } : {}) });
    return this;
  }

  setStderrTail(lines: string[]): this {
    this.stderrTail.length = 0;
    this.stderrTail.push(...lines.slice(-50));
    return this;
  }

  setExitCode(code: number | null): this {
    this.exitCode = code;
    return this;
  }

  setTimedOut(v: boolean): this {
    this.timedOut = v;
    return this;
  }

  setRuntime(rt: RuntimeIdentity | null): this {
    this.runtime = rt;
    return this;
  }

  setRun(run: RunLocation | null): this {
    this.run = run;
    return this;
  }

  setPayloadSource(s: Envelope['evidence']['payload_source']): this {
    this.payloadSource = s;
    return this;
  }

  /**
   * Record the read-back for a mutating action. Call this AFTER comparing the observed state with
   * what was requested. `agreed:false` fails the call — a mutation that did not take effect must
   * never be reported as success.
   */
  readBack(agreed: boolean, detail?: string): this {
    this.readBackState = { attempted: true, agreed, ...(detail ? { detail } : {}) };
    if (!agreed) {
      this.error(`read-back mismatch${detail ? `: ${detail}` : ''}`);
    }
    return this;
  }

  /** Explicitly declare that a mutating action cannot read back, so the envelope is honest. */
  readBackUnavailable(reason: string): this {
    this.readBackState = { attempted: false };
    this.warn('read_back_unavailable', reason, 'degraded');
    return this;
  }

  result<T>(value: T): T {
    this.value = value;
    return value;
  }

  get elapsedMs(): number {
    return Date.now() - this.started;
  }

  /** Assemble the envelope, enforcing the read-back rule for mutating actions. */
  finalise(): Envelope {
    // The invariant is: ok:true for a mutation requires a read-back. A call that already failed has
    // nothing to verify, so flagging it here would be noise — and noise is how a reader learns to
    // ignore the warning that matters.
    if (this.mutates && this.readBackState === null && this.okFlag) {
      this.warn(
        'read_back_missing',
        'this action mutates ZCode state but did not record a read-back; treat the result as unverified',
        'unreliable',
      );
    }
    return {
      ok: this.okFlag,
      tool: this.tool,
      action: this.action,
      mode: this.mode,
      runtime: this.runtime,
      evidence: {
        payload_source: this.payloadSource,
        exit_code: this.exitCode,
        duration_ms: this.elapsedMs,
        timed_out: this.timedOut,
        warnings: this.warnings,
        errors: this.errors,
      },
      diagnostics: { methods: this.methods, stderr_tail: this.stderrTail },
      result: this.value ?? null,
      run: this.run,
    };
  }
}

/** An envelope for an action that never spawns anything (discovery, disk reads, audit queries). */
export function localEnvelope(
  base: { tool: string; action: string },
  result: unknown,
  opts: { ok?: boolean; warnings?: Warning[]; errors?: string[]; extra?: Record<string, unknown> } = {},
): Envelope & Record<string, unknown> {
  return {
    ok: opts.ok ?? true,
    tool: base.tool,
    action: base.action,
    mode: 'local',
    runtime: null,
    evidence: {
      payload_source: 'local',
      exit_code: null,
      duration_ms: 0,
      timed_out: false,
      warnings: opts.warnings ?? [],
      errors: opts.errors ?? [],
    },
    diagnostics: { methods: [], stderr_tail: [] },
    result,
    run: null,
    ...(opts.extra ?? {}),
  };
}
