// Minimal ZCode Protocol probe: spawn `zcode.cjs app-server --stdio`,
// send NDJSON request(s), print every line received.
// Usage: node probe.js [--timeout ms] [--cwd dir] [--settings file] [-- {json} ...]
import { spawn } from 'node:child_process';
import process from 'node:process';

const argv = process.argv.slice(2);
function opt(name, def) {
  const i = argv.indexOf(name);
  return i === -1 ? def : argv[i + 1];
}
const args = argv.includes('--') ? argv.slice(argv.indexOf('--') + 1) : [];
const timeoutMs = Number(opt('--timeout', 25000));
const cwd = opt('--cwd', process.cwd());
const settings = opt('--settings', null);
const runtime = opt('--runtime', process.env.ZCODE_CLI ||
  'E:/zcode/resources/glm/zcode.cjs');

const child = spawn(process.execPath, [runtime, 'app-server', '--stdio', '--cwd', cwd,
  ...(settings ? ['--settings', settings] : [])], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd,
  env: { ...process.env, ZCODE_SURFACE: 'desktop' },
});

const started = Date.now();
const stamp = () => `+${String(Date.now() - started).padStart(6)}ms`;

child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
let buf = '';
child.stdout.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).replace(/\r$/, '');
    buf = buf.slice(nl + 1);
    if (line.trim()) console.log(`${stamp()} OUT ${line}`);
  }
});
child.stderr.on('data', (d) => {
  for (const l of String(d).split(/\r?\n/)) if (l.trim()) console.log(`${stamp()} ERR ${l}`);
});
child.on('exit', (code, sig) => console.log(`${stamp()} EXIT code=${code} sig=${sig}`));

for (const raw of args) {
  const msg = JSON.parse(raw);
  console.log(`${stamp()} >>> ${JSON.stringify(msg)}`);
  child.stdin.write(`${JSON.stringify(msg)}\n`);
}

setTimeout(() => {
  console.log(`${stamp()} probing done; terminating`);
  child.kill();
  setTimeout(() => process.exit(0), 500);
}, timeoutMs);
