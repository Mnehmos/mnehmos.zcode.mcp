/**
 * Can we widen a runtime's catalogue at runtime, so models can be switched live?
 *
 * A spawned runtime gets one model from the environment, so its catalogue has one entry and
 * `select scope=session` has nothing to switch TO. ZCode's own desktop manages this by having its
 * host push the provider registry (`workspace/upsertModelProvider`) — we are not the host, and our
 * own code warns that the catalogue "may not change here". This measures whether it does.
 *
 * Run: node .re/probe_upsert.mjs
 */
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const WS = mkdtempSync(join(tmpdir(), 'zcode-upsert-'));
const SECOND = 'deepseek-v4-flash';

const block = JSON.parse(readFileSync(join(homedir(), '.zcode', 'cli', 'config.json'), 'utf8'))?.mcp?.servers?.zcode?.env ?? {};
const env = { ...process.env, ...block };
// The gate is off by default. Enabled ONLY here, in a throwaway temp workspace, to find out whether
// the protocol method works at all — which is the question this probe exists to answer.
env.ZCODE_MCP_ALLOW_PROVIDER_EDIT = '1';
for (const k of Object.keys(env)) if (/API_KEY|_TOKEN|_SECRET/i.test(k)) delete env[k];

const child = spawn(process.execPath, ['dist/index.js'], { stdio: ['pipe', 'pipe', 'pipe'], env });
let buf = '';
let nextId = 2;
const pending = new Map();
let started = false;

const call = (tool, args) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool, arguments: args } })}\n`);
  });

child.stdout.setEncoding('utf8');
child.stdout.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === 1 && !started) {
      started = true;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      run().then(() => { try { child.kill(); } catch { /* gone */ } process.exit(0); });
    } else if (msg.id && pending.has(msg.id)) {
      const r = msg.result ?? {};
      const text = r.content?.[0]?.text ?? JSON.stringify(r);
      try { pending.get(msg.id)(JSON.parse(text)); } catch { pending.get(msg.id)({ raw: text }); }
      pending.delete(msg.id);
    }
  }
});
child.on('exit', (c) => { console.log(`server exited (${c})`); process.exit(1); });

const catalogue = async (label) => {
  const r = await call('zcode_models', { action: 'available', workspace: WS });
  const s = r?.result?.workspace_settings ?? {};
  console.log(`${label}  providers=${r?.result?.provider_registry?.provider_count}  available=${s.available_count}  ${JSON.stringify((s.available ?? []).map((m) => m.label))}`);
  return s;
};

async function run() {
  console.log(`workspace: ${WS}\n`);
  await catalogue('baseline                  ');

  console.log(`\nupsert a provider declaring ${SECOND} ...`);
  const up = await call('zcode_settings', {
    action: 'upsert_provider',
    workspace: WS,
    provider: {
      providerId: 'deepseek',
      kind: 'anthropic',
      baseURL: 'https://api.deepseek.com/anthropic',
      models: [{ modelId: SECOND }, { modelId: 'deepseek-v4-pro' }],
    },
  });
  console.log(`  ok=${up?.ok}  result=${JSON.stringify(up?.result)}`);
  console.log(`  errors=${JSON.stringify(up?.evidence?.errors ?? [])}`);
  console.log(`  methods=${JSON.stringify((up?.diagnostics?.methods ?? []).map((m) => m.method + ':' + m.ok + (m.error ? ' ' + m.error.slice(0,80) : '')))}`);
  console.log(`  warnings=${JSON.stringify((up?.evidence?.warnings ?? []).map((w) => `${w.code}: ${String(w.detail).slice(0, 110)}`))}`);

  await catalogue('\nafter upsert              ');

  console.log(`\ncan a session now switch to ${SECOND}?`);
  const sel = await call('zcode_models', { action: 'select', scope: 'server', model: `deepseek/${SECOND}`, workspace: WS });
  console.log(`  server scope ok=${sel?.ok}  ${JSON.stringify(sel?.errors ?? [])}`);
}

child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } })}\n`);
setTimeout(() => { console.log('timed out'); process.exit(1); }, 180_000);
