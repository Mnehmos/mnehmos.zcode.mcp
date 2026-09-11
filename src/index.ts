#!/usr/bin/env node
/**
 * mnehmos.zcode.mcp — ZCode's agent runtime as a bounded semantic control surface.
 *
 * Doctrine mapping (vibe-coders-bible):
 *  - ch.8  elimination: no UI automation, no direct SQLite writes, no writing ZCode's credential
 *          store, no unbounded protocol surface by default
 *  - ch.9  substitution: a bounded set of typed tools with discriminated-union actions replaces
 *          "send raw JSON to ZCode"; the raw call survives as an explicit, gated escape hatch
 *  - ch.10 engineering controls: zod validates before a process is touched; the protocol catalog
 *          gates the vocabulary against the installed runtime
 *  - ch.14 the repo is the memory: one audit row per call, every artifact kept with a hash
 *  - ch.16 schemas are contracts: an invalid action costs zero process starts
 *  - ch.25 the model narrates, the runtime rules: every mutation is read back before it is
 *          reported
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { fileURLToPath } from 'node:url';

import { discoverRuntime, discoveryFailure, ensureDirs, loadEnv, resolveNode } from './schema/env.js';
import { ServerContext } from './context.js';
import type { Envelope } from './envelope.js';
import { localEnvelope } from './envelope.js';
import { statusDispatch } from './zcode/actions/status.js';
import { sessionDispatch } from './zcode/actions/session.js';
import { chatDispatch } from './zcode/actions/chat.js';
import { approvalDispatch } from './zcode/actions/approval.js';
import { createTransport } from './zcode/transport.js';
import { TOOL_REGISTRY } from './schema/tools.js';
import * as path from 'node:path';
import * as fs from 'node:fs';

const VERSION = (() => {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const p = path.resolve(here, '..', 'package.json');
    return (JSON.parse(fs.readFileSync(p, 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/**
 * The self-test is the smoke gate. It exercises the one thing the whole design rests on —
 * that we can spawn a ZCode agent runtime and get real data back — and then proves we cleaned
 * up after ourselves. It runs no model turn, so it costs nothing.
 */
async function selfTest(): Promise<number> {
  const log = (s: string) => process.stdout.write(`${s}\n`);
  let failures = 0;
  const check = (name: string, ok: boolean, detail = '') => {
    log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
    if (!ok) failures++;
  };

  log(`mnehmos.zcode.mcp ${VERSION} — self-test\n`);

  log('environment');
  let env;
  try {
    env = loadEnv();
    check('environment contract parses', true);
  } catch (err) {
    check('environment contract parses', false, err instanceof Error ? err.message : String(err));
    return 1;
  }
  const dirs = ensureDirs(env);
  check('work directories created', fs.existsSync(dirs.wire) && fs.existsSync(dirs.reports), dirs.work);

  log('\nruntime discovery');
  const discovery = discoverRuntime();
  check('agent runtime found', discovery.cli !== null, discovery.source ?? 'not found');
  if (!discovery.cli) {
    log(`\n${discoveryFailure(discovery)}`);
    return 1;
  }
  check('runtime is a file', fs.statSync(discovery.cli).isFile(), discovery.cli);
  const node = resolveNode();
  check('node resolved', fs.existsSync(node), node);
  check('tool registry loaded', TOOL_REGISTRY.length > 0, `${TOOL_REGISTRY.length} tools`);

  log('\ncontrol plane');
  const scratch = path.join(dirs.work, 'scratch');
  fs.mkdirSync(scratch, { recursive: true });
  const t = createTransport({
    cli: discovery.cli,
    node,
    cwd: scratch,
    runId: `self-test-${Date.now()}`,
    wireDir: dirs.wire,
    stderrDir: dirs.stderr,
  });

  try {
    const reply = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no reply within 45 s')), 45_000);
      t.on('message', (m: { kind: string; id?: unknown; result?: unknown }) => {
        if (m.kind === 'result' && String(m.id) === '1') {
          clearTimeout(timer);
          resolve(m.result);
        }
      });
      t.send({ id: 1, method: 'session/list', params: {} }).catch(reject);
    });

    const sessions = (reply as { sessions?: unknown[] }).sessions;
    check('session/list answered', Array.isArray(sessions), `${sessions?.length ?? 0} session(s)`);

    const first = (sessions ?? [])[0] as Record<string, unknown> | undefined;
    if (first) {
      check('session shape is as documented', 'sessionId' in first && 'workspace' in first);
    } else {
      log('  NOTE  no sessions on this machine; shape check skipped');
    }
  } catch (err) {
    check('session/list answered', false, err instanceof Error ? err.message : String(err));
    const tail = t.stderrLines.slice(-5);
    for (const l of tail) log(`        stderr: ${l}`);
  }

  log('\nprocess hygiene');
  const pid = t.pid;
  await t.disposeAndWait(5_000);
  await new Promise((r) => setTimeout(r, 400));
  check('child reaped, no orphans', !t.alive);

  fs.rmSync(scratch, { recursive: true, force: true });

  log(`\n${failures === 0 ? 'self-test OK' : `self-test FAILED (${failures})`}${pid ? `  [last pid ${pid}]` : ''}`);
  return failures === 0 ? 0 : 1;
}

