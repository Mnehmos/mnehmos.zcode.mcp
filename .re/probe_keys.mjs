/**
 * Verify every provider credential WITHOUT printing it, testing each SOURCE separately.
 *
 * Testing "process env ?? .env" hides the interesting case: when the two disagree, one of them is
 * stale and the combined test only reports on the winner. Each candidate is checked on its own.
 *
 * Prints a fingerprint (length + short sha256 prefix) so values can be compared mechanically
 * without exposing them, then asks the provider whether the key authenticates. The credential goes
 * only to its own issuer.
 *
 * Run: node .re/probe_keys.mjs
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const ENV_FILE = '.env';
const TARGETS = [
  { name: 'OPENROUTER_API_KEY', url: 'https://openrouter.ai/api/v1/key' },
  { name: 'DEEPSEEK_API_KEY', url: 'https://api.deepseek.com/user/balance' },
  { name: 'ZAI_API_KEY', url: 'https://api.z.ai/api/paas/v4/models' },
];

function fp(v) {
  if (!v) return '(absent)';
  const h = createHash('sha256').update(v).digest('hex').slice(0, 8);
  return `len=${v.length} sha256:${h} prefix=${v.slice(0, 6)}…`;
}

function fromDotenv(name) {
  try {
    for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (m && m[1] === name) return m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env is a valid state */ }
  return undefined;
}

/** Strip anything that could be a credential before printing. A provider is free to echo the key
 *  back in an error body, and this script exists precisely to produce output a human will read. */
function scrub(text, key) {
  let out = key ? text.split(key).join('<redacted>') : text;
  return out.replace(/\b(sk|or|zai)-[A-Za-z0-9_\-]{8,}/gi, '<redacted>');
}

async function check(label, key, url) {
  if (!key) {
    console.log(`  ${label}: (absent) — skipped`);
    return;
  }
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    const body = await r.text();
    let detail = body.slice(0, 200);
    try {
      const j = JSON.parse(body);
      detail = JSON.stringify(j.data ?? j.error ?? j).slice(0, 200);
    } catch { /* not JSON */ }
    const verdict = r.ok ? 'LIVE' : 'DEAD';
    console.log(`  ${label}: ${verdict} — HTTP ${r.status} :: ${scrub(detail, key)}`);
  } catch (e) {
    console.log(`  ${label}: request failed — ${scrub(e.message, key)}`);
  }
}

for (const t of TARGETS) {
  const inProc = process.env[t.name];
  const inFile = fromDotenv(t.name);
  const distinct = inProc && inFile && inProc !== inFile;

  console.log(`=== ${t.name} ===`);
  console.log(`  process env : ${fp(inProc)}`);
  console.log(`  .env file   : ${fp(inFile)}`);
  console.log(`  ${distinct ? 'DISAGREE — one of these is stale' : 'agree'}`);
  await check('process env', inProc, t.url);
  if (distinct) await check('.env file  ', inFile, t.url);
  console.log('');
}
