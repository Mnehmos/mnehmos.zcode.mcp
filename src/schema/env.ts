/**
 * Environment contract for the ZCode MCP.
 *
 * The agent runtime is discovered, never assumed: an explicit override wins, then ZCode's
 * own override variable, then the per-user agent cache, then the platform install roots.
 * Discovery never guesses a version and never downloads anything.
 *
 * A build of this server is only correct for a protocol it has verified (see
 * data/zcode_protocol_methods.json); the transport refuses to speak to a runtime whose
 * protocol identity does not match the catalog unless ZCODE_MCP_ALLOW_UNVERIFIED=1.
 */
import { z } from 'zod';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Relative location of the runtime inside a ZCode installation, confirmed by audit. */
const RUNTIME_RELATIVE = ['resources', 'glm', 'zcode.cjs'] as const;
/** Native-binary form, preferred by ZCode's own resolver when present. */
const NATIVE_RELATIVE = ['resources', 'glm', 'zcode-agent.exe'] as const;

const EnvSchema = z.object({
  /** Explicit runtime bundle. Wins over everything. */
  ZCODE_MCP_CLI: z.string().optional(),
  /** ZCode installation root, e.g. `E:\zcode`. */
  ZCODE_MCP_INSTALL: z.string().optional(),
  /** Node used to launch the runtime. Defaults to the node running this server. */
  ZCODE_MCP_NODE: z.string().optional(),
  /** Workspace used when a call omits one. */
  ZCODE_MCP_WORKSPACE: z.string().optional(),

  /**
   * Model provider to install into spawned runtimes, as "<model>" or "<provider>/<model>".
   * Delivered to the child as ZCODE_MODEL (+ ZCODE_BASE_URL), which the agent reads as a
   * priority-40 config layer. The credential comes from the ambient environment
   * (ZCODE_API_KEY / ANTHROPIC_API_KEY / <PROVIDER>_API_KEY) and is never written to a file.
   */
  ZCODE_MCP_MODEL: z.string().optional(),
  ZCODE_MCP_BASE_URL: z.string().optional(),

  ZCODE_MCP_WORK_DIR: z.string().default(path.join(packageRoot, 'work')),
  ZCODE_MCP_DB: z.string().default(path.join(packageRoot, 'data', 'audit.db')),

  /** Per-request protocol timeout. ZCode's own default is 180 s. */
  ZCODE_MCP_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(180_000),
  /** Cold-start grace before the first response is declared a failure. Measured baseline ~1.1 s. */
  ZCODE_MCP_STARTUP_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),
  /** Idle children are evicted and their process group killed. */
  ZCODE_MCP_CHILD_IDLE_MS: z.coerce.number().int().min(0).default(900_000),
  ZCODE_MCP_MAX_CHILDREN: z.coerce.number().int().min(1).max(8).default(2),
  /** Notifications retained per session. Matches ZCode's own eventRetentionPerSession. */
  ZCODE_MCP_EVENT_BUFFER: z.coerce.number().int().min(100).max(20_000).default(2_000),

  ZCODE_MCP_APPROVAL: z.enum(['deny', 'allow', 'ask']).default('deny'),
  ZCODE_MCP_APPROVAL_ALLOWLIST: z.string().optional(),
  ZCODE_MCP_DEFAULT_MODE: z.enum(['plan', 'build', 'edit', 'yolo']).default('edit'),

  /** Warn when the registered tool count approaches the provider's accepted ceiling. */
  ZCODE_MCP_TOOL_BUDGET: z.coerce.number().int().min(1).default(88),
  /** Retained wire logs under work/wire/. */
  ZCODE_MCP_KEEP_WIRE: z.coerce.number().int().min(0).default(200),

  /** Kill switch for the raw protocol passthrough. */
  ZCODE_MCP_DISABLE_PROTOCOL: z.string().optional(),
  ZCODE_MCP_PROTOCOL_ALLOW: z.string().optional(),
  ZCODE_MCP_PROTOCOL_ALLOW_MUTATIONS: z.string().optional(),
  /** Allow a runtime whose protocol identity does not match the catalog. */
  ZCODE_MCP_ALLOW_UNVERIFIED: z.string().optional(),

  ZCODE_MCP_ALLOW_PROVIDER_EDIT: z.string().optional(),
  ZCODE_MCP_ALLOW_PLUGIN_INSTALL: z.string().optional(),
  ZCODE_MCP_ALLOW_MCP_CONFIG_EDIT: z.string().optional(),
  ZCODE_MCP_ALLOW_PERSIST_RULES: z.string().optional(),

  /**
   * Comma-separated environment variable names to RE-ADMIT to a spawned runtime.
   *
   * By default every credential-shaped variable is withheld from the child, so a runtime never
   * inherits a credential it was not given. Set this when the agent's own shell genuinely needs one
   * (e.g. a git token) — naming it is an explicit decision rather than an accident.
   */
  ZCODE_MCP_CHILD_ENV_PASSTHROUGH: z.string().optional(),

  /** Secret scrubbing. Never disable in shared or logged use. */
  ZCODE_MCP_REDACT: z.string().default('1'),
});

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

