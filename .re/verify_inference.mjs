/**
 * End-to-end: can a runtime launched with ONLY the registration's env block complete a real turn?
 *
 * This is the user-facing question — "can the MCP call api inference" — answered by doing it rather
 * than by inspecting state. Two checks:
 *
 *   1. spawn `app-server` with that env and read workspace/readState  (provisioning)
 *   2. run one real headless turn and print the model's actual reply    (inference)
 *
 * Step 2 costs a fraction of a cent and is the only step that proves inference. Provisioned state
 * that never completes a call is the failure mode this exists to distinguish.
 *
 * Run: node .re/verify_inference.mjs
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const RUNTIME = process.env.ZCODE_CLI || 'E:/zcode/resources/glm/zcode.cjs';
const WS = process.cwd();
const regPath = join(homedir(), '.zcode', 'cli', 'config.json');

const block = JSON.parse(readFileSync(regPath, 'utf8'))?.mcp?.servers?.zcode?.env ?? {};
if (!block.ZCODE_MCP_MODEL) {
  console.error('no ZCODE_MCP_MODEL in the registration; nothing to verify');
  process.exit(1);
}

// Exactly what ZCode hands the server: its environment plus the entry's env block. No .env.
const env = { ...process.env, ...block, ZCODE_SURFACE: 'desktop' };
for (const [k, v] of Object.entries(block)) if (k.endsWith('_API_KEY')) env.ZCODE_API_KEY = v;
env.ZCODE_MODEL = block.ZCODE_MCP_MODEL;
env.ZCODE_BASE_URL = block.ZCODE_MCP_BASE_URL;
// The inherited shell's stale OPENROUTER_API_KEY must not be mistaken for the resolved key.
delete env.OPENROUTER_API_KEY;

console.log(`entry env keys : ${Object.keys(block).sort().join(', ')}`);
console.log(`model          : ${block.ZCODE_MCP_MODEL}`);
console.log(`base           : ${block.ZCODE_MCP_BASE_URL}`);
console.log(`key var        : ${Object.keys(block).find((k) => k.endsWith('_API_KEY')) ?? '(none)'}  (value not shown)\n`);

// ── 1. provisioning ─────────────────────────────────────────────────────────
console.log('1. provisioning — app-server launched with that env alone:');
await new Promise((resolve) => {
  const child = spawn(process.execPath, [RUNTIME, 'app-server', '--stdio', '--cwd', WS], {
    stdio: ['pipe', 'pipe', 'pipe'], cwd: WS, env,
  });
  let buf = '';
  let settled = false;
  const done = (r) => {
    if (settled) return;
    settled = true;
    console.log(`   model.current  ${JSON.stringify(r.current)}`);
    console.log(`   available      ${r.available}`);
    console.log(`   catalog        ${r.providers} provider(s)`);
    try { child.kill(); } catch { /* gone */ }
    resolve();
  };
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
      if (String(m.id) === '1' || m.result || m.error) {
        const r = m.result ?? {};
        done({
          current: r.settings?.model?.current ?? m.error ?? null,
          available: r.settings?.model?.available?.length ?? 0,
          providers: r.modelCatalog?.providers?.length ?? 0,
        });
      }
    }
  });
  child.on('exit', () => done({ current: 'exited before answering', available: 0, providers: 0 }));
  child.stdin.write(`${JSON.stringify({ id: 1, method: 'workspace/readState', params: { workspace: { workspacePath: WS, workspaceKey: WS } } })}\n`);
  setTimeout(() => done({ current: 'timeout', available: 0, providers: 0 }), 25000);
});

// ── 2. a real turn ──────────────────────────────────────────────────────────
console.log('\n2. inference — one real headless turn:');
const out = await new Promise((resolve) => {
  const child = spawn(
    process.execPath,
    [RUNTIME, '-p', 'Reply with exactly: INFERENCE_OK', '--output-format', 'text', '--cwd', WS],
    { stdio: ['ignore', 'pipe', 'pipe'], cwd: WS, env },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const finish = (code) => resolve({ code, stdout, stderr });
  child.on('exit', (c) => finish(c));
  child.on('error', (e) => finish(`spawn failed: ${e.message}`));
  setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish('timeout after 120s'); }, 120000);
});

const text = String(out.stdout ?? '').trim();
console.log(`   exit           ${out.code}`);
if (text) {
  const tail = text.split(/\r?\n/).filter(Boolean).slice(-6).join('\n');
  console.log(`   reply (tail)   ${tail.slice(0, 700)}`);
} else {
  const e = String(out.stderr ?? '').split(/\r?\n/).filter((l) => /error|fail|missing/i.test(l)).slice(0, 4);
  console.log(`   stdout         (empty)`);
  if (e.length) console.log(`   stderr hits    ${e.join(' | ').slice(0, 400)}`);
}
console.log(`\n   ${text.includes('INFERENCE_OK') ? 'PROVEN — the model replied' : 'NOT PROVEN — no model reply in the output'}`);
