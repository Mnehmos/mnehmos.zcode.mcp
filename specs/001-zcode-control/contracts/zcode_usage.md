# Contract: `zcode_usage`

**Purpose**: token and activity analytics. Read-only. Rating **A**.

## Actions

| Action | Arguments | Underlying interface |
|---|---|---|
| `stats` | `range: 'all' \| '7d' \| '30d'` (**required**) | `usage/stats` |

`range` is mandatory — CONFIRMED: omitting it returns
`-32602 "Invalid params — range: Invalid option: expected one of \"all\"|\"7d\"|\"30d\""`.

## Output (verbatim from ZCode)

```ts
{
  range, generatedAt, timeZone, source: 'agent-db',
  summary: {
    totalTokens, inputTokens, outputTokens, reasoningTokens,
    cacheCreationTokens, cacheReadTokens, cacheHitRate,
    totalSessions, totalTurns, toolCallCount, toolErrorRate, modelErrorRate,
    avgTimeToFirstTokenMs, avgTurnDurationMs,
    activeDays, currentStreakDays, longestStreakDays, longestSessionMs,
    peakDayTokens,
    favoriteModel: { modelId, totalTokens, share }
  },
  heatmap: {
    startDate, endDate, maxTokens,
    weeks: [{ weekIndex, days: [{ date, level, totalTokens, turnCount, toolCallCount }] }]
  }
}
```

Calibration from the audited machine: `cacheHitRate ≈ 0.977`, `toolErrorRate ≈ 0.028`,
`modelErrorRate ≈ 0.007`, `avgTimeToFirstTokenMs ≈ 6.7 s`.

## Failure modes

| Condition | Result |
|---|---|
| Missing/`: invalid `range` | `ok:false` before send |
| No usage history | `ok:true` with zeroed `summary` and an empty `heatmap` — absence of data is not an error |
| Runtime unavailable | `ok:false`, transport error |

## Permissions

None. Reads the agent's own database via the protocol; this server never touches the database file.

## Notes

- `source: 'agent-db'` in the payload confirms the figure comes from the agent's own usage store, and
  `timeZone` is ZCode's, not the caller's — worth surfacing when comparing to wall-clock logs.
- `usage/stats` reports all workspaces on the machine; per-session figures come from
  `zcode_session usage`.
