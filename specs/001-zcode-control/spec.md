# Feature Specification: ZCode Programmatic Control Surface

**Feature Branch**: `001-zcode-control`

**Created**: 2026-09-11

**Status**: Draft

**Input**: Reverse-engineering audit of ZCode Desktop 3.11.2 — determine the architecture, find the
semantic control plane, and expose it as `mnehmos.zcode.mcp`.

**Research basis**: `ZCODE_ARCHITECTURE.md`, `ZCODE_COMPONENT_MAP.md`, `ZCODE_API_CATALOG.md`,
`ZCODE_COMMAND_CATALOG.md`, `ZCODE_UI_MAP.md`, `ZCODE_STATE_MODEL.md`,
`ZCODE_AGENT_ARCHITECTURE.md`, `ZCODE_CONTROL_SURFACES.md`, `ZCODE_RE_FINDINGS.md`,
`ZCODE_UNKNOWNS.md` (see `research.md` for the condensed index).

---

## Context

ZCode is an Electron desktop AI coding agent backed by a separate, headless **agent runtime**
process that speaks a versioned, schema-validated protocol ("ZCode Protocol" v1) over
newline-delimited JSON on stdin/stdout. That protocol — not the UI — is the control plane.

Two facts shape this feature:

1. The runtime is **spawnable and scriptable by an unrelated process**
   (CONFIRMED: `node zcode.cjs app-server --stdio`, 66 methods).
2. The runtime requires **its own model-provider configuration** and does not inherit the desktop's
   (CONFIRMED: a bare runtime reports `modelId: "missing-model"`).

Therefore ZCode can be controlled programmatically today, but only by a client that is willing to
own a runtime process and provision a model provider for it.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Ask ZCode's agent to do work and get the result (Priority: P1)

A developer using an MCP-capable agent (including ZCode itself, or any other MCP client) asks the
MCP to run a coding task in a repository. The MCP starts or reuses a ZCode agent runtime for that
workspace, submits the task, follows the turn to completion, and returns the agent's final text
together with what it did — the tools it ran, the files it changed, and the token cost.

**Why this priority**: This is the feature. Everything else is either prerequisite plumbing or
convenience. Without it the MCP has no reason to exist.

**Independent Test**: With a configured provider, call the chat tool with a read-only instruction
against a scratch directory; assert a completed turn, non-empty assistant text, and exactly one
audit row. Fully testable without any other tool.

**Acceptance Scenarios**:

1. **Given** a configured provider and a workspace with no running runtime, **When** the caller sends
   a prompt, **Then** a runtime is started, the turn reaches a terminal state, and the response
   contains the assistant's text plus the turn's tool-call summary and outcome.
2. **Given** a turn in progress, **When** the caller requests cancellation, **Then** the turn stops
   promptly — even if other work is queued — and the caller is told the terminal state.
3. **Given** the agent completes but the caller's wait times out, **When** the tool returns,
   **Then** the result reports the partial state and is marked as degraded rather than claiming
   completion.
4. **Given** the agent wants to run a tool that requires approval and the policy is deny, **When**
   the turn proceeds, **Then** the tool is denied, the turn continues or fails cleanly, and no
   side effect occurs.
5. **Given** an agent response claiming success, **When** a mutation was involved, **Then** the
   reported state is the state re-read from ZCode, not the agent's claim.

---

### User Story 2 - Inspect what ZCode is doing without disturbing it (Priority: P2)

An operator wants to see the current state of ZCode: which workspaces and sessions exist, which
sessions are running, what each session's model/mode/reasoning setting is, how many tokens and how
much context it has used, what its pending approvals are, and what the agent recently did. All of
this must be obtainable without starting a turn or changing anything.

**Why this priority**: Monitoring is the second reason to have this MCP and the safest. It is also
the prerequisite for every mutating tool, because read-back discipline needs a read model.

**Independent Test**: Call the status and inspection tools against a real installation; assert real
sessions, real model catalogue, and real usage figures come back, and that no state changed.

**Acceptance Scenarios**:

1. **Given** ZCode has existing sessions, **When** the caller lists sessions, **Then** each entry
   reports id, title, kind, status, mode and workspace.
2. **Given** a workspace, **When** the caller reads its state, **Then** the current mode, model,
   permission mode, reasoning setting and available slash commands are returned.
3. **Given** usage history exists, **When** the caller requests usage for a range, **Then** token
   totals, turn and tool-call counts, error rates and the per-day heatmap are returned.
4. **Given** a session is mid-turn, **When** the caller inspects it, **Then** running tool calls,
   pending approvals and background jobs are visible.
5. **Given** any read tool, **When** it runs, **Then** it starts no turn and mutates nothing.

---

