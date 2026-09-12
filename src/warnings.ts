/**
 * The warning vocabulary.
 *
 * `impact` is the routing key a caller branches on, so it is part of the contract rather than a
 * judgement call made at each call site:
 *
 *   advisory    proceed; the caller should know but nothing is wrong
 *   degraded    the result is usable but incomplete — do not treat it as the whole answer
 *   unreliable  do NOT act on this result; something about it is not trustworthy
 *
 * Codes are lower snake_case and are stable. Adding one is fine; renaming one is a breaking change
 * that must update the contracts and the README.
 */

export type WarningImpact = 'advisory' | 'degraded' | 'unreliable';

export interface Warning {
  code: string;
  detail: string;
  impact: WarningImpact;
}

/** Every code this server can emit, with its default impact. */
export const WARNING_CODES = {
  // ── provider / configuration ──────────────────────────────────────────────
  provider_not_configured: 'unreliable',
  provider_key_missing: 'degraded',
  provider_config_invalid: 'unreliable',
  provider_config_disabled: 'degraded',
  provider_key_from_registry: 'advisory',
  zc_base_url_dual_purpose: 'advisory',
  restart_required: 'advisory',
  file_absent: 'advisory',

  // ── the honesty rule ─────────────────────────────────────────────────────
  read_back_missing: 'unreliable',
  read_back_unavailable: 'degraded',
  no_terminal_event: 'degraded',
  not_awaited: 'degraded',
  event_turn_mismatch: 'unreliable',
  admission_only: 'degraded',

  // ── protocol ─────────────────────────────────────────────────────────────
  catalog_drift: 'degraded',
  protocol_version_mismatch: 'unreliable',
  stale_after_retry: 'degraded',
  raw_protocol: 'unreliable',
  frame_limit: 'advisory',
  payload_too_large: 'degraded',
  payload_summarised: 'degraded',

  // ── operational hazards ──────────────────────────────────────────────────
  processes_started: 'advisory',
  all_servers_failed: 'degraded',
  tool_budget: 'degraded',
  limit_clamped: 'advisory',
  already_idle: 'advisory',
  idempotent_replay: 'advisory',
  flag_unverified: 'degraded',
  stdout_not_json: 'degraded',
  runtime_unavailable: 'unreliable',
  project_config_created: 'advisory',
} as const satisfies Record<string, WarningImpact>;

export type WarningCode = keyof typeof WARNING_CODES;

/** Build a warning with the code's default impact, overridable when a site knows better. */
export function warn(code: WarningCode, detail: string, impact?: WarningImpact): Warning {
  return { code, detail, impact: impact ?? WARNING_CODES[code] };
}

/** Sort so the most consequential warnings come first, for a caller that only reads the head. */
export function byImpact<T extends { impact: WarningImpact }>(warnings: T[]): T[] {
  const rank: Record<WarningImpact, number> = { unreliable: 0, degraded: 1, advisory: 2 };
  return [...warnings].sort((a, b) => rank[a.impact] - rank[b.impact]);
}
