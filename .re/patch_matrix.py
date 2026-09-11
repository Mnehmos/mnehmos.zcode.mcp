"""Fix the four defects the 15-tool matrix exposed.

python .re/patch_matrix.py
"""
import io, sys

def patch(path, pairs, required=True):
    s = io.open(path, encoding="utf-8").read()
    for old, new in pairs:
        if old not in s:
            if required:
                print(f"  !! NOT FOUND in {path}: {old[:80]!r}"); sys.exit(1)
            print(f"  -- absent, skipped in {path}"); continue
        s = s.replace(old, new, 1)
    io.open(path, "w", encoding="utf-8", newline="").write(s)
    print(f"  patched {path}")

# ── 1. row ids are NUMBERS, not strings ──────────────────────────────────────
# CONFIRMED: v4/conversation/fileChanges rejects target.rowId as a string with
# `expected number`, and rowsRange returns `rowId: 1`. The schema declared a string.
patch("src/schema/tools.ts", [
    ("const RowId = z.string().trim().min(1);",
     "/**\n"
     " * Conversation row ids are NUMBERS — `rowsRange` returns `rowId: 1`, and passing the string\n"
     " * \"1\" to fileChanges is rejected with `expected number`. A numeric string is coerced rather\n"
     " * than refused, because a caller copying an id out of JSON-as-text is a reasonable mistake.\n"
     " */\n"
     "const RowId = z.coerce.number().int().nonnegative();"),
])

# ── 2. headless must carry the provider, exactly as a spawned runtime does ───
patch("src/zcode/actions/protocol.ts", [
    ("import { acquireOrFail, describe, finish, newRunId, outcome, read, resolveWorkspace, workspaceRequired } from './_shared.js';",
     "import { acquireOrFail, describe, finish, newRunId, outcome, read, resolveWorkspace, workspaceRequired } from './_shared.js';\n"
     "import { bootstrapProvider, targetFromEnv } from '../settings.js';"),
    ("""  const timeout = typeof args.timeout_ms === 'number' ? args.timeout_ms : 600_000;
  const started = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(node, [bin, ...argv], {
      timeout,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    });""",
     """  // A headless CLI is a SEPARATE process and does not inherit ZCODE_MCP_* — it needs the provider
  // under the names the CLI reads (ZCODE_MODEL / ZCODE_BASE_URL / ZCODE_API_KEY). Without this it
  // fails with "Model config is missing" even though this server is fully configured, which is
  // exactly what the first matrix run did.
  const workspaceForEnv = typeof args.workspace === 'string' ? args.workspace : (ctx.env.ZCODE_MCP_WORKSPACE ?? process.cwd());
  const target = targetFromEnv();
  const boot = bootstrapProvider({ workspace: workspaceForEnv, ...(target ? { target } : {}) });
  for (const w of boot.warnings) {
    if (w.code !== 'zc_base_url_dual_purpose') o.warn(w.code, w.detail, w.impact);
  }

  const timeout = typeof args.timeout_ms === 'number' ? args.timeout_ms : 600_000;
  const started = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(node, [bin, ...argv], {
      timeout,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      // The bootstrapped environment, which is already de-credentialed except for the one key.
      env: boot.childEnv,
    });"""),
])

# ── 3. `available` is a read; it should not warn about read-back ─────────────
patch("src/zcode/actions/models.ts", [
    ("  o.readBackUnavailable('this action reports live state; it changes none');",
     "  o.readOnly();"),
])

# ── 4. files: row ids are numbers, and `changes` should not claim read-back ──
patch("src/zcode/actions/files.ts", [
    ("        const rowId = String(args.row_id);\n        const { value, recoveredFromStale } = await withStaleRetry(",
     "        const rowId = Number(args.row_id);\n        const { value, recoveredFromStale } = await withStaleRetry("),
    ("        const rowId = String(args.row_id);\n        const value = await read(o, runtime, 'v4/conversation/fileRewindPreview', { sessionId, target: { rowId } });",
     "        const rowId = Number(args.row_id);\n        const value = await read(o, runtime, 'v4/conversation/fileRewindPreview', { sessionId, target: { rowId } });"),
])

# `available` used readOnly already after the patch above; drop the now-dead import if unused
s = io.open("src/zcode/actions/models.ts", encoding="utf-8").read()
if "o.readBackUnavailable(" not in s:
    print("  models.ts: no readBackUnavailable call remains")

print("done")