### User Story 3 - Configure the agent's model, mode and behaviour (Priority: P3)

A developer wants to point the agent at a particular model or provider, set the permission mode for
a session, adjust reasoning effort, manage which extensions are enabled, and register scheduled
automations — all without opening the ZCode UI.

**Why this priority**: Necessary for real use but only meaningful once P1 and P2 work. It also
carries the highest blast radius (provider edits can break model access), so it is deliberately
gated behind explicit opt-ins.

**Independent Test**: Set a session's mode, read it back, and assert the change is visible in the
next state read; attempt a provider edit without the opt-in flag and assert refusal.

**Acceptance Scenarios**:

1. **Given** a session, **When** the caller changes its mode, **Then** the change is confirmed by a
   read-back and is visible in subsequent state reads.
2. **Given** the caller attempts to modify the provider registry without the opt-in flag, **When**
   the tool runs, **Then** it refuses with a reason code and changes nothing.
3. **Given** plugins are installed, **When** the caller enables one, **Then** the new state is
   confirmed by a re-read and the resulting registered-tool count is reported.
4. **Given** the resulting tool count would exceed the provider's accepted budget, **When** the tool
   returns, **Then** it warns that the model may reject requests.
5. **Given** a settings change that only takes effect at startup, **When** the tool returns,
   **Then** it says so explicitly rather than implying the change is live.

---

### User Story 4 - Inspect and manage the extension surface (Priority: P3)

A developer wants to enumerate installed plugins and their contributed commands, skills and MCP
servers; see which MCP servers are connected and how many tools each exposes; and add or remove an
MCP server definition.

**Why this priority**: Valuable for operating the agent's capability surface, and independent of the
chat path.

**Independent Test**: List plugins against a real installation and assert the known plugins appear
with their components and enablement state; list MCP servers and assert per-server status and tool
counts.

**Acceptance Scenarios**:

1. **Given** plugins are installed, **When** the caller lists them, **Then** each reports id,
   version, enablement, source and the commands/skills/MCP servers it contributes.
2. **Given** MCP servers are configured, **When** the caller lists them, **Then** each reports
   connection status, transport and tool count.
3. **Given** the caller lists MCP servers, **When** the tool returns, **Then** it discloses that
   this action started those servers.
4. **Given** the caller edits the MCP server configuration, **When** the edit is applied, **Then** a
   timestamped backup exists and the result states that a restart is required.

---

### User Story 5 - Inspect conversation history and file changes (Priority: P3)

A developer wants to read a past session's conversation and see which files a given turn changed, so
they can review or audit the agent's work.

**Why this priority**: High value for review workflows, but it depends on the same runtime and adds
revision-token handling that is easy to get wrong; ship it after the core is proven.

**Independent Test**: Read rows for an existing session and assert real content; request file changes
for a turn that modified a file and assert a non-empty change set.

**Acceptance Scenarios**:

1. **Given** a session with history, **When** the caller requests a window of conversation rows,
   **Then** rows are returned with their identity and ordering information.
2. **Given** the conversation log advanced since the caller's last read, **When** the caller reads,
   **Then** the staleness is detected and resolved by re-reading rather than returning wrong data.
3. **Given** a turn that changed files, **When** the caller requests the file changes, **Then** the
   changed files are listed with enough information to review them.
4. **Given** the caller requests a rewind preview, **When** the tool returns, **Then** nothing on
   disk has changed.

---

### Edge Cases

- **Runtime not installed or not found**: every tool fails fast with actionable guidance, never an
  empty success.
- **No model provider configured**: the chat path fails with ZCode's own message
  (`Model config is missing…`) passed through verbatim and marked unreliable, not paraphrased.
- **Two workspaces requested concurrently**: each gets its own runtime; the child cap is enforced and
  excess requests queue or fail explicitly rather than silently sharing state.
- **Runtime dies mid-turn**: the transport close is detected, the child is marked dead, the pending
  request fails with the transport error, and the next call respawns.
- **Payload over 1 MiB**: refused before send with guidance to use the attachment path.
- **Session id from a different workspace**: fails with session-unavailable rather than silently
  creating a new session.
- **Conversation log epoch changed** (compaction or fork): cached row identifiers are invalidated;
  the caller is told to re-read.
- **Approval request arrives with no client policy configured**: the default is deny, and the
  denial is visible.
- **Provider returns a rate-limit or auth failure**: the failure classification is surfaced verbatim
  so the caller can distinguish "retry" from "fix credentials".
- **Concurrent MCP calls on one session**: admitted calls are idempotent under a caller-supplied
  idempotency key; duplicate submissions do not start two turns.

## Requirements *(mandatory)*

### Functional Requirements

**Control plane**

- **FR-001**: The server MUST control ZCode exclusively through ZCode Protocol methods, documented
  CLI subcommands/flags, or documented configuration files.
