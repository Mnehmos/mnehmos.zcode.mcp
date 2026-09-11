"""Add the 0.3.0 changelog entry. python .re/patch_changelog.py"""
import io

ENTRY = """## [0.3.0] - 2026-09-11

**All 15 tools implemented.** A probe matrix that calls every tool through the MCP protocol returns
16 successes out of 18 calls, and the two failures are declared capability limitations rather than
bugs.

### Added

- **`zcode_conversation`** — rows, messages, events, plans, usage. The row is the addressable unit;
  `rows` reports the runtime's own `atLogEpoch` / `atSeq` / `hasMore` verbatim, so a caller can
  thread the tokens through without guessing.
- **`zcode_files`** — attachment read/write, and `rewind_apply` implemented as a **fork** (the safe
  form: it keeps the pre-rewind state reachable).
- **`zcode_settings`** — `read_state`, file reads with mandatory redaction, `set_desktop` as an
  additive patch with a timestamped backup, and provider actions behind their own opt-in.
- **`zcode_protocol`** — the escape hatch. Off by default, allowlisted to read-only paths, with
  mutating methods behind a second flag. Every result carries `raw_protocol: unreliable`.
- **`zcode_headless`** — one-shot CLI runs, emitting **only** flags verified to parse.

### Two declared capability limitations

`zcode_automation`, and `zcode_files changes` / `rewind_preview`, resolve to methods that exist in the
protocol but need a host tier an owned runtime does not have:

| method | what happens | why |
|---|---|---|
| `automation/*` | `-32601 Method not found` | scheduling appears to be host-side |
| `v4/conversation/fileChanges` | `baseRevision` unobtainable | every derivable revision is rejected with `proto.staleRevision`, while `baseLogEpoch` IS obtainable and accepted |

Both are reported with `impact: unreliable` and a named reason. **A retry loop that can never succeed
is worse than a named gap** — it looks like flakiness and hides a real boundary.

### Fixed - four defects the tool matrix caught

- `zcode_headless` was a separate process that did not inherit `ZCODE_MCP_*`, so it failed with
  "Model config is missing" even though the server was fully configured. It now bootstraps the CLI's
  own provider environment exactly as a spawned runtime does.
- Conversation row ids are **numbers**. The schema declared a string, and `fileChanges` rejects `"1"`.
- `target` also needs `entityId`, now resolved from a `rowsRange` call: one read yielding both the
  target and the tokens, rather than leaking the internal row shape into the tool contract.
- Read-only actions were warning about read-back, the wrong signal for something with nothing to
  verify. `Outcome.readOnly()` marks it not-applicable silently.

### Tests

177 across 10 suites. New assertions pin what would silently rot: that `buildHeadlessArgs` **never**
emits the four flags the CLI advertises but its parser rejects; that the protocol allowlist cannot
let a wildcard escape its namespace; and that `redactDeep` does not mutate its input.

"""


def main() -> None:
    path = "CHANGELOG.md"
    text = io.open(path, encoding="utf-8").read()
    anchor = "## [0.2.0] - 2026-09-11"
    if anchor not in text:
        raise SystemExit(f"anchor not found in {path}")
    if "## [0.3.0]" in text:
        raise SystemExit("0.3.0 entry already present")
    io.open(path, "w", encoding="utf-8", newline="").write(text.replace(anchor, ENTRY + anchor, 1))
    print("CHANGELOG updated for 0.3.0")


if __name__ == "__main__":
    main()
