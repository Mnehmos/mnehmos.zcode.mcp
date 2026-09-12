/**
 * The tool/action contract. One zod discriminated union per tool.
 *
 * Constitution Article III: an invalid action is rejected here, before any process is spawned,
 * so a malformed call costs zero child processes.
 *
 * Vocabulary rules:
 *   - closed enums, bounded numbers, bounded arrays — no free-form code
 *   - `workspace` is a path or a workspaceKey obtained from ZCode; never synthesised
 *   - exactly one scheduling form for automations, one image source for attachments
 *
 * Tool descriptions carry known hazards, because a hazard disclosed only in the README is a
 * hazard the model calling us will not see (FR-045).
 */
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

// ── shared vocabulary ────────────────────────────────────────────────────────

export const Mode = z.enum(['plan', 'build', 'edit', 'yolo', 'auto']);
export const Range = z.enum(['all', '7d', '30d']);

/** A workspace path or a workspaceKey previously returned by ZCode. */
/**
 * A workspace path or key. Optional everywhere: `ZCODE_MCP_WORKSPACE` supplies a default, and
 * requiring it in the schema would reject calls this server can serve. When neither is available
 * the tool refuses with an explicit message rather than guessing.
 */
const Workspace = z.string().trim().min(1).optional();
const SessionId = z.string().trim().min(1).describe('A sessionId from zcode_session list, e.g. sess_…');
/**
 * Conversation row ids are NUMBERS — `rowsRange` returns `rowId: 1`, and passing the string
 * "1" to fileChanges is rejected with `expected number`. A numeric string is coerced rather
 * than refused, because a caller copying an id out of JSON-as-text is a reasonable mistake.
 */
const RowId = z.coerce.number().int().nonnegative();

/** Bounded integers, per the protocol's own limits. */
const Limit200 = z.number().int().min(1).max(200);
const Limit2000 = z.number().int().min(1).max(2000);

const Attachment = z.object({
  path: z.string().min(1).optional().describe('Local file to upload; the server stages it via the attachment path.'),
  ref: z.string().min(1).optional().describe('An already-staged attachment ref from zcode_files put_attachment.'),
  mime: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
}).refine((a) => a.path !== undefined || a.ref !== undefined, {
  message: 'an attachment needs either path or ref',
});

const Guard = z.object({ confirm: z.literal(true) }).describe('Required for destructive actions.');

// ── zcode_status ─────────────────────────────────────────────────────────────

export const StatusArgs = z.discriminatedUnion('action', [
  z.object({ action: z.literal('runtimes') }),
  z.object({ action: z.literal('workspace'), workspace: Workspace.optional() }),
  z.object({ action: z.literal('sessions'), workspace: Workspace, limit: Limit200.optional() }),
  z.object({ action: z.literal('probe'), workspace: Workspace.optional() }),
  z.object({ action: z.literal('doctor'), workspace: Workspace.optional() }),
  z.object({ action: z.literal('runs'), limit: Limit200.optional() }),
]);

// ── zcode_session ────────────────────────────────────────────────────────────

export const SessionArgs = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), workspace: Workspace, limit: Limit200.optional() }),
  z.object({ action: z.literal('get'), session_id: SessionId }),
  z.object({
    action: z.literal('create'),
    workspace: Workspace,
    mode: Mode.optional(),
    model: z.string().min(1).optional(),
    thought_level: z.string().min(1).optional(),
    mcp_servers: z.array(z.string().min(1)).max(64).optional(),
    title_generation: z.boolean().optional(),
    persistence: z.enum(['immediate', 'deferred']).optional()
      .describe('Default "deferred", matching the runtime. A deferred session has no database row until first used.'),
    first_input: z.string().min(1).max(200_000).optional().describe(
      'Send a first prompt in the SAME command. Strongly recommended: without it the created ' +
        'session has no database row until it is first used, so a later separate send fails its ' +
        'foreign key (addendum A21).',
    ),
  }),
  z.object({ action: z.literal('resume'), session_id: SessionId, model: z.string().min(1).optional(), thought_level: z.string().min(1).optional() }),
  z.object({ action: z.literal('close'), session_id: SessionId }),
  z.object({ action: z.literal('fork'), session_id: SessionId, checkpoint_id: z.string().min(1).optional() }),
  z.object({ action: z.literal('compact'), session_id: SessionId, instructions: z.string().max(20_000).optional() }),
  z.object({ action: z.literal('set_model'), session_id: SessionId, model: z.string().min(1) }),
  z.object({ action: z.literal('set_mode'), session_id: SessionId, mode: Mode }),
  z.object({ action: z.literal('set_thought_level'), session_id: SessionId, thought_level: z.string().min(1) }),
  z.object({
    action: z.literal('goal'),
    session_id: SessionId,
    goal_action: z.enum(['show', 'set', 'pause', 'resume', 'clear']),
    objective: z.string().max(20_000).optional(),
  }),
  z.object({ action: z.literal('subagents'), session_id: SessionId }),
  z.object({ action: z.literal('usage'), session_id: SessionId }),
]);