- **FR-002**: The server MUST maintain one agent runtime per workspace, spawning lazily and reusing
  across calls, keyed by ZCode's workspace key.
- **FR-003**: The server MUST bound the number of concurrent runtimes and reclaim idle ones.
- **FR-004**: The server MUST terminate every runtime it owns on shutdown, including its process
  tree, and MUST NOT leave orphan processes.
- **FR-005**: The server MUST enforce the protocol's 1 MiB frame limit before sending and MUST route
  larger payloads through the attachment channel.
- **FR-006**: The server MUST verify the live protocol name/version at first contact and degrade
  loudly on mismatch.

**Sessions and turns**

- **FR-007**: Users MUST be able to list, read, create, resume, fork, compact and close sessions.
- **FR-008**: Users MUST be able to submit a prompt with optional file attachments and optional tool
  allow/deny lists.
- **FR-009**: Users MUST be able to follow a turn to its terminal state and receive the assistant's
  text, the tool calls performed, the outcome and the token usage.
- **FR-010**: Users MUST be able to cancel a turn and to cancel a specific background task.
- **FR-011**: Users MUST be able to steer an in-progress turn by submitting additional input.
- **FR-012**: The server MUST distinguish admission from completion and MUST NOT report a turn as
  successful without observing a terminal turn event.
- **FR-013**: Users MUST be able to set a session's model, permission mode and reasoning effort, and
  the server MUST confirm each change by reading the value back.
- **FR-014**: Users MUST be able to read and set a session's goal.
- **FR-015**: Users MUST be able to enumerate a session's subagents.

**State and inspection**

- **FR-016**: Users MUST be able to read a workspace's current state: mode, model, permission mode,
  reasoning setting and available slash commands.
- **FR-017**: Users MUST be able to read a session's live projection: status, turn count, token and
  context usage, active tool calls, pending approvals and background jobs.
- **FR-018**: Users MUST be able to read conversation rows, messages, events and plans for a session.
- **FR-019**: The server MUST handle conversation log-epoch and revision staleness by re-reading and
  retrying at most once, and MUST report remaining staleness as degraded.
- **FR-020**: Users MUST be able to read usage statistics for a requested time range.
- **FR-021**: Users MUST be able to obtain file-change information for a turn and a read-only rewind
  preview.

**Approvals**

- **FR-022**: The server MUST answer every approval, user-input, elicitation and runtime-preference
  request directed at it, so that a turn cannot deadlock.
- **FR-023**: The approval policy MUST default to denying.
- **FR-024**: Users MUST be able to list pending approvals and respond with allow, deny, escalate or
  modify, optionally including a modified input.
- **FR-025**: Persisting a durable permission rule MUST require separate opt-in and MUST be reported
  as such.

**Configuration, extensions, automation**

- **FR-026**: Users MUST be able to read and set workspace default model, mode and reasoning effort.
- **FR-027**: Users MUST be able to update interaction and model-I/O preferences.
- **FR-028**: Users MUST be able to read and update provider entries, and these actions MUST require
  an opt-in flag.
- **FR-029**: Users MUST be able to enumerate plugins with their contributed components, and to
  enable/disable, configure, validate, install, update and uninstall them.
- **FR-030**: Plugin installation MUST require an opt-in flag.
- **FR-031**: Users MUST be able to enumerate MCP servers with status, transport and tool count.
- **FR-032**: The server MUST warn when the registered-tool count approaches the model's accepted
  budget.
- **FR-033**: Users MUST be able to create, list, update and delete scheduled automations.
- **FR-034**: Users MUST be able to read and write the desktop settings file, with the server stating
  that a restart is required for such changes to take effect.

**Secret handling**

- **FR-035**: The server MUST prefer supplying the model API key through the child process
  environment over writing it to any file.
- **FR-036**: The server MUST redact API keys, tokens, secrets and passwords from all wire logs,
  results and audit rows by default.
- **FR-037**: The server MUST NOT read, write or relocate ZCode's credential store.

**Fallback and escape hatch**

- **FR-038**: The server MUST offer a one-shot headless mode that requires no protocol
  implementation.
- **FR-039**: The headless mode MUST emit only CLI flags verified to parse and MUST record the exact
  command line.
- **FR-040**: The server MUST offer a raw protocol call usable for methods outside the typed
  surface; it MUST be disabled by default, restricted to an allowlist, and require a separate opt-in
  for mutating methods.

**Provenance and honesty**

- **FR-041**: The server MUST record an audit row for every call, and MUST keep every artifact it
  generates on disk with byte size and hash.