async function serve(): Promise<void> {
  const env = loadEnv();
  const ctx = new ServerContext(env);
  const log = (s: string) => process.stderr.write(`${s}\n`);

  if (ctx.dbError) log(`warning: ${ctx.dbError} — calls will not be recorded`);

  const server = new Server(
    { name: 'mnehmos.zcode.mcp', version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_REGISTRY.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.schema, { $refStrategy: 'none' }) as {
        type: 'object';
        [k: string]: unknown;
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = TOOL_REGISTRY.find((t) => t.name === req.params.name);
    if (!tool) throw new Error(`unknown tool: ${req.params.name}`);

    const parsed = tool.schema.safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      // Schema-level refusal: no process is touched, which is the point of validating here.
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      const envelope = localEnvelope({ tool: tool.name, action: actionOf(req.params.arguments) }, null, {
        ok: false,
        errors: [`invalid arguments — ${issues}`],
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(envelope, null, 2) }], isError: true };
    }

    const args = parsed.data as Record<string, unknown>;

    try {
      const envelope = await dispatch(ctx, tool.name, args);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(envelope, null, 2) }],
        // An envelope that reports ok:false is a tool error even though the call succeeded.
        ...(envelope.ok ? {} : { isError: true }),
      };
    } catch (err) {
      const envelope = localEnvelope({ tool: tool.name, action: actionOf(args) }, null, {
        ok: false,
        errors: [err instanceof Error ? err.message : String(err)],
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(envelope, null, 2) }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`mnehmos.zcode.mcp ${VERSION} listening on stdio (${TOOL_REGISTRY.length} tools)`);

  const shutdown = async (why: string) => {
    log(`shutting down (${why})`);
    await ctx.dispose();
  };
  process.on('SIGINT', () => void shutdown('SIGINT').then(() => process.exit(0)));
  process.on('SIGTERM', () => void shutdown('SIGTERM').then(() => process.exit(0)));
}

function actionOf(args: unknown): string {
  return args && typeof args === 'object' && 'action' in args && typeof (args as { action: unknown }).action === 'string'
    ? (args as { action: string }).action
    : 'unknown';
}

/**
 * Route to a dispatcher. Tools without one refuse clearly rather than pretending — the build order
 * is in specs/001-zcode-control/tasks.md.
 */
async function dispatch(ctx: ServerContext, tool: string, args: Record<string, unknown>): Promise<Envelope> {
  switch (tool) {
    case 'zcode_status':
      return statusDispatch(ctx, args);
    case 'zcode_session':
      return sessionDispatch(ctx, args);
    case 'zcode_chat':
      return chatDispatch(ctx, args);
    case 'zcode_approval':
      return approvalDispatch(ctx, args);
    default:
      return localEnvelope({ tool, action: actionOf(args) }, null, {
        ok: false,
        errors: [
          `tool '${tool}' is declared but not yet implemented. ` +
            'Implemented: zcode_status, zcode_session, zcode_chat, zcode_approval. ' +
            'See specs/001-zcode-control/tasks.md for the build order.',
        ],
      });
  }
}

const arg = process.argv[2];
if (arg === '--self-test') {
  selfTest()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`self-test crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
      process.exit(1);
    });
} else if (arg === '--version' || arg === '-v') {
  process.stdout.write(`${VERSION}\n`);
} else {
  serve().catch((err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}
