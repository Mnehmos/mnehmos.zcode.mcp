/**
 * Answer "is `.env` redundant?" without printing a single credential value.
 *
 * ZCode's own model management stores provider keys in `~/.zcode/v2/config.json` under
 * `provider.<id>.options.apiKey` (the same path tools/scan_secrets.py reads). If those values are
 * the same as the ones in this repo's `.env`, then `.env` is duplication and can go. If they are
 * different or absent, `.env` is the only copy of something live.
 *
 * Prints fingerprints (sha256 prefix) so equality is visible and the value is not.
 *
 * Run: node .re/where_are_the_keys.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MIN = 20;
const cfgPath = join(homedir(), '.zcode', 'v2', 'config.json');
const envPath = join(process.cwd(), '.env');

const fp = (v) =>
  !v || v.length < MIN ? `(absent or too short: ${v ? v.length : 0})` : `len=${v.length} sha256:${createHash('sha256').update(v).digest('hex').slice(0, 8)}`;

function zcodeProviders() {
  const out = {};
  if (!existsSync(cfgPath)) return { out, note: 'config.json not found' };
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    for (const [pid, prov] of Object.entries(cfg.provider ?? {})) {
      const key = prov?.options?.apiKey;
      if (typeof key === 'string' && key.length >= MIN) out[pid] = key;
    }
    return { out, note: `${Object.keys(cfg.provider ?? {}).length} provider(s) configured` };
  } catch (e) {
    return { out, note: `unreadable: ${e.message}` };
  }
}

function dotenv() {
  const out = {};
  if (!existsSync(envPath)) return out;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const v = m[2].trim().replace(/^["']|["']$/g, '');
    if (v.length >= MIN && /KEY|TOKEN|SECRET|PASSWORD/.test(m[1])) out[m[1]] = v;
  }
  return out;
}

function agentEnv() {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string' && v.length >= MIN && /KEY|TOKEN|SECRET|PASSWORD/i.test(k)) out[k] = v;
  }
  return out;
}

const z = zcodeProviders();
const dot = dotenv();
const agent = agentEnv();

console.log('=== where each credential lives ===');
console.log(`\nZCode's own provider config (${cfgPath})`);
console.log(`  ${z.note}`);
for (const [pid, key] of Object.entries(z.out)) console.log(`  ${pid.padEnd(24)} ${fp(key)}`);
if (!Object.keys(z.out).length) console.log('  (no apiKey entries)');

console.log(`\n${envPath}`);
for (const [n, v] of Object.entries(dot)) console.log(`  ${n.padEnd(24)} ${fp(v)}`);
if (!Object.keys(dot).length) console.log('  (absent, or holds no key-shaped values)');

console.log('\nagent environment (what ZCode hands this server)');
for (const [n, v] of Object.entries(agent)) console.log(`  ${n.padEnd(24)} ${fp(v)}`);
if (!Object.keys(agent).length) console.log('  (no key-shaped values)');

// Cross-reference by fingerprint so "same key under a different name" is visible.
console.log('\n=== relationships ===');
const byFp = (obj) => {
  const m = new Map();
  for (const [name, v] of Object.entries(obj)) {
    const h = createHash('sha256').update(v).digest('hex').slice(0, 8);
    if (!m.has(h)) m.set(h, []);
    m.get(h).push(name);
  }
  return m;
};
const all = [['zcode-config', z.out], ['dotenv', dot], ['agent-env', agent]];
for (const [labelA, a] of all) {
  const ma = byFp(a);
  for (const [labelB, b] of all) {
    if (labelA >= labelB) continue;
    const mb = byFp(b);
    const shared = [...ma.keys()].filter((h) => mb.has(h));
    const line = shared.length
      ? shared.map((h) => `      ${ma.get(h).join(',')} == ${mb.get(h).join(',')}  [sha256:${h}]`).join('\n')
      : '      none shared';
    console.log(`  ${labelA} vs ${labelB}:\n${line}`);
  }
}
console.log('\n  A credential present ONLY in .env is the only copy on record here.');