// ── zcode_chat ───────────────────────────────────────────────────────────────

export const ChatArgs = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('send'),
    session_id: SessionId.optional().describe(
      'Omit to create a session and send the first input in one command — the only ordering the ' +
        'runtime supports for a brand-new session (see addendum A21). Provide it to send to an ' +
        'existing session.',
    ),
    text: z.string().min(1).max(200_000),
    attachments: z.array(Attachment).max(20).optional(),
    delivery: z.enum(['auto', 'startNow', 'queue', 'guide']).optional(),
    tool_allowlist: z.array(z.string().min(1)).max(64).optional()
      .describe('Restrict the turn to these tools. tool_allowlist:["Read"] makes a turn incapable of writing.'),
    tool_denylist: z.array(z.string().min(1)).max(64).optional(),
    idempotency_key: z.string().min(1).max(200).optional()
      .describe('Stable across retries. The runtime treats a repeat with the same key as one turn.'),
    collect: z.enum(['final', 'text', 'events', 'none']).optional(),
    wait: z.boolean().optional(),
    wait_timeout_ms: z.number().int().min(1_000).max(3_600_000).optional(),
  }),
  z.object({ action: z.literal('steer'), session_id: SessionId, text: z.string().min(1).max(20_000) }),
  z.object({ action: z.literal('stop'), session_id: SessionId }),
  z.object({ action: z.literal('cancel_background'), session_id: SessionId, task_id: z.string().min(1) }),
  z.object({
    action: z.literal('wait'),
    session_id: SessionId,
    until: z.enum(['idle', 'turn_complete', 'any_terminal']).optional(),
    timeout_ms: z.number().int().min(1_000).max(3_600_000).optional(),
    collect: z.enum(['final', 'text', 'events', 'none']).optional(),
  }),
]);

// ── zcode_conversation ───────────────────────────────────────────────────────

export const ConversationArgs = z.discriminatedUnion('action', [
  z.object({ action: z.literal('rows'), session_id: SessionId, before_row_id: RowId.optional(), limit: Limit200.optional() }),
  z.object({ action: z.literal('messages'), session_id: SessionId }),
  z.object({ action: z.literal('events'), session_id: SessionId, limit: Limit2000.optional() }),
  z.object({ action: z.literal('plans'), session_id: SessionId, row_id: RowId.optional() }),
  z.object({ action: z.literal('usage'), session_id: SessionId }),
]);

// ── zcode_files ──────────────────────────────────────────────────────────────

export const FilesArgs = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('changes'),
    session_id: SessionId,
    row_id: RowId,
    entity_id: z.string().min(1).optional().describe(
      'Optional. Resolved from the row when omitted, which costs one extra read.',
    ),
  }),
  z.object({
    action: z.literal('rewind_preview'),
    session_id: SessionId,
    row_id: RowId,
    entity_id: z.string().min(1).optional(),
  }),
  z.object({ action: z.literal('rewind_apply'), session_id: SessionId, checkpoint_id: z.string().min(1).optional(), confirm: z.literal(true) }),
  z.object({
    action: z.literal('read_attachment'),
    session_id: SessionId,
    ref: z.string().min(1),
    mime: z.string().min(1).optional(),
    max_bytes: z.number().int().min(1).max(31_457_280).optional(),
    message_id: z.string().min(1).optional(),
    attachment_index: z.number().int().min(0).max(1_024).optional(),
  }),
  z.object({ action: z.literal('put_attachment'), path: z.string().min(1), session_id: SessionId.optional() }),
]);

