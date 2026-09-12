/**
 * Validate the REAL server's `tools/list` response, over stdio, with a client's own validator.
 *
 * The unit test checks the data the handler builds. This checks the bytes that come back — the same
 * thing ZCode rejected with `Invalid input: expected "object"` at `tools[n].inputSchema.type`. A
 * handler that is correct while the wire format is wrong would pass the first and fail here.
 *
 * Run: node .re/verify_tools_list.mjs
 */
import { spawn } from 'node:child_process';
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';

const child = spawn(process.execPath, ['dist/index.js'], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);

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

    if (msg.id === 1) {
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    } else if (msg.id === 2) {
      const tools = msg.result?.tools ?? [];
      console.log(`tools/list returned ${tools.length} tool(s)`);

      const missing = tools.filter((t) => t.inputSchema?.type !== 'object').map((t) => t.name);
      console.log(`root type !== "object": ${missing.length ? missing.join(', ') : 'none'}`);

      const r = ListToolsResultSchema.safeParse(msg.result);
      if (r.success) {
        console.log('\nSDK validator: ACCEPTED — a conforming client will load these tools');
      } else {
        console.log(`\nSDK validator: REJECTED with ${r.error.issues.length} issue(s)`);
        for (const i of r.error.issues.slice(0, 8)) console.log(`   ${i.path.join('.')} — ${i.message}`);
      }
      const unions = tools.filter((t) => Array.isArray(t.inputSchema?.anyOf)).length;
      console.log(`unions preserved: ${unions} of ${tools.length} (the other ${tools.length - unions} are plain objects)`);
      try { child.kill(); } catch { /* gone */ }
      process.exit(r.success ? 0 : 1);
    }
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => {
  for (const l of String(d).split(/\r?\n/)) if (l.trim() && !/ExperimentalWarning|trace-warnings/.test(l)) console.log(`[stderr] ${l.slice(0, 160)}`);
});
child.on('exit', (c) => { console.log(`server exited (${c}) before answering`); process.exit(1); });

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } });
setTimeout(() => { console.log('no answer in 60s'); process.exit(1); }, 60_000);