- **FR-042**: Every tool response MUST use one shared envelope carrying an overall success flag, the
  tool and action, the runtime identity, evidence (payload source, exit code, duration, timeout,
  warnings with impact tags, errors), per-method diagnostics, the result, and artifact locations.
- **FR-043**: Every mutating action MUST perform a read-back and MUST fail if the read-back
  contradicts the request.
- **FR-044**: The server MUST document, per tool, whether it is read-only or mutating.
- **FR-045**: Known hazards MUST be disclosed in the tool's own description, specifically: that
  listing MCP servers starts them, that desktop-settings writes need a restart, and that enabling
  extensions consumes the model's tool budget.

### Key Entities

- **Workspace**: a directory the agent works in, identified by ZCode's own workspace key and path.
  The join key for every runtime, session, subscription and event.
- **Session**: an agent conversation. Has a kind (interactive, fork, subagent, workflow), a status, a
  permission mode, a model, a reasoning setting, a title with provenance, and a parent link for
  forked/subagent sessions.
- **Turn**: one user input and everything the agent did in response. Has an ordinal, a query
  identity, an execution kind, and a terminal outcome.
- **Session Projection**: the live read model — status, turn count, token and context usage, active
  tool calls, pending approvals, background jobs, goal, last error.
- **Message / Part**: conversation content decomposed into typed parts (text, reasoning, tool input,
  tool call) with streaming lifecycle states.
- **Queue Item**: an admitted user input, with its kind, delivery mode, ordering, steering state and
  dispatch state. Idempotent under a stable id, with a 24-hour pending lifetime.
- **Goal**: a session-level objective with a status (active, paused, budget-limited, complete), a
  token budget, tokens used and elapsed time.
- **Tool Call**: one tool invocation with its name, status (pending, running, completed, failed,
  denied) and timing.
- **Permission / Elicitation Request**: an outstanding question from the agent awaiting a decision,
  optionally carrying a durable rule to persist.
- **Automation**: a scheduled prompt with a cron or interval schedule, an optional target task, a
  model/mode/reasoning setting, and a retained-count limit.
- **Plugin**: an installed extension contributing commands, skills, MCP servers and hooks, with
  enablement state and a typed configuration schema.
- **MCP Server**: an external tool provider with a transport, a connection status, a failure kind and
  a tool count.
- **Attachment**: a staged file or image referenced by a conversation, with a size cap and a
  lifetime.
- **File Change**: the set of files a turn modified, addressable by conversation row, with a rewind
  preview available.
- **Runtime**: a ZCode agent process owned by this server, identified by its workspace, protocol
  version and process identity.
- **Audit Row / Artifact**: the provenance record of a call and the files it produced.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A caller can go from a cold start to a completed agent turn, with the answer text
  returned, in a single tool call.
- **SC-002**: Every mutating tool's reported state matches a subsequent independent read-back in
  100% of test cases; a deliberate mismatch is always reported as failure.
- **SC-003**: No tool reports success when the underlying operation returned admission, no-op or
  failure — verified by tests covering each of those protocol outcomes.
- **SC-004**: Cancellation of a running turn resolves within one tool timeout and always reports the
  observed terminal state.
- **SC-005**: 100% of mutating operations are covered by a read-back test; 0 mutating operations
  return success without either a read-back or an explicit degraded warning.
- **SC-006**: The server leaves zero orphan processes after both graceful and abrupt termination,
  verified by process inspection in the integration suite.
- **SC-007**: No API key, token or secret appears in any wire log, result or audit row — verified by
  a redaction test that injects synthetic secrets.
- **SC-008**: The full tool surface stays within the model's accepted tool budget with margin, and a
  test asserts the count.
- **SC-009**: Every declared tool action has a schema test; every unsupported protocol outcome has a
  named error path.
- **SC-010**: A new engineer can read `quickstart.md` and go from clone to a successful call against
  a real ZCode installation without reading ZCode's source.
- **SC-011**: Interactions that require human approval default to denied, and the denial is visible
  to the caller in 100% of cases.
- **SC-012**: The documentation states, per tool, whether it is read-only or mutating, and names the
  ZCode capability it depends on — with no tool depending on UI automation or a private database
  column.

## Assumptions

- The agent runtime ships inside the ZCode installation and is reachable by path discovery; the
  server does not require a separate install.
- A model provider will be configured, either by the user in ZCode's own config, or by this server
  from caller-supplied provider details plus an environment-supplied key.
- Tier A (owning a runtime) is sufficient for v1; reaching the running desktop's own state
  (tasks, open windows, its provider registry) is deferred and tracked as an open question.
- ZCode's protocol remains additive within version 1; a version bump is detectable and will be
  reported rather than worked around.
- File mutation is performed by the agent's own tools rather than by direct filesystem writes from
  this server, because that is the only path that produces checkpoints and participates in rewind.
