/**
 * Which DeepSeek key is live? Tests every candidate against the provider, prints no values.
 *
 * A key can be present, correct-looking, and revoked — the earlier read of `.env`'s DeepSeek key
 * returned HTTP 200 with a real balance, and the same value now returns 401. Presence is not
 * liveness, so ask the issuer.
 *
 * Also validates the configured model name: the id in ZCODE_MCP_MODEL carries an `expires-on-0910`
 * suffix, and if the deployment is gone the key is irrelevant.
 *
 * Run: node .re/probe_deepseek_live.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const fp = (v) => `len=${v.length} sha256:${createHash('sha256').update(v).digest('hex').slice(0, 8)} ends=${v.slice(-4)}`;

function candidates() {
  const out = [];
  const envPath = join(process.cwd(), '.env');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (m && /DEEPSEEK_API_KEY/.test(m[1])) {
        out.push([`.env ${m[1]}`, m[2].trim().replace(/^["']|["']$/g, '')]);
      }
    }
  }
  const cfg = join(homedir(), '.zcode', 'v2', 'config.json');
  if (existsSync(cfg)) {
    try {
      const c = JSON.parse(readFileSync(cfg, 'utf8'));
      for (const [pid, prov] of Object.entries(c.provider ?? {})) {
        const k = prov?.options?.apiKey;
        if (typeof k === 'string' && k.length >= 20) out.push([`zcode config ${pid}`, k]);
      }
    } catch { /* unreadable config is reported as "no candidates" */ }
  }
  const seen = new Set();
  return out.filter(([, v]) => (seen.has(v) ? false : (seen.add(v), true)));
}

const model = (() => {
  try {
    const line = readFileSync(join(process.cwd(), '.env'), 'utf8').split(/\r?\n/).find((l) => l.startsWith('ZCODE_MCP_MODEL'));
    return (line ?? '').split('=')[1]?.trim().replace(/^[^/]*\//, '') ?? '';
  } catch { return ''; }
})();

console.log(`configured model: ${model || '(unknown)'}\n`);

for (const [label, key] of candidates()) {
  process.stdout.write(`${label.padEnd(46)} ${fp(key)}\n`);
  // 1. does it authenticate at all?
  let live = false;
  try {
    const r = await fetch('https://api.deepseek.com/user/balance', { headers: { Authorization: `Bearer ${key}` } });
    const body = await r.text();
    let note = body.slice(0, 90);
    try { note = JSON.stringify(JSON.parse(body).balance_infos ?? JSON.parse(body).error).slice(0, 90); } catch { /* raw */ }
    live = r.ok;
    console.log(`    balance : ${r.ok ? 'LIVE' : 'DEAD'}  ${note}`);
  } catch (e) {
    console.log(`    balance : request failed — ${e.message}`);
  }
  if (!live) { console.log(''); continue; }

  // 2. the configured model name is the other half of "can it infer".
  if (model) {
    try {
      const r = await fetch('https://api.deepseek.com/anthropic/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      });
      const t = await r.text();
      const verdict = r.ok ? 'WORKS' : 'REJECTED';
      console.log(`    model   : ${verdict} (${r.status}) ${t.slice(0, 160)}`);
    } catch (e) {
      console.log(`    model   : request failed — ${e.message}`);
    }
  }
  console.log('');
}