function truthy(v: string | undefined): boolean {
  return v !== undefined && TRUTHY.has(v.trim().toLowerCase());
}

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(processEnv: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(processEnv);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid ZCODE_MCP_* environment: ${issues}`);
  }
  return parsed.data;
}

// ── guard flags ──────────────────────────────────────────────────────────────
// Read from a raw env bag rather than the parsed Env so a call can be refused before
// any work happens, and so tests can drive them without a full environment.

export const guards = {
  providerEdit: (e: NodeJS.ProcessEnv = process.env) => truthy(e.ZCODE_MCP_ALLOW_PROVIDER_EDIT),
  pluginInstall: (e: NodeJS.ProcessEnv = process.env) => truthy(e.ZCODE_MCP_ALLOW_PLUGIN_INSTALL),
  mcpConfigEdit: (e: NodeJS.ProcessEnv = process.env) => truthy(e.ZCODE_MCP_ALLOW_MCP_CONFIG_EDIT),
  persistRules: (e: NodeJS.ProcessEnv = process.env) => truthy(e.ZCODE_MCP_ALLOW_PERSIST_RULES),
  redact: (e: NodeJS.ProcessEnv = process.env) => !('ZCODE_MCP_REDACT' in e) || truthy(e.ZCODE_MCP_REDACT),
  allowUnverified: (e: NodeJS.ProcessEnv = process.env) => truthy(e.ZCODE_MCP_ALLOW_UNVERIFIED),
  protocolEnabled: (e: NodeJS.ProcessEnv = process.env) => !truthy(e.ZCODE_MCP_DISABLE_PROTOCOL),
  protocolMutations: (e: NodeJS.ProcessEnv = process.env) => truthy(e.ZCODE_MCP_PROTOCOL_ALLOW_MUTATIONS),
};

// ── runtime discovery ────────────────────────────────────────────────────────

export interface Discovery {
  /** Absolute path to the runtime bundle, or null when nothing was found. */
  cli: string | null;
  /** Which rule matched, for the envelope and the audit row. */
  source: string | null;
  /** Every candidate tried, so a failure message can be actionable. */
  tried: string[];
}

function firstExisting(candidates: Array<{ p: string; source: string }>): Discovery {
  const tried: string[] = [];
  for (const c of candidates) {
    if (!c.p) continue;
    tried.push(c.p);
    try {
      if (fs.existsSync(c.p) && fs.statSync(c.p).isFile()) {
        return { cli: c.p, source: c.source, tried };
      }
    } catch {
      /* unreadable candidate is just a miss */
    }
  }
  return { cli: null, source: null, tried };
}

/**
 * Candidate install roots, cheapest and most likely first.
 *
 * A ZCode install is commonly a directory at a drive root (`E:\zcode`), which is why the
 * fixed drives are probed — that is a handful of `existsSync` calls, not a filesystem walk.
 */
function installRoots(env: NodeJS.ProcessEnv): Array<{ root: string; source: string }> {
  const roots: Array<{ root: string; source: string }> = [];
  const explicit = env.ZCODE_MCP_INSTALL?.trim();
  if (explicit) roots.push({ root: explicit, source: 'ZCODE_MCP_INSTALL' });

  const localAppData = env.LOCALAPPDATA?.trim();
  if (localAppData) {
    roots.push({ root: path.join(localAppData, 'Programs', 'ZCode'), source: 'LOCALAPPDATA/Programs' });
    roots.push({ root: path.join(localAppData, 'ZCode'), source: 'LOCALAPPDATA/ZCode' });
  }
  const programFiles = env.ProgramFiles?.trim() ?? env.PROGRAMFILES?.trim();
  if (programFiles) roots.push({ root: path.join(programFiles, 'ZCode'), source: 'ProgramFiles' });

  if (process.platform === 'win32') {
    for (let c = 'C'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
      const drive = `${String.fromCharCode(c)}:\\`;
      if (!fs.existsSync(drive)) continue;
      roots.push({ root: path.join(drive, 'zcode'), source: `drive-root ${drive}` });
    }
  } else {
    roots.push({ root: '/opt/zcode', source: '/opt' });
    roots.push({ root: '/usr/local/zcode', source: '/usr/local' });
  }
  return roots;
}

export function discoverRuntime(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): Discovery {
  const candidates: Array<{ p: string; source: string }> = [];
  const put = (p: string | undefined, source: string) => {
    if (p && p.trim()) candidates.push({ p: p.trim(), source });
  };

  // 1. explicit override
  put(env.ZCODE_MCP_CLI, 'ZCODE_MCP_CLI');
  // 2. ZCode's own override variable — the same one the desktop honours
  put(env.GLM_BINARY_PATH, 'GLM_BINARY_PATH');
  // 3. fixed login both a native binary and the node bundle, per install root
  for (const { root, source } of installRoots(env)) {
    candidates.push({ p: path.join(root, ...NATIVE_RELATIVE), source: `${source} (native)` });
    candidates.push({ p: path.join(root, ...RUNTIME_RELATIVE), source });
  }
  // 4. per-user agent cache, where ZCode deploys remote runtimes
  candidates.push({ p: path.join(homeDir, '.zcode', 'server', 'agents', 'glm', 'zcode.cjs'), source: 'user agent cache' });

  return firstExisting(candidates);
}

/** Node used to launch the runtime. The bundle must be launched *as* node — executing it directly fails with EFTYPE. */
export function resolveNode(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.ZCODE_MCP_NODE?.trim();
  if (explicit && fs.existsSync(explicit)) return explicit;
  return process.execPath;
}

/** Actionable failure text. Never an empty result. */
export function discoveryFailure(d: Discovery): string {
  const tried = d.tried.length ? d.tried.map((t) => `  - ${t}`).join('\n') : '  (no candidates were derivable)';
  return [
    'ZCode agent runtime not found.',
    'Set ZCODE_MCP_CLI to the zcode.cjs bundle, or ZCODE_MCP_INSTALL to the ZCode install root.',
    `Typically that is <install>/resources/glm/zcode.cjs (audited install: E:\\zcode).`,
    'Candidates tried:',
    tried,
  ].join('\n');
}

// ── CLI flags verified to parse ──────────────────────────────────────────────
/**
 * `zcode --help` advertises flags its parser rejects. `util.parseArgs` runs with
 * `strict: true`, so emitting an unverified flag turns a working call into a usage error.
 *
 * CONFIRMED accepted  : --prompt, -p/--print, --json, --output-format, --cwd, --mode,
 *                       --resume, -c/--continue, --target, --target-replace, --attach,
 *                       --locale, --surface, --force-mcs, -f/--force, --verbose,
 *                       --browser-use, --browser-executable, --no-color, --no-browser,
 *                       --stdio, -h/--help, -v/--version, plus a --disallowed-tools pre-pass
 * CONFIRMED rejected  : --settings, --max-turns, --allowed-tools, --permission-mode,
 *                       --allow-main-worktree-yolo
 *
 * test/headless.test.ts asserts this table, so it cannot drift silently.
 */
export const VERIFIED_CLI_FLAGS = {
  accepted: [
    '--help', '--version', '--json', '--output-format', '--no-color', '--no-browser',
    '--browser-use', '--browser-executable', '--prompt', '--attach', '--cwd', '--locale',
    '--resume', '--target', '--target-replace', '--continue', '--force', '--force-mcs',
    '--mode', '--verbose', '--stdio', '--surface', '--disallowed-tools',
  ],
  rejected: [
    '--settings', '--max-turns', '--allowed-tools', '--permission-mode',
    '--allow-main-worktree-yolo',
  ],
} as const;

export function ensureDirs(env: Env): { work: string; wire: string; stdout: string; stderr: string; reports: string; settings: string; db: string } {
  const work = env.ZCODE_MCP_WORK_DIR;
  const dirs = {
    work,
    wire: path.join(work, 'wire'),
    stdout: path.join(work, 'stdout'),
    stderr: path.join(work, 'stderr'),
    reports: path.join(work, 'reports'),
    settings: path.join(work, 'settings'),
    db: env.ZCODE_MCP_DB,
  };
  for (const d of [dirs.work, dirs.wire, dirs.stdout, dirs.stderr, dirs.reports, dirs.settings]) {
    fs.mkdirSync(d, { recursive: true });
  }
  fs.mkdirSync(path.dirname(dirs.db), { recursive: true });
  return dirs;
}
