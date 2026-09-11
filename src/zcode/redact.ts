/**
 * Secret scrubbing, applied to every wire line, every result and every audit row.
 *
 * Two layers, because key-name matching alone is not enough:
 *   1. key-name matching, for structured payloads
 *   2. value-shape matching, for secrets that arrive as bare strings (env values, headers,
 *      a key pasted into a prompt)
 *
 * Constitution Article IV: this is on by default and is never relaxed for results — only
 * wire-log verbosity is affected by ZCODE_MCP_REDACT.
 */

export const REDACTED = '[REDACTED]';

/** Key names that always mean "do not echo this". */
const SENSITIVE_KEY = /(api[-_]?key|authorization|auth[-_]?token|access[-_]?token|refresh[-_]?token|bearer|secret|password|passwd|credential|private[-_]?key|cookie|session[-_]?id|webhook[-_]?secret)/i;

/** Value shapes that are secrets regardless of the key they arrived under. */
const SENSITIVE_VALUE: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,                       // OpenAI / OpenRouter / DeepSeek style
  /\bsk-or-v1-[A-Za-z0-9]{16,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*\b/gi,
  /\b[0-9a-f]{32}\.[A-Za-z0-9]{16}\b/g,               // the audited provider-key shape
  /\bA(?:KIA|SIA)[0-9A-Z]{16}\b/g,                    // AWS
];

/** Scrub bare strings for value-shaped secrets. */
export function redactString(s: string): string {
  let out = s;
  for (const re of SENSITIVE_VALUE) out = out.replace(re, REDACTED);
  return out;
}

/**
 * Deep-scrub a value. Returns a new value; never mutates the input.
 * `depth` is bounded so a cyclic or adversarial payload cannot hang the caller.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 12) return value;
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redact(v, depth + 1);
  }
  return out;
}

/** True when a key name is considered sensitive. Exposed for tests and for the settings tool. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

/**
 * Serialize for a wire log. Redaction is always applied here regardless of
 * ZCODE_MCP_REDACT, because the wire log is a file that outlives the process; the flag only
 * controls whether the caller-supplied verbosity is reduced.
 */
export function wireLine(direction: 'in' | 'out', message: unknown): string {
  return JSON.stringify({ dir: direction, msg: redact(message) });
}
