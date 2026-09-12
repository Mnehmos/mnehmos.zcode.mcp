/**
 * Call every PUBLISHED tool and confirm it reaches a dispatcher.
 *
 * The check that would have caught `zcode_command`: it was advertised in `tools/list` while no
 * dispatcher existed, so every call returned `unknown tool`. Validation errors are fine — they prove
 * the call reached the tool's own schema. `unknown tool` means nothing is wired behind the name.
 *
 * Arguments are deliberately empty, so anything that would mutate is rejected by its own schema
 * before it can. Nothing here changes state.
 *
 * Run: node .re/verify_dispatch_coverage.mjs
 */
import { spawn } from 'node:child_process';
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';

const child = spawn(process.execPath, ['dist/index.js'], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
let nextId = 2;
const pending = new Map();
let started = false;

const call = (name, args) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`);
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
      run();
    } else if (msg.id && pending.has(msg.id)) {
      const r = msg.result ?? {};
      const text = r.content?.[0]?.text ?? JSON.stringify(r);
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
      pending.get(msg.id)(parsed);
      pending.delete(msg.id);
    }
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', () => { /* logs only */ });
child.on('exit', (c) => { console.log(`server exited (${c})`); process.exit(1); });

async function run() {
  const listing = await new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' })}\n`);
  });
  const tools = listing?.tools ?? [];
  const schema = ListToolsResultSchema.safeParse(listing);
  console.log(`tools/list -> ${tools.length} tools, SDK validator: ${schema.success ? 'ACCEPTED' : 'REJECTED'}\n`);

  let unwired = 0;
  for (const t of tools) {
    const r = await call(t.name, {});
    const errors = (r?.evidence?.errors ?? []).map(String);
    const unknown = errors.some((e) => e.includes('unknown tool'));
    if (unknown) unwired++;
    const detail = unknown
      ? 'NOT WIRED — reachable in the list, nothing behind it'
      : errors.length
        ? `dispatched (schema refused the empty call): ${errors[0].slice(0, 90)}`
        : 'dispatched';
    console.log(`  ${unknown ? 'FAIL' : 'ok  '}  ${t.name.padEnd(20)} ${detail}`);
  }

  console.log(`\n${unwired === 0 ? 'every published tool reaches a dispatcher' : `${unwired} tool(s) advertised with nothing behind them`}`);
  try { child.kill(); } catch { /* gone */ }
  process.exit(unwired === 0 && schema.success ? 0 : 1);
}

child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } })}\n`);
setTimeout(() => { console.log('timed out'); process.exit(1); }, 180_000);