// ── zcode_command ────────────────────────────────────────────────────────────

export const CommandArgs = z.discriminatedUnion('action', [
  z.object({ action: z.literal('catalog') }),
  z.object({
    action: z.literal('query'),
    session_id: SessionId.optional(),
    commands: z.array(z.object({ command_id: z.string().min(1), session_id: SessionId.nullable().optional() })).min(1).max(64),
  }),
  z.object({
    action: z.literal('execute'),
    session_id: SessionId.optional(),
    envelope: z.object({
      command_id: z.string().min(1),
      type: z.enum(['createSession', 'sendText', 'sendGoalCommand', 'compact']),
      payload: z.record(z.string(), z.unknown()),
    }),
  }),
]);

// ── zcode_settings ───────────────────────────────────────────────────────────

export const ProviderBlock = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  kind: z.enum(['anthropic', 'openai', 'openai-compatible']).optional(),
  baseURL: z.string().min(1).optional(),
  apiKeyRequired: z.boolean().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  providerOptions: z.record(z.string(), z.unknown()).optional(),
}).describe('API keys must be supplied by environment (ZCODE_API_KEY), never here.');

export const SettingsArgs = z.discriminatedUnion('action', [
  z.object({ action: z.literal('read_state'), workspace: Workspace }),
  z.object({ action: z.literal('get'), file: z.enum(['agent_config', 'desktop_settings', 'provider_registry']) }),
  z.object({ action: z.literal('set_desktop'), patch: z.record(z.string(), z.unknown()) }),
  z.object({ action: z.literal('set_default_model'), workspace: Workspace, model: z.string().min(1) }),
  z.object({ action: z.literal('set_default_mode'), workspace: Workspace, mode: Mode }),
  z.object({ action: z.literal('set_default_thought_level'), workspace: Workspace, thought_level: z.string().min(1) }),
  z.object({ action: z.literal('update_interaction_prefs'), workspace: Workspace, ask_user_question_auto_resolution: z.boolean() }),
  z.object({ action: z.literal('update_model_io_prefs'), workspace: Workspace, full_retention: z.boolean() }),
  z.object({ action: z.literal('upsert_provider'), workspace: Workspace, provider: ProviderBlock }),
  z.object({ action: z.literal('remove_provider'), workspace: Workspace, provider_id: z.string().min(1) }),
  z.object({ action: z.literal('update_provider_registry'), workspace: Workspace, registry: z.record(z.string(), z.unknown()) }),
  z.object({ action: z.literal('hook_trust_grant'), workspace: Workspace }),
]);

// ── zcode_plugins ────────────────────────────────────────────────────────────

const PluginId = z.string().min(1).describe('A plugin id, e.g. android-emulator@zcode-plugins-official');

export const PluginsArgs = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), workspace: Workspace }),
  z.object({ action: z.literal('overview'), workspace: Workspace }),
  z.object({ action: z.literal('describe'), workspace: Workspace, plugin_id: PluginId }),
  z.object({ action: z.literal('set_enabled'), workspace: Workspace, plugin_id: PluginId, enabled: z.boolean() }),
  z.object({ action: z.literal('configure'), workspace: Workspace, plugin_id: PluginId, config: z.record(z.string(), z.unknown()) }),
  z.object({ action: z.literal('reset_config'), workspace: Workspace, plugin_id: PluginId }),
  z.object({ action: z.literal('validate'), workspace: Workspace, plugin_id: PluginId.optional() }),
  z.object({ action: z.literal('install'), workspace: Workspace, plugin_id: PluginId }),
  z.object({ action: z.literal('update'), workspace: Workspace, plugin_id: PluginId }),
  z.object({ action: z.literal('uninstall'), workspace: Workspace, plugin_id: PluginId }),
  z.object({ action: z.literal('marketplace'), marketplace_action: z.enum(['add', 'remove', 'update']), target: z.string().min(1) }),
  z.object({ action: z.literal('cancel_operation'), operation_id: z.string().min(1) }),
]);

