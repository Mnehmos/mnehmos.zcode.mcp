/**
 * Does ZCode's own model management provision a runtime that THIS server spawns?
 *
 * The question behind "get rid of the .env": ZCode's `~/.zcode/v2/config.json` holds provider
 * credentials, and ZCode's own sessions use them. But a runtime spawned as
 * `node zcode.cjs app-server` is a separate process, and addendum A19 found its provider bootstrap
 * to be environment-only. That was measured before the config had providers in it. Re-measure now
 * that 8 providers are configured, because if the file path works the answer changes completely.
 *
 * Two scenarios, identical except for the environment:
 *   A  inherited env with every credential and ZCODE_* model variable removed
 *   B  scenario A plus ZCODE_MODEL / ZCODE_BASE_URL / ZCODE_API_KEY from .env
 *
 * The runtime keeps USERPROFILE and APPDATA, so it can still read `~/.zcode/v2/config.json` — the
 * test is whether that config is enough, not whether it is reachable.
 *
 * Prints no credential values.
 *
 * Run: node .re/probe_model_env.mjs
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const RUNTIME = process.env.ZCODE_CLI || 'E:/zcode/resources/glm/zcode.cjs';
const WS = process.cwd();
const TIMEOUT = 25000;

const credNames = (k) => /API_KEY|_TOKEN|_SECRET|PASSWORD/i.test(k) || k.startsWith('ZCODE_MODEL') || k.startsWith('ZCODE_BASE_URL');

function baseEnv() {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (credNames(k)) continue;
    out[k] = v;
  }
  out.ZCODE_SURFACE = 'desktop';
  return out;
}

function dotenv() {
  const out = {};
  const p = join(WS, '.env');
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function probe(label, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RUNTIME, 'app-server', '--stdio', '--cwd', WS], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: WS,
      env,
    });
    let buf = '';
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      try { child.kill(); } catch { /* already gone */ }
      resolve(result);
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, '').trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch {
          console.log(`    [out] ${line.slice(0, 200)}`);
          continue;
        }
        // Any reply to id 1 carries the state; a notification is just logged.
        const isReply = String(msg.id ?? '') === '1' || msg.result || msg.error;
        if (!isReply) {
          console.log(`    [event] ${line.slice(0, 160)}`);
          continue;
        }
        const r = msg.result ?? {};
        finish({
          label,
          error: msg.error ? `${msg.error.code} ${msg.error.message}` : null,
          current: r.settings?.model?.current ?? null,
          available: r.settings?.model?.available?.length ?? 0,
          catalogProviders: r.modelCatalog?.providers?.length ?? 0,
          catalogRevision: r.modelCatalog?.revision ?? null,
        });
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      for (const l of String(d).split(/\r?\n/)) {
        if (l.trim()) console.log(`    [err] ${l.slice(0, 200)}`);
      }
    });
    child.on('error', (e) => finish({ label, error: `spawn failed: ${e.message}` }));
    child.on('exit', (c) => finish({ label, error: `exited (code ${c}) before answering` }));

    child.stdin.write(
      `${JSON.stringify({
        id: 1,
        method: 'workspace/readState',
        params: { workspace: { workspacePath: WS, workspaceKey: WS } },
      })}\n`,
    );

    setTimeout(() => finish({ label, error: `no answer within ${TIMEOUT}ms` }), TIMEOUT);
  });
}

const dot = dotenv();
const scenarios = [
  ['A  no provider env', baseEnv()],
  [
    'B  + ZCODE_MODEL/BASE_URL/API_KEY from .env',
    {
      ...baseEnv(),
      ZCODE_MODEL: dot.ZCODE_MCP_MODEL ?? '',
      ZCODE_BASE_URL: dot.ZCODE_MCP_BASE_URL ?? '',
      ZCODE_API_KEY: dot.DEEPSEEK_API_KEY ?? '',
    },
  ],
];

console.log(`runtime: ${RUNTIME}`);
console.log(`workspace: ${WS}`);
console.log(`zcode config on disk: ${existsSync(join(homedir(), '.zcode', 'v2', 'config.json')) ? 'present' : 'absent'}`);
console.log('');

for (const [label, env] of scenarios) {
  const r = await probe(label, env);
  console.log(`${label}`);
  if (r.error) {
    console.log(`    error: ${r.error}`);
    continue;
  }
  console.log(`    settings.model.current   ${JSON.stringify(r.current)}`);
  console.log(`    settings.model.available ${r.available}`);
  console.log(`    modelCatalog.providers   ${r.catalogProviders}  (revision ${r.catalogRevision})`);
}
