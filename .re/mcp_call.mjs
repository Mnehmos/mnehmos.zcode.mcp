/**
 * Call a tool on the real MCP server over stdio, with a controlled environment.
 *
 * This is the end-to-end proof for the registry fallback: start `dist/index.js` the way ZCode will,
 * with NO provider key in the environment, and ask for a tool that spawns a runtime. If the fallback
 * works, the runtime comes up with a real provider instead of `missing-model`.
 *
 * Going through the server rather than spawning the runtime directly is the whole point — the
 * fallback lives in the server's code, not in the runtime, which reads no config at all.
 *
 * Run: node .re/mcp_call.mjs <tool> <json-args> [--keep OPENROUTER_API_KEY,...]
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const [tool, argsJson] = process.argv.slice(2);
if (!tool) {
  console.error('usage: node .re/mcp_call.mjs <tool> <json-args>');
  process.exit(2);
}
const args = JSON.parse(argsJson ?? '{}');

// The environment ZCode would hand the server, minus any credential — unless the caller asks to keep
// one, which is how the "env still works" path gets tested too.
const regPath = join(homedir(), '.zcode', 'cli', 'config.json');
const block = JSON.parse(readFileSync(regPath, 'utf8'))?.mcp?.servers?.zcode?.env ?? {};
const env = { ...process.env, ...block };
for (const k of Object.keys(env)) if (/API_KEY|_TOKEN|_SECRET/i.test(k)) delete env[k];
const keep = (() => {
  const i = process.argv.indexOf('--keep');
  return i === -1 ? [] : process.argv[i + 1].split(',');
})();
for (const k of keep) if (process.env[k]) env[k] = process.env[k];
// Model/endpoint are not credentials; they must still be present for the registry match to work.
env.ZCODE_MCP_MODEL = block.ZCODE_MCP_MODEL;
env.ZCODE_MCP_BASE_URL = block.ZCODE_MCP_BASE_URL;

const dropped = Object.keys(block).filter((k) => !(k in env));
console.log(`tool        : ${tool}`);
console.log(`env keys    : ${Object.keys(env).filter((k) => k.startsWith('ZCODE_MCP')).sort().join(', ')}`);
console.log(`credential  : ${Object.keys(env).some((k) => /API_KEY|_TOKEN|_SECRET/i.test(k)) ? 'PRESENT' : 'none — testing the registry fallback'}`);
console.log(`not passed  : ${dropped.join(', ') || '(nothing dropped)'}\n`);

const child = spawn(process.execPath, ['dist/index.js'], { stdio: ['pipe', 'pipe', 'pipe'], env });
let buf = '';
const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
const finish = (code) => { try { child.kill(); } catch { /* gone */ } process.exit(code); };

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
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } });
    } else if (msg.id === 2) {
      const r = msg.result ?? {};
      const text = r.content?.[0]?.text ?? JSON.stringify(r);
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = null; }
      if (parsed) {
        // Print the parts that answer the question; never the whole envelope (it can be large).
        const pick = (o, keys) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));
        console.log(JSON.stringify({
          ok: parsed.ok,
          tool: parsed.tool,
          action: parsed.action,
          ...pick(parsed, ['read_back', 'payload_source']),
          evidence_warnings: (parsed.evidence?.warnings ?? []).map((w) => `${w.code}[${w.impact}] ${String(w.detail).slice(0, 200)}`),
          errors: parsed.evidence?.errors ?? parsed.errors ?? [],
          result: parsed.result,
        }, null, 2));
      } else {
        console.log(text.slice(0, 1500));
      }
      finish(parsed?.ok === false ? 1 : 0);
    } else if (msg.error) {
      console.log('server error:', JSON.stringify(msg.error).slice(0, 400));
      finish(1);
    }
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => {
  for (const l of String(d).split(/\r?\n/)) if (l.trim()) console.log(`[stderr] ${l.slice(0, 200)}`);
});
child.on('exit', (c) => { console.log(`server exited (${c}) before answering`); process.exit(1); });

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '1' } },
});
setTimeout(() => { console.log('no answer in 120s'); finish(1); }, 120_000);
