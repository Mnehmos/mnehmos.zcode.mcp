/**
 * End to end through the MCP: widen the runtime's model catalogue, then switch to a model it did not
 * have — the live model switch, with no respawn and no rebuild.
 *
 * The gate is enabled for this process only (`ZCODE_MCP_ALLOW_PROVIDER_EDIT=1`); it is off by default
 * because this action changes which models ZCode can reach. The workspace is a throwaway temp dir.
 *
 * Run: node .re/demo_live_switch.mjs
 */
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const WS = mkdtempSync(join(tmpdir(), 'zcode-live-'));

const block = JSON.parse(readFileSync(join(homedir(), '.zcode', 'cli', 'config.json'), 'utf8'))?.mcp?.servers?.zcode?.env ?? {};
const env = { ...process.env, ...block, ZCODE_MCP_ALLOW_PROVIDER_EDIT: '1' };
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

const listing = async (label) => {
  const r = await call('zcode_models', { action: 'available', workspace: WS });
  const s = r?.result?.workspace_settings ?? {};
  console.log(`${label} current=${s.current?.modelId}  available=${s.available_count} ${JSON.stringify((s.available ?? []).map((m) => m.label))}`);
};

async function run() {
  console.log(`workspace: ${WS}\n`);
  await listing('before  ');

  console.log('\nwiden the catalogue with a second model, through the tool');
  const up = await call('zcode_settings', {
    action: 'upsert_provider',
    workspace: WS,
    provider: {
      providerId: 'deepseek',
      kind: 'anthropic',
      baseURL: 'https://api.deepseek.com/anthropic',
      models: [{ modelId: 'deepseek-v4-flash' }, { modelId: 'deepseek-v4-pro' }],
    },
  });
  console.log(`  ok=${up?.ok}  read_back=${JSON.stringify(up?.read_back ?? null)}`);
  console.log(`  warnings=${JSON.stringify((up?.evidence?.warnings ?? []).map((w) => w.code))}  errors=${JSON.stringify(up?.evidence?.errors ?? [])}`);
  console.log(`  result=${JSON.stringify(up?.result)}`);

  await listing('\nafter   ');

  console.log('\nnow switch to a model the runtime did not have — no respawn, no rebuild');
  const sel = await call('zcode_models', { action: 'select', scope: 'server', model: 'deepseek/deepseek-v4-pro', workspace: WS });
  console.log(`  ok=${sel?.ok}  ${JSON.stringify(sel?.result)}  read_back=${JSON.stringify(sel?.read_back ?? null)}`);

  const turn = await call('zcode_chat', {
    action: 'send',
    workspace: WS,
    text: 'State only your own model id and nothing else.',
    collect: 'final',
    wait: true,
    wait_timeout_ms: 120_000,
  });
  console.log(`\nturn after the switch: ok=${turn?.ok} outcome=${turn?.result?.turn?.outcome} text=${JSON.stringify(turn?.result?.text)}`);
}

child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'demo', version: '1' } } })}\n`);
setTimeout(() => { console.log('timed out'); process.exit(1); }, 240_000);