// ── zcode_mcp ────────────────────────────────────────────────────────────────

export const McpArgs = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), workspace: Workspace }),
  z.object({ action: z.literal('status'), workspace: Workspace, server: z.string().min(1) }),
  z.object({ action: z.literal('servers'), scope: z.enum(['agent', 'desktop']).optional() }),
  z.object({ action: z.literal('add_server'), name: z.string().min(1), spec: z.object({ command: z.string().min(1), args: z.array(z.string()).max(64).optional(), env: z.record(z.string(), z.string()).optional() }) }),
  z.object({ action: z.literal('remove_server'), name: z.string().min(1) }),
]);

// ── zcode_automation ─────────────────────────────────────────────────────────

export const AutomationArgs = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }),
  z.object({
    action: z.literal('create'),
    prompt: z.string().min(1).max(20_000),
    title: z.string().max(200).optional(),
    cron_expr: z.string().min(1).max(200).optional(),
    relative_delay_minutes: z.number().int().min(1).max(525_600).optional(),
    interval_unit: z.enum(['minute', 'hourly', 'daily', 'weekly', 'monthly', 'yearly']).optional(),
    interval: z.number().int().min(1).max(200).optional(),
    model: z.string().min(1).optional(),
    provider: z.string().min(1).optional(),
    mode: Mode.optional(),
    thought_level: z.string().min(1).optional(),
    target_task_id: z.string().min(1).optional(),
    recurring: z.boolean().optional(),
    max_runs: z.number().int().min(1).max(10_000).optional(),
  }),
  z.object({
    action: z.literal('update'),
    automation_id: z.string().min(1),
    title: z.string().max(200).optional(),
    cron_expr: z.string().min(1).max(200).optional(),
    prompt: z.string().min(1).max(20_000).optional(),
    recurring: z.boolean().optional(),
    max_runs: z.number().int().min(1).max(10_000).optional(),
  }),
  z.object({ action: z.literal('delete'), automation_id: z.string().min(1) }),
  z.object({ action: z.literal('check_binding'), target_task_id: z.string().min(1) }),
]);

// ── zcode_usage ──────────────────────────────────────────────────────────────

export const UsageArgs = z.object({ action: z.literal('stats'), range: Range });

// ── zcode_models ─────────────────────────────────────────────────────────────

export const ModelsArgs = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('catalog'),
    provider: z.string().min(1).optional(),
    min_context: z.number().int().min(1).optional().describe('Only models whose context window is at least this.'),
    input_modality: z.enum(['text', 'image', 'audio', 'video', 'pdf']).optional(),
    reasoning_level: z.string().min(1).optional(),
    kind: z.enum(['anthropic', 'openai', 'openai-compatible']).optional(),
  }),
  z.object({ action: z.literal('available'), workspace: Workspace, session_id: SessionId.optional() }),
  z.object({ action: z.literal('current'), workspace: Workspace, session_id: SessionId.optional() }),
  z.object({
    action: z.literal('select'),
    scope: z.enum(['server', 'workspace', 'session']).optional().describe('Default: session.'),
    model: z.string().min(1).describe('"<model>" or "<provider>/<model>".'),
    provider: z.string().min(1).optional().describe('Required for scope "server".'),
    workspace: Workspace,
    session_id: SessionId.optional(),
  }),
]);

// ── zcode_approval ───────────────────────────────────────────────────────────

export const ApprovalArgs = z.discriminatedUnion('action', [
  z.object({ action: z.literal('policy') }),
  z.object({ action: z.literal('list'), session_id: SessionId.optional() }),
  z.object({
    action: z.literal('respond'),
    request_id: z.string().min(1),
    decision: z.enum(['allow', 'deny', 'escalate', 'modify']),
    reason: z.string().max(2_000).optional(),
    modified_input: z.unknown().optional(),
    persist_rule: z.object({
      behavior: z.enum(['allow', 'deny', 'ask']),
      rules: z.array(z.object({ tool_name: z.string().min(1), rule_content: z.string().optional() })).min(1).max(64),
    }).optional().describe('Writes a durable permission rule. Requires ZCODE_MCP_ALLOW_PERSIST_RULES=1.'),
  }),
]);

