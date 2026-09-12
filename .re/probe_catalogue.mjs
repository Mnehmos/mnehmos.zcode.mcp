/**
 * After a server-scope model switch, what does a freshly spawned runtime actually OFFER?
 *
 * The distinction that matters: the runtime's config layer (`settings.model.current`) reports the
 * model we injected, while the catalogue a session draws from (`settings.model.available`) reports
 * what the runtime believes it can call. When those disagree, a switch looks applied and a turn runs
 * on the old model — which is what the demo showed.
 *
 * Run: node .re/probe_catalogue.mjs [targetModel] [workspaceDir]
 */
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const TO = process.argv[2] ?? 'deepseek/deepseek-v4-pro';
const WS = process.argv[3] ?? mkdtempSync(join(tmpdir(), 'zcode-cat-'));

const block = JSON.parse(readFileSync(join(homedir(), '.zcode', 'cli', 'config.json'), 'utf8'))?.mcp?.servers?.zcode?.env ?? {};
const env = { ...process.env, ...block };
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

async function run() {
  console.log(`target: ${TO}`);
  console.log(`fresh workspace: ${WS}\n`);

  console.log('BEFORE any switch, in a fresh workspace:');
  const before = await call('zcode_models', { action: 'available', workspace: WS });
  const b = before?.result?.workspace_settings ?? {};
  console.log(`  provider_count=${before?.result?.provider_registry?.provider_count}`);
  console.log(`  current=${JSON.stringify(b.current)}`);
  console.log(`  available_count=${b.available_count}  ${JSON.stringify((b.available ?? []).map((m) => m.label))}`);

  console.log(`\nswitch scope=server -> ${TO}`);
  const sel = await call('zcode_models', { action: 'select', scope: 'server', model: TO, workspace: WS });
  console.log(`  ok=${sel?.ok}  ${JSON.stringify(sel?.result)}`);

  console.log('\nAFTER the switch, in a NEW fresh workspace (a new runtime):');
  const WS2 = mkdtempSync(join(tmpdir(), 'zcode-cat2-'));
  const after = await call('zcode_models', { action: 'available', workspace: WS2 });
  const a = after?.result?.workspace_settings ?? {};
  console.log(`  provider_count=${after?.result?.provider_registry?.provider_count}`);
  console.log(`  current=${JSON.stringify(a.current)}`);
  console.log(`  available_count=${a.available_count}  ${JSON.stringify((a.available ?? []).map((m) => m.label))}`);
  console.log(`\n  ${JSON.stringify(a.current)?.includes(TO.split('/')[1]) ? 'the runtime reports the new model' : 'the runtime reports something else'}`);
}

child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } })}\n`);
setTimeout(() => { console.log('timed out'); process.exit(1); }, 240_000);
