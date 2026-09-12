/**
 * Call `workspace/upsertModelProvider` directly, with the shape the runtime's own schema requires,
 * bypassing our (incompatible) tool schema.
 *
 * Shape read from the runtime bundle — `f.object({ providerId, kind, models: array(...).min(1) ...
 * }).strict()` — which is why `{provider, model}` is rejected: strict means no extra keys.
 *
 * The question this answers: can a running runtime's model catalogue be WIDENED at runtime? If it
 * can, models become switchable live (`select scope=session`); if it cannot, a model switch can only
 * ever apply to the next spawned runtime.
 *
 * Run: node .re/probe_upsert_raw.mjs
 */
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const WS = mkdtempSync(join(tmpdir(), 'zcode-raw-'));
const KEY = mkdtempSync(join(tmpdir(), 'zcode-raw-key-'));
const RUNTIME = process.env.ZCODE_CLI || 'E:/zcode/resources/glm/zcode.cjs';

const cfg = JSON.parse(readFileSync(join(homedir(), '.zcode', 'v2', 'config.json'), 'utf8'));
const apiKey = cfg.provider['f4f09303-fbfc-4895-8258-ccb32ef2149f'].options.apiKey;

const env = {
  ...process.env,
  ZCODE_SURFACE: 'desktop',
  ZCODE_MODEL: 'deepseek/deepseek-v4.1-flash-expires-on-0910',
  ZCODE_BASE_URL: 'https://api.deepseek.com/anthropic',
  ZCODE_API_KEY: apiKey,
};
delete env.OPENROUTER_API_KEY;

const wsRef = { workspacePath: WS, workspaceKey: WS };
const child = spawn(process.execPath, [RUNTIME, 'app-server', '--stdio', '--cwd', WS], { stdio: ['pipe', 'pipe', 'pipe'], env });
let buf = '';
const send = (o) => child.stdin.write(`${JSON.stringify(o)}\n`);

child.stdout.setEncoding('utf8');
child.stdout.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.id === 1) {
      console.log('readState BEFORE:', JSON.stringify(summary(m.result)));
      send({
        id: 2,
        method: 'workspace/upsertModelProvider',
        params: {
          workspace: wsRef,
          provider: {
            providerId: 'deepseek',
            kind: 'anthropic',
            baseURL: 'https://api.deepseek.com/anthropic',
            models: [{ modelId: 'deepseek-v4-flash' }, { modelId: 'deepseek-v4-pro' }],
          },
        },
      });
    } else if (m.id === 2) {
      console.log(`upsert -> ${m.error ? `ERROR ${m.error.code} ${String(m.error.message).slice(0, 200)}` : 'accepted'}`);
      send({ id: 3, method: 'workspace/readState', params: { workspace: wsRef } });
    } else if (m.id === 3) {
      console.log('readState AFTER :', JSON.stringify(summary(m.result)));
      const avail = m.result?.settings?.model?.available ?? [];
      console.log(`\n${avail.length > 1 ? 'CATALOGUE WIDENED — live switching is possible' : 'catalogue unchanged — a switch cannot introduce a model into a running runtime'}`);
      try { child.kill(); } catch { /* gone */ }
      process.exit(0);
    }
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', () => { /* logs only */ });
child.on('exit', (c) => { console.log(`runtime exited (${c})`); process.exit(1); });

function summary(r) {
  const s = r?.settings?.model ?? {};
  return {
    current: s.current ?? null,
    available_count: (s.available ?? []).length,
    available: (s.available ?? []).map((m) => m.label),
    catalog_providers: (r?.modelCatalog?.providers ?? []).length,
  };
}

send({ id: 1, method: 'workspace/readState', params: { workspace: wsRef } });
setTimeout(() => { console.log('timed out'); process.exit(1); }, 60_000);