// ── zcode_headless ───────────────────────────────────────────────────────────

export const HeadlessArgs = z.object({
  action: z.literal('prompt'),
  text: z.string().min(1).max(200_000),
  workspace: Workspace,
  output: z.enum(['json', 'text', 'stream-json']).optional(),
  mode: Mode.optional(),
  resume: SessionId.optional(),
  continue: z.boolean().optional(),
  target: z.string().max(20_000).optional(),
  timeout_ms: z.number().int().min(1_000).max(3_600_000).optional(),
}).describe(
  'Unattended one-shot run. NOTE: --settings/--max-turns are advertised by zcode --help but rejected by its parser, ' +
  'so they are never emitted. Flags not in the verified table are reported as skipped rather than guessed.',
);

// ── zcode_protocol ───────────────────────────────────────────────────────────

export const ProtocolArgs = z.discriminatedUnion('action', [
  z.object({ action: z.literal('methods'), filter: z.string().max(120).optional() }),
  z.object({
    action: z.literal('call'),
    method: z.string().min(1).max(200),
    params: z.record(z.string(), z.unknown()).optional(),
    workspace: Workspace,
    session_id: SessionId.optional(),
    timeout_ms: z.number().int().min(1_000).max(600_000).optional(),
  }),
]);

// ── registry ─────────────────────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
}

/**
 * The whole surface is 14 tools with action unions rather than one tool per operation.
 * The model provider rejects requests above roughly 89-94 registered tools with
 * `[1210] Invalid API parameter`, so tool count is a real budget, not a style preference.
 */
