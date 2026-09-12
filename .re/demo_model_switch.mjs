/**
 * Demonstrate switching models through the MCP, with the model itself as the read-back.
 *
 * What this proves, in order:
 *   1. the current model, read from the runtime
 *   2. a switch to a different model (scope "server" — the default for runtimes spawned from now on)
 *   3. a real turn in a FRESH workspace, whose transcript records which model answered, plus the
 *      model's own answer when asked to identify itself
 *   4. a switch back, so nothing is left changed
 *
 * A fresh workspace is required for step 3: the registry reuses one runtime per workspace, and an
 * already-running runtime keeps the model it was spawned with. That is a real limit, not a
 * workaround — it is why the switch is scoped to *newly spawned* runtimes.
 *
 * One MCP server process throughout, because the server-scoped default lives in that process.
 *
 * Run: node .re/demo_model_switch.mjs
 */
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { join } from 'node:path';

const A = 'F:/Github/mcp/mnehmos.zcode.mcp'; // has a live runtime already
const B = join(tmpdir(), 'zcode-switch-demo'); // OUTSIDE the repo: a subdirectory resolves to the same workspace
const FROM = 'deepseek/deepseek-v4.1-flash-expires-on-0910';
const TO = process.argv[2] ?? 'deepseek/deepseek-v4-pro';

mkdirSync(B, { recursive: true });

const block = JSON.parse(readFileSync(join(homedir(), '.zcode', 'cli', 'config.json'), 'utf8'))?.mcp?.servers?.zcode?.env ?? {};
const env = { ...process.env, ...block };
// No credential in the environment: the registry fallback supplies it.
for (const k of Object.keys(env)) if (/API_KEY|_TOKEN|_SECRET/i.test(k)) delete env[k];

const child = spawn(process.execPath, ['dist/index.js'], { stdio: ['pipe', 'pipe', 'pipe'], env });
let buf = '';
let nextId = 2; // 1 is the initialize handshake
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
child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => {
  for (const l of String(d).split(/\r?\n/)) if (l.trim() && !/Experimental|trace-warnings/.test(l)) console.log(`  [stderr] ${l.slice(0, 140)}`);
});
child.on('exit', (c) => { console.log(`server exited (${c})`); process.exit(1); });

const warns = (e) => (e?.evidence?.warnings ?? []).map((w) => w.code).join(',') || 'none';
const errs = (e) => (e?.evidence?.errors ?? []).map((s) => String(s).slice(0, 130));

/** The assistant's own record of which model it used. */
async function transcriptModel(sessionHint) {
  const convo = await call('zcode_conversation', { action: 'messages', session_id: sessionHint });
  const msgs = convo?.result?.messages ?? [];
  const last = [...msgs].reverse().find((m) => m?.info?.role === 'assistant');
  return { model: last?.info?.modelID ?? null, provider: last?.info?.providerID ?? null, count: msgs.length };
}

async function run() {
  console.log(`switch: ${FROM}  ->  ${TO}\n`);

  console.log('1. current model, read from the runtime');
  const before = await call('zcode_models', { action: 'current', workspace: A });
  console.log(`   ok=${before?.ok}  model=${JSON.stringify(before?.result?.model)}`);

  console.log(`\n2. switch the server default to ${TO}`);
  const sel = await call('zcode_models', { action: 'select', scope: 'server', model: TO, workspace: A });
  console.log(`   ok=${sel?.ok}  warnings=[${warns(sel)}]  errors=${JSON.stringify(errs(sel))}`);
  console.log(`   result: ${JSON.stringify(sel?.result)}`);

  console.log(`\n2b. what does a runtime in the fresh workspace report NOW?`);
  const bcur = await call('zcode_models', { action: 'current', workspace: B });
  console.log(`   ok=${bcur?.ok}  workspace_key=${bcur?.result?.workspace_key}`);
  console.log(`   model=${JSON.stringify(bcur?.result?.model)}`);

  console.log(`\n3. a real turn in a fresh workspace (${B}) — this is the proof`);
  const turn = await call('zcode_chat', {
    action: 'send',
    workspace: B,
    text: 'State only your own model id and nothing else.',
    collect: 'final',
    wait: true,
    wait_timeout_ms: 120_000,
  });
  const session = turn?.result?.session_id;
  console.log(`   ok=${turn?.ok}  outcome=${turn?.result?.turn?.outcome}  text=${JSON.stringify(turn?.result?.text)}`);
  console.log(`   warnings=[${warns(turn)}]`);
  if (errs(turn).length) console.log(`   errors=${JSON.stringify(errs(turn))}`);

  if (session) {
    const t = await transcriptModel(session);
    console.log(`   transcript says: modelID=${t.model}  providerID=${t.provider}`);
  }

  console.log(`\n4. switch back to ${FROM}`);
  const back = await call('zcode_models', { action: 'select', scope: 'server', model: FROM, workspace: A });
  console.log(`   ok=${back?.ok}  result: ${JSON.stringify(back?.result)}`);
}

child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'demo', version: '1' } } })}\n`);
setTimeout(() => { console.log('timed out'); process.exit(1); }, 300_000);
