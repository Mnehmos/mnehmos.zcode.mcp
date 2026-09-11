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

/**
 * Key-name matching is a *normalised suffix* test, not a substring regex, because a substring test
 * gets both directions wrong:
 *
 *   - it over-matches: `apiKeyRequired` is a boolean flag, and `sessionId` is the join key we
 *     genuinely need in results and audit rows — redacting either would break the tool, not protect
 *     anyone. (`sessionId` is an identifier, not a credential.)
 *   - it under-matches: a bare `token` pattern has to catch `zcodejwttoken`, the real credential key,
 *     while not catching the usage counters `totalTokens` / `inputTokens` / `cacheReadTokens`.
 *
 * Normalising to lowercase alphanumerics and testing ends-with fixes both: `apikeyrequired` does not
 * end with `apikey`, `sessionid2` does not end with a sensitive suffix, and `zcodejwttoken` does end
 * with `token` while `totaltokens` ends with `tokens`.
 */
const SENSITIVE_SUFFIXES = [
  'apikey',
  'token',
  'secret',
  'password',
  'passwd',
  'credential',
  'privatekey',
  'cookie',
] as const;

const SENSITIVE_EXACT = ['authorization', 'auth', 'bearer', 'proxy-authorization'] as const;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** True when a key name should never be echoed. */
export function isSensitiveKey(key: string): boolean {
  const n = normalizeKey(key);
  if (n.length === 0) return false;
  if ((SENSITIVE_EXACT as readonly string[]).includes(n)) return true;
  return SENSITIVE_SUFFIXES.some((s) => n.endsWith(s));
}

/** Value shapes that are secrets regardless of the key they arrived under. */
const SENSITIVE_VALUE: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI / OpenRouter / DeepSeek style
  /\bsk-or-v1-[A-Za-z0-9]{16,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*\b/gi,
  /\b[0-9a-f]{32}\.[A-Za-z0-9]{16}\b/g, // the audited provider-key shape
  /\bA(?:KIA|SIA)[0-9A-Z]{16}\b/g, // AWS
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
    out[k] = isSensitiveKey(k) ? REDACTED : redact(v, depth + 1);
  }
  return out;
}

/**
 * Serialize for a wire log. Redaction is always applied here regardless of
 * ZCODE_MCP_REDACT, because the wire log is a file that outlives the process; the flag only
 * controls whether the caller-supplied verbosity is reduced.
 */
export function wireLine(direction: 'in' | 'out', message: unknown): string {
  return JSON.stringify({ dir: direction, msg: redact(message) });
}