export const TOOL_REGISTRY: ToolDefinition[] = [
  {
    name: 'zcode_status',
    description:
      'Report the state of this MCP server and of ZCode itself. Read-only; starts no turn. ' +
      '"probe" is the diagnostic entry point (runtime version, protocol identity, session count).',
    schema: StatusArgs,
  },
  {
    name: 'zcode_session',
    description:
      'ZCode session lifecycle and per-session settings. Mutating actions re-read the session and ' +
      'fail if the observed value disagrees with the request.',
    schema: SessionArgs,
  },
  {
    name: 'zcode_chat',
    description:
      'Submit work to the ZCode agent and follow it to a terminal state. Success is only reported after ' +
      'a terminal turn event is observed; an accepted-but-unobserved command is reported degraded. ' +
      'Use tool_allowlist:["Read"] for a guaranteed non-mutating turn.',
    schema: ChatArgs,
  },
  {
    name: 'zcode_conversation',
    description:
      'Read a conversation: rows, messages, events, plans, usage. Read-only. Reads carry logEpoch and ' +
      'revision; on staleness the read is retried once, then reported degraded.',
    schema: ConversationArgs,
  },
  {
    name: 'zcode_files',
    description:
      'Inspect what a turn changed, preview a rewind, and move attachments. ZCode has NO editor document ' +
      'API: there is no "read the file as the editor sees it". File mutation goes through the agent\'s own ' +
      'Write/Edit tools, which is the only path that produces checkpoints and participates in rewind. ' +
      'rewind_apply is destructive and requires confirm:true.',
    schema: FilesArgs,
  },
  {
    name: 'zcode_command',
    description:
      'Resolve and execute ZCode\'s own command surface. NOTE: v4/command returns ADMISSION, not completion — ' +
      'use zcode_chat when you need the outcome.',
    schema: CommandArgs,
  },
  {
    name: 'zcode_settings',
    description:
      'Read and change configuration. Protocol-backed actions take effect immediately; file-backed actions ' +
      '(set_desktop) are read by ZCode at startup and report that a restart is required. Provider mutations ' +
      'require ZCODE_MCP_ALLOW_PROVIDER_EDIT=1. Secrets are redacted in all output.',
    schema: SettingsArgs,
  },
  {
    name: 'zcode_plugins',
    description:
      'Enumerate and manage extensions. Enabling plugins consumes the model\'s tool budget: the provider ' +
      'rejects requests above roughly 89-94 registered tools with [1210] Invalid API parameter, so this ' +
      'warns when the count approaches the budget. install/update/uninstall require ZCODE_MCP_ALLOW_PLUGIN_INSTALL=1.',
    schema: PluginsArgs,
  },
  {
    name: 'zcode_mcp',
    description:
      'Inspect and manage ZCode\'s MCP client surface. WARNING: "list" and "status" START the configured MCP ' +
      'servers as a side effect; the started instance ids are reported. Use "servers" to read configuration ' +
      'without starting anything. Config edits require ZCODE_MCP_ALLOW_MCP_CONFIG_EDIT=1 and a restart.',
    schema: McpArgs,
  },
  {
    name: 'zcode_automation',
    description:
      'Manage scheduled agent runs. Creating an automation grants STANDING, UNATTENDED authority at the mode ' +
      'recorded at creation time. At most 20 automations are retained.',
    schema: AutomationArgs,
  },
  {
    name: 'zcode_usage',
    description: 'Token and activity analytics. Read-only.',
    schema: UsageArgs,
  },
  {
    name: 'zcode_models',
    description:
      'Discover models and providers, and select one. ACTION "catalog" is the decision surface: it ' +
      'lists what ZCode can talk to with context windows, modalities, reasoning levels and whether ' +
      'this server holds a credential for that provider — filterable, and deliberately NOT ranked, ' +
      'because choosing a model is the job of the caller. "available" reports what the runtime has ' +
      'wired up ' +
      '(a different question). "select" applies a choice at session, workspace or server scope; ' +
      'server scope affects only newly spawned runtimes in this process and does not persist.',
    schema: ModelsArgs,
  },
  {
    name: 'zcode_approval',
    description:
      'Answer the agent\'s approval, input and elicitation requests. Owning a runtime makes this server the ' +
      'runtime\'s only client, so unanswered requests block turns. The default policy is DENY. persist_rule ' +
      'writes a durable permission rule and requires ZCODE_MCP_ALLOW_PERSIST_RULES=1.',
    schema: ApprovalArgs,
  },
  {
    name: 'zcode_headless',
    description:
      'One-shot headless run via the zcode CLI, requiring no protocol. Emits only flags verified to parse; ' +
      'unverified flags are reported as skipped. Needs a configured model provider.',
    schema: HeadlessArgs,
  },
  {
    name: 'zcode_protocol',
    description:
      'Escape hatch: raw ZCode Protocol access. Disabled by default (ZCODE_MCP_DISABLE_PROTOCOL=1 turns it off ' +
      'entirely) and restricted to an allowlist; mutating methods need ZCODE_MCP_PROTOCOL_ALLOW_MUTATIONS=1. ' +
      'Results are always marked unreliable because no read-back or schema guarantee is applied.',
    schema: ProtocolArgs,
  },
];

/** Tool names only, for the budget assertion in tests. */
export const TOOL_NAMES = TOOL_REGISTRY.map((t) => t.name);

/**
 * The JSON Schema published for a tool's arguments, as MCP requires it.
 *
 * MCP mandates `type: "object"` at the root, and both the SDK's `ListToolsResultSchema` and ZCode's
 * client enforce it — the error is `Invalid input: expected "object"` at `tools[n].inputSchema.type`.
 * `zodToJsonSchema` on a discriminated union emits a bare `anyOf` with NO root `type`, so 13 of these
 * 15 tools were being rejected; the list handler previously cast the result to `{type:'object'}`, a
 * type assertion that describes the shape without producing it. Two tools happened to pass only
 * because their args are a plain `z.object`.
 *
 * `anyOf` beside `type: "object"` is valid JSON Schema and equivalent here, since every branch is an
 * object — so the union is kept rather than flattened.
 */
export function toolInputSchema(schema: z.ZodTypeAny): { type: 'object'; [k: string]: unknown } {
  const json = zodToJsonSchema(schema, { $refStrategy: 'none' }) as Record<string, unknown>;
  // Supply a missing root type; never overwrite one that is present, which would misdescribe it.
  return (json.type === undefined ? { ...json, type: 'object' } : json) as { type: 'object'; [k: string]: unknown };
}
