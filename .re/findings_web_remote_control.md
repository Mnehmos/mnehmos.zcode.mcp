# ZCode Desktop 3.11.2 — Web Remote Control: reverse-engineering report

Scope: `E:/zcode/resources/app.asar` → `out/main/index.js`, `out/host/index.js`, `out/scheduler/index.js`, `out/preload/index.cjs`, `out/renderer/assets/styles-DyAcaLKy.js`, and the shared chunks.
Build metadata (`out/metadata/build-meta.json`): `appVersion 3.11.2`, `buildCommitId 89817f5b`, `buildTime 2026-09-04T08:04:18.527Z`.

Legend: **[C]** = CONFIRMED (literal in code), **[SI]** = STRONGLY INFERRED (mechanical consequence of confirmed code, one step), **[H]** = HYPOTHESIS.

---

## TL;DR — the headline finding

**The desktop app does NOT create any HTTP or WebSocket server for Web Remote Control.**
It is a pure **outbound WebSocket client**. `zcode:start-web-remote-control` opens a `ws`
`WebSocket` (the `ws` npm package) to a **remote relay** — `wss://zcode.z.ai/ws` (prod) or
`wss://zcode.chatglm.site/ws` (test) — and the phone/browser that scans the QR talks to that
same relay, not to the desktop.

The desktop↔host IPC channel (an Electron `MessagePort` obtained via `attach-service-port`) is
**tunnelled through** that relay inside `zcode_type:"rpc-frame"` fragments. The "ZCode Protocol
v4" NDJSON envelope is a *different*, adjacent protocol used for CLI attachments and the remote
workspace server — it is **not** the Web Remote Control transport.

There is no port to scan, no host to bind, no local HTTP route and no local TLS variant. The only
network-reachable surfaces in the whole app are enumerated in §7 (loopback media-preview proxy,
CUA broker UNIX socket, E2E mock gateway, and a set of outbound clients).

---

## 1. `zcode:start-web-remote-control` — what it actually does

### 1.1 Channel constants
`x/chunks/out_main_chunk-WR3FEWGO.js` @ ~10 127 (object `RT`), mirror in
`x/preload-index.cjs` @ ~478 255 (object `b`):

```
StartWebRemoteControl            "zcode:start-web-remote-control"           (invoke)
ResetWebRemoteControlPairing     "zcode:reset-web-remote-control-pairing"   (invoke)
StopWebRemoteControl             "zcode:stop-web-remote-control"            (invoke)
GetWebRemoteControlStatus        "zcode:get-web-remote-control-status"      (invoke)
WebRemoteControlStatusChanged    "zcode:web-remote-control-status-changed"  (main -> renderer)
SyncWebRemoteControlWorkspaces   "zcode:sync-web-remote-control-workspaces" (renderer -> main, send)
SyncWebRemoteControlTasks        "zcode:sync-web-remote-control-tasks"      (renderer -> main, send)
WebRemoteControlReconnectWorkspace "zcode:web-remote-control-reconnect-workspace" (bidirectional request/reply)
```

Preload façade (`x/preload-index.cjs` @ ~490 769, `contextBridge.exposeInMainWorld("zcode", …)`):

```js
startWebRemoteControl:            (t) => ipcRenderer.invoke("zcode:start-web-remote-control", t)
refreshWebRemoteControlPairing:   (t) => ipcRenderer.invoke("zcode:reset-web-remote-control-pairing", t)
stopWebRemoteControl:             ()  => ipcRenderer.invoke("zcode:stop-web-remote-control")
getWebRemoteControlStatus:        ()  => ipcRenderer.invoke("zcode:get-web-remote-control-status")
onWebRemoteControlStatusChanged:  (cb) => ipcRenderer.on("zcode:web-remote-control-status-changed", handler)
syncWebRemoteControlWorkspaces:   (t) => ipcRenderer.send("zcode:sync-web-remote-control-workspaces", t)
syncWebRemoteControlTasks:        (t) => ipcRenderer.send("zcode:sync-web-remote-control-tasks", t)
onWebRemoteControlReconnectWorkspace: (cb) => ipcRenderer.on("zcode:web-remote-control-reconnect-workspace", handler)
```

### 1.2 The IPC handler — [C]
`x/main-index.js` @ **1 417 724**, function `registerWebRemoteControlIpcHandlers` (`m6`):

```js
ipcMain.handle("zcode:start-web-remote-control", async (evt, ctx) => runStartOperation({
  context: ctx, sender: evt.sender,
  missingWindowMessage: "未找到当前窗口，无法开启 Web 远程控制",
  operation: (windowId) => {
    const mgr = e.webRemoteControlManager;
    const auth = mgr.authorizeStart(windowId, ctx);
    return mgr.startAuthorized(windowId, ctx, auth);
  },
  reportRemoteUsageEvent: e.reportRemoteUsageEvent
}));
ipcMain.handle("zcode:reset-web-remote-control-pairing", … mgr.authorizeStart → mgr.resetPairingAuthorized …);
ipcMain.handle("zcode:stop-web-remote-control",        async evt => { const w = BrowserWindow.fromWebContents(evt.sender); if (w) await e.webRemoteControlManager.stop(w.id); });
ipcMain.handle("zcode:get-web-remote-control-status",  evt   => { const w = BrowserWindow.fromWebContents(evt.sender); return w ? e.webRemoteControlManager.getStatus(w.id) : {status:"idle"}; });
```

`authorizeStart(windowId, ctx)` (@ 1 158 346, `h`) mints a **single-use, 30 s anti-confusion
token**, not a network credential:

```js
{ token: randomUUID(), expiresAt: Date.now()+30000, windowId, workspaceKey, remoteSessionId? }
```
`consumeStartAuthorization` (`y` @ 1 158 720) rejects reuse, expiry, or any window/workspaceKey/remoteSessionId mismatch.
Constant `var che = 3e4` (30 s) sits next to `dhe = 3e4` (QR-ready timeout) and `lhe = 3e3` (mobile-disconnect grace).

### 1.3 What the manager actually starts — [C]
`x/main-index.js` @ **1 178 110**, factory `createWebRemoteControlManager` (`EK`), method `startAuthorized` → `start`:

1. `featureGate.assertEnabled()`.
2. `await stopWindowRuntime(windowId, "restart")` — tears down any previous session (sends `zcode_type:"app-error"` reason `desktop-disconnected`, disposes transport, releases host attachment, emits `{status:"idle"}`).
3. Resolves endpoints: `const T = await e.getEndpointUrls(); const relayWsUrl = T?.relayWsUrl ?? e.relayWsUrl; const remoteUrl = T?.remoteUrl ?? e.mobileRemoteControlUrl;`
4. Loads persisted relay auth. If none → generates a fresh password/hash and uses `mode:"register"`.
5. Constructs a **`WebRemoteControlDeviceTransport`** and calls `.start()`.
6. Awaits a promise that resolves when the device is **QR-ready** — i.e. the transport's `onStateChange` reports `waiting_terminal` or `paired`. Timeout `dhe = 30 000 ms` → `"External relay device did not reach QR-ready state before timeout."`
7. Persists the relay credentials, persists the startup-restore context.
8. Builds the QR/connect URL, stores it on the runtime, emits `zcode:web-remote-control-status-changed`, and returns the start result.

There is **no** `http.createServer`, no `WebSocketServer`, no `listen()` anywhere in this path.
Grep counts across all extracted bundles: `WebSocketServer` → **0 hits**; `.listen(` in
`out/main/index.js` → **0**.

### 1.4 The transport class — [C]
`x/main-index.js` @ **1 144 858**, `var Ah = class … "WebRemoteControlDeviceTransport"`.
`ws` is imported as `import{WebSocket as yO}from"ws"` (@ 1 142 721).

```js
connect() {
  this.socketGeneration += 1;
  let t = new URL(this.options.relayWsUrl);
  t.searchParams.set("mid", this.options.deviceMid);             // ?mid=<device machine id>
  let r = new yO(t.toString(), {
    perMessageDeflate: true,
    headers: { "X-Device-ID": this.options.deviceMid }
  });
  …
}
```

Wire framing is **one JSON object per WebSocket message** (not NDJSON) —
`parseRelayMessage` (`nhe`, @ 1 141 841) does `JSON.parse(buf.toString("utf8"))` on the whole message
and requires a top-level `"type"` field; oversize frames (> 1 MB) are dropped.

---

## 2. Host / port / TLS binding

| Question | Answer | Evidence |
|---|---|---|
| Server created? | **None on the desktop.** Outbound WS client only. | no `createServer` in the WRC path; `WebSocketServer` count = 0 |
| Bind address on the desktop | N/A | — |
| Port on the desktop | N/A | — |
| Relay host (prod) | `wss://zcode.z.ai` path `/ws` | `Yh="wss://zcode.z.ai/ws"` @ `x/chunks/out_main_chunk-WR3FEWGO.js` ~1 011 |
| Relay host (test) | `wss://zcode.chatglm.site/ws` | `resolveWebRemoteControlRelayWsUrl` (`aT`) @ WR3FEWGO ~2 928: `endpointOrigin === "https://zcode.chatglm.site" ? "wss://zcode.chatglm.site/ws" : Yh` |
| TLS | WSS (TLS 1.2+ via Node `tls`); no certificate pinning, no custom CA in this path | `ws` over `wss:` |
| Overrides | `ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL`, `ZCODE_WEB_REMOTE_CONTROL_URL` (both `.trim()`ed; empty ⇒ ignored) | `x/main-index.js` @ **1 466 208/1 466 269** |
| Env selection | `ZCODE_ENV=test` → test origin; else prod. `ZCODE_TEST_BASE_URL` / `ZCODE_PRODUCTION_BASE_URL` override the origin | `oo`/`op`/`ty` in WR3FEWGO ~1 700–2 900 |
| Query params on relay connect | `?mid=<deviceMid>`; header `X-Device-ID: <deviceMid>` | `Ah.connect()` |
| WebSocket options | `perMessageDeflate: true` (negotiated extension is logged) | `Ah.connect()` |

Endpoint builder `buildZCodeEndpointUrls` (`ny`) @ WR3FEWGO ~4 183 — **[C]** verbatim:

```js
function buildZCodeEndpointUrls(baseUrl, {appVersion} = {}) {
  const r  = normalizeOrigin(baseUrl);            // must be http: or https:
  const ws = `${r.protocol === "https:" ? "wss:" : "ws:"}//${r.host}`;
  const s  = isWebRemoteControlV4AppVersion(appVersion) ? "v4" : "v3";   // threshold "3.4.0"
  return {
    origin: r,
    apiBaseUrl:                        `${r}/api/v1`,
    remoteUrl:                         `${r}/remote/${s}`,
    webRemoteCallbackUrl:              `${r}/web-remote/callback`,
    relayWsUrl:                        `${ws}/ws`,
    zcodePlanOpenAiBaseUrl:            `${r}/api/v1/zcode-plan`,
    zcodePlanAnthropicBaseUrl:         `${r}/api/v1/zcode-plan/anthropic`,
    zcodePlanBillingCurrentUrl:        `${r}/api/v1/zcode-plan/billing/current`,
    zcodePlanBillingBalanceUrl:        `${r}/api/v1/zcode-plan/billing/balance`,
  };
}
```

Constants (WR3FEWGO @ 669–1 011 — **[C]** verbatim):

```js
var ft = "https://zcode.z.ai";            // production origin
var Xr = "https://zcode.chatglm.site";    // test origin
var Bh = "http://localhost:3000";         // local dev origin
var Wh = "https://bigmodel.cn",  Fh = "https://dev.bigmodel.cn";
var qh = "https://chat.z.ai",    Vh = "https://zai-test.chatglm.site";
var Gh = "https://api.z.ai",     Kh = "https://api.chatglm.site";
var Hh = "client_P8X5CMWmlaRO9gyO-KSqtg";   // ZAI oauth client id (prod default)
var Jh = "client_RzngVdSk8sYsG2_3HzOMdQ";
var Yh = "wss://zcode.z.ai/ws";
var Xh = "3.4.0";                          // v4 app-version threshold
```

With app version **3.11.2** ≥ 3.4.0, `remoteUrl` resolves to **`https://zcode.z.ai/remote/v4`**.

---

## 3. HTTP routes / WS endpoints actually exposed

### 3.1 Desktop (Electron main) — **none.** [C]

An exhaustive sweep of `out/main/index.js` for `createServer`, `.listen(`, `WebSocketServer`,
`hono`, `express`, `fastify`, `koa` found **no listening socket in the Web Remote Control path**.
(`createServer` from `"net"` and `"http"` exists elsewhere — see §7.)

### 3.2 Remote relay — the desktop never sees these routes. [SI]

The relay is server-side (`zcode.z.ai`), not in the asar. From the desktop's usage we can state:

* `GET  wss://zcode.z.ai/ws?mid=<deviceMid>` — WS upgrade, header `X-Device-ID`.
  Device role; `auth_init.role = "device"`.
* The same relay also serves `https://zcode.z.ai/remote/v4` — the web app whose URL is encoded in the QR.
* `https://zcode.z.ai/web-remote/callback` — declared in the endpoint bundle; not used by the desktop WRC code path. **[H]** its role (likely OAuth/web-handoff return).

### 3.3 MessagePort "service port" (not a network port) — [C]

`attach-service-port` is an **Electron `MessageChannelMain` MessagePort transferred to the host
process**, not a TCP port. `x/main-index.js` @ **1 347 841** `createWebRemoteControlSharedHostAttachments`:

```js
function attachLocalHost(windowId) {
  const { port1, port2 } = createMessageChannel();          // MessageChannelMain
  const attachmentId = `shared-host-attachment-${++seq}`;
  hostProcess.postMessage({
    type: "attach-service-port", requestId: `shared-host-request-${seq}`,
    attachmentId, clientMode: "web-remote-replayable", scope: { kind: "local" }
  }, [port2]);
  return { entryId: `desktop-host:${windowId}`, attachmentId, process, port: port1 };
}
async function attachWorkspaceHost(windowId, target) {
  if (target.kind === "local") return attachLocalHost(windowId);
  // remote workspaces:
  const h = attachRemoteWorkspaceSessionHost({ windowId, remoteSessionId, workspacePath,
                                               workspaceIdentity, workspaceKey, clientMode: "web-remote-replayable" });
  return { entryId: `remote-session-host:${remoteSessionId}`, attachmentId, process, port, remoteKind };
}
```

Zod schema for both (`x/chunks/out_main_chunk-WR3FEWGO.js` ~499 901 and
`x/chunks/out_host_chunk-RWMCBKS2.js` ~478 585) — **[C]** verbatim:

```ts
attachServicePort = {
  type: "attach-service-port", requestId: string, attachmentId: string,
  clientMode: "desktop-continuous" | "web-remote-replayable",
  scope: { kind: "local" } | { kind: "remote", remoteSessionId, workspacePath, workspaceIdentity }
}
detachServicePort = { type: "detach-service-port", attachmentId: string }
```

The `clientMode` value in force for Web Remote Control is **`"web-remote-replayable"`**; plain
`"desktop-continuous"` is used by the desktop's own browser-use / embedded-browser path.

### 3.4 The tunnelled inner protocol is binary, not NDJSON — [C]

`x/chunks/out_main_chunk-X2DDW7XG.js` (13 KB, imported by `out/main/index.js` as
`import{d as _w}from"./chunk-X2DDW7XG.js"`):

* `SocketProtocol` — 13-byte frame header: `u8 type | u32 id | u32 ack | u32 dataLength | data…`
* `MessagePortProtocol` (`V`, exported as `d` = the `_w` used by the bridge) — `postMessage(bytes)`
  plus a JSON control message `{__zcodeRpcControl:"connection-flow-v1", state:"saturated"|"drained"}`
* `ChannelClient` (`D`) — request ids, message types **200** = initialize, **201** = response,
  **202** = error, **203** = event, **204** = event payload, **100/101/102/103** = request/cancel/
  subscribe/unsubscribe. Value encoding is a VQL binary serializer with tags
  `Undefined/String/Buffer/VSBuffer/Array/Object/Int`, nested `Uint8Array` escaped as
  `{"__zcode_rpc_nested_uint8array_v1":true,"base64":…}`.

`createWorkspaceBridge` (`ut`) in `x/main-index.js` @ **1 169 101** wires it up:

```js
const hostProto  = new MessagePortProtocol(wrapElectronPort(attachment.port));            // _w
const relayProto = createAcknowledgedWebRemoteControlRelayProtocol({                      // _N
  bridgeSessionId, bridgeGeneration, recoveryId,
  measureFrameBytes: (f) => transport.measurePayloadBytes?.(f) ?? measure(f),
  sendFrame: (f) => { if (!bridge.readyAnnounced || bridge.degraded) return false;
                      const r = sendPayloadToTransport(rt, f);
                      if (r.kind === "oversize") throw new Error("remote.rpcFrame.envelopeTooLarge");
                      return r.kind === "sent"; }
});
hostProto.onMessage(f => relayProto.protocol.send(f));
relayProto.protocol.onMessage(f => hostProto.send(f));
relayProto.onDegraded(f => degradeBridgeAfterRawFault(rt, bridge, f.reasonCode));   // -> "bridge-degraded"
relayProto.onSaturated(() => hostProto.sendFlowState("saturated"));
relayProto.onDrained(()   => hostProto.sendFlowState("drained"));
```

So: **binary VQL ChannelClient message → 13-byte framed bytes → `rpc-frame` JSON fragments →
relay `{type:"data"}` JSON → WSS.** No NDJSON on this path.

---

## 4. Authentication & pairing

### 4.1 Credential generation — [C]
`x/main-index.js` @ **1 178 500**, `createNodeWebRemoteControlRelayAuthProvider` (`TK`):

```js
createPassword: () => randomBytes(24).toString("base64url"),                       // 32-char urlsafe secret
createPassHash: (password) => createHash("sha256").update(password).digest("base64"),
calculateProof: (passHash, nonce, role, deviceSid) =>
    createHmac("sha256", passHash).update(`${nonce}|${role}|${deviceSid}`).digest("base64url")
```

* There is **no short numeric pairing code** in the desktop↔relay flow. "Pairing" = the phone
  presents `sid` + `hash` (from the QR) and gets `pair_status:"matched"`. **[C]**
* The QR therefore carries a **bearer secret** (`hash` = SHA-256 of the password, base64). Anyone
  who photographs the QR can pair. **[SI]**

### 4.2 QR / connect URL — [C]
`x/chunks/out_main_chunk-WR3FEWGO.js` @ **529 638**, `buildWebRemoteControlExternalQrUrl` (`ZV`):

```js
function buildWebRemoteControlExternalQrUrl({ baseUrl, deviceSid, passHash, timestamp,
                                              deviceMid, deviceName, appVersion, theme }) {
  const p = new URL(baseUrl);
  p.searchParams.set("sid", deviceSid);
  p.searchParams.set("hash", passHash);
  p.searchParams.set("t", String(timestamp));
  if (deviceMid ?.trim()) p.searchParams.set("mid", deviceMid);
  if (deviceName?.trim()) p.searchParams.set("name", deviceName);
  if (appVersion?.trim()) p.searchParams.set("app_version", appVersion);
  return p.toString();
}
```
`theme` is destructured but **never written to the URL** (dead parameter). **[C]**

Caller (`J2` in main-index @ 1 177 003):
`buildWebRemoteControlExternalQrUrl({ baseUrl: remoteUrl ?? mobileRemoteControlUrl, deviceSid, passHash, timestamp: Date.now(), deviceMid, deviceName, appVersion, theme })`.

**Example (reconstructed, v4):**
```
https://zcode.z.ai/remote/v4?sid=dvc_01H…&hash=U9n0…%3D&t=1757890123456
  &mid=8f3c…-uuid&name=DESKTOP-ABC&app_version=3.11.2
```
`connectUrl === qrUrl` — the dialog uses the same string for the QR image and the "copy link" button. **[C]**

Where the values come from:
* `deviceMid` = `ensureDesktopDeviceMidSync()` (`xg`, main-index @ 817 916) → reads/creates
  `deviceMid` in `<configDir>/telemetry-state.json`. **[C]**
* `deviceName` = `os.hostname()`. **[C]**
* `appVersion` = build version `3.11.2`. **[C]**

### 4.3 Where the credential is stored — [C]
`createWebRemoteControlRelayAuthStorageProvider` (`AK`) @ **1 179 068**:

| Piece | Store | Key |
|---|---|---|
| `deviceSid` | app settings | `webRemoteControlExternalRelayDevice: { deviceSid: string }` |
| `passHash` | **credential service** (OS keychain–backed) | `web-remote-control:external-relay:pass_hash` |
| last-enabled context | app settings | `webRemoteControlLastEnabledContext: { workspacePath, workspaceIdentity?, initialTaskId? }` |

Zod schemas in `x/preload-index.cjs` @ ~380 301/380 328:
```ts
Tg (webRemoteControlExternalRelayDevice)  = { deviceSid: string }
wg (webRemoteControlLastEnabledContext)   = { workspacePath: string, workspaceIdentity?: string, initialTaskId?: string }
```
Partial state is treated as corruption and both halves are cleared (`"external relay auth partial state cleared"`).

### 4.4 Relay handshake and headers/params — [C]
`WebRemoteControlDeviceTransport.handleMessage` / `sendAuthInit`:

```jsonc
// register (first ever run)
→ { "type":"device_register_init", "device_mid":…, "pass_hash":…, "meta":{"platform","version","name"}, "client_ts":<ms> }
← { "type":"device_register_ack", "device_sid":"…" }

// authenticate (every connect)
→ { "type":"auth_init", "role":"device", "device_sid":"…", "meta":{…}, "client_ts":<ms> }
← { "type":"auth_challenge", "nonce":"…" }
→ { "type":"auth_response", "device_sid":"…", "proof":"<HMAC-SHA256 base64url>", "client_ts":<ms> }
← { "type":"auth_ack", "pair_status":"waiting"|"matched" }

// liveness (every ~10 s ±20% jitter, ack watchdog 30 s)
→ { "type":"pair_status_query", "device_sid":"…", "client_ts":<ms> }
← { "type":"pair_status_ack", "pair_status":"waiting"|"matched" }

// application traffic
→/← { "type":"data", "payload": <AppPayload | rpc-frame | rpc-frame-ack>, "client_ts":?, "server_ts":? }

// fault
← { "type":"error", "code":"…", "message":"…" }
```

Relay error codes handled: **`KICKED`** (close + immediate reconnect), **`AUTH_FAILED`** (if the
persisted hash is rejected: clear stored auth once, re-`register`, reconnect immediately),
**`INTERNAL`** (paired ⇒ drop to `waiting_terminal`; otherwise recoverable error),
**`WRONG_PARAM`** (surface error). **[C]**

Transport states: `idle | connecting | registering | authenticating | waiting_terminal | paired | error` (plus transient `kicked` mapping). **[C]**

There are **no custom HTTP headers or query params** carrying the credential other than
`?mid=` / `X-Device-ID` (non-secret machine id, for connection affinity) — the credential travels
*inside* the relay JSON messages (`pass_hash`, `device_sid`, `proof`). **[C]**

Heartbeats (`WR3FEWGO` @ ~529 900): `getWebRemoteControlHeartbeatJitterMs` (20 % of interval, cap 2 s),
`getWebRemoteControlHeartbeatDelayMs` (10 s default), `getWebRemoteControlReconnectJitterMs`
(default cap 2 s), stale-waiting recovery timer 15 s, ack watchdog 30 s, reconnect delay 1 s. **[C]**

### 4.5 `reset-web-remote-control-pairing` — [C]
Handler calls `authorizeStart` then `resetPairingAuthorized`, which delegates to `resetPairing(windowId, ctx)`:

```js
async resetPairing(windowId, ctx) {
  e.featureGate.assertEnabled();
  await stopWindowRuntime(windowId, "leaked-qr");                  // teardown + status "idle"
  await resetExternalRelayDeviceAuth(e.authStorageProvider, e.logger, "leaked-qr");
  return this.start(windowId, ctx);                                 // fresh register → new sid/hash/QR
}
```
`resetExternalRelayDeviceAuth` (`RK`) does exactly two things:
```js
await patchSettings({ webRemoteControlExternalRelayDevice: undefined });
await credentialService.delete("web-remote-control:external-relay:pass_hash");
```
So it **rotates the device identity and invalidates every previously scanned QR**. The UI label is
"刷新 Web 远程控制二维码" (refresh QR) and it is confirmation-gated. **[C]**

---

## 5. On-the-wire payload schema

### 5.1 Two nested layers — [C]

```
WSS text frame
└─ RelayMessage (JSON, one per frame)
   └─ type:"data" → payload:
      ├─ AppPayload          (zcode_type union; control plane)         ← §5.2
      └─ rpc-frame / rpc-frame-ack  ({dataBase64} fragments)           ← §5.3
         └─ reassembled bytes = binary ChannelClient/VQL (13-byte framing)  ← §3.4
            └─ e.g. zcodeSessionService.* RPC calls
```

### 5.2 App payload union — [C]
`parseWebRemoteControlAppPayload` (`eW`, exported `$a`) and the array `lC` in
`x/chunks/out_main_chunk-WR3FEWGO.js` @ **494 188 – 497 173**:

```ts
type AppPayload =
 | { zcode_type:"bootstrap-request",            requestId }
 | { zcode_type:"bootstrap-response",           requestId, success:true, result:BootstrapResult }
 | { zcode_type:"workspace-list-request",       requestId }
 | { zcode_type:"workspace-list-response",      requestId, success:true, result:WorkspaceList }
 | { zcode_type:"workspace-list-updated",       result:WorkspaceList }
 | { zcode_type:"workspace-bridge-open",        requestId, bridgeSessionId, bridgeGeneration?, recoveryId?, workspaceKey, taskId? }
 | { zcode_type:"workspace-bridge-ready",       requestId, bridgeSessionId, bridgeGeneration?, recoveryId?, bridge:RuntimeWorkspaceTarget }
 | { zcode_type:"workspace-bridge-error",       requestId, bridgeSessionId?, bridgeGeneration?, recoveryId?, reason:FailureReason, error }
 | { zcode_type:"workspace-reconnect-request",  requestId, workspaceKey }
 | { zcode_type:"workspace-reconnect-response", requestId, workspaceKey, success:true }
 | { zcode_type:"workspace-reconnect-response", requestId, workspaceKey, success:false, error }
 | { zcode_type:"mobile-view-state-update",     viewState:ViewState, deviceInfo?:MobileDeviceInfo }
 | { zcode_type:"platform-request",             requestId, method:PlatformMethod, args?:unknown }
 | { zcode_type:"platform-response",            requestId, method:PlatformMethod, success:true, result:unknown }
 | { zcode_type:"platform-response",            requestId, method:PlatformMethod, success:false, error }
 | rpcFrame | rpcFrameAck
 | { zcode_type:"bridge-degraded",              bridgeSessionId, bridgeGeneration?, recoveryId?,
                                                 reason:"rpc-transport-fault"|"rpc-frame-gap"|"buffer-overflow"|"buffer-timeout",
                                                 seq?, expectedSeq?, droppedCount? }
 | { zcode_type:"app-error",                    requestId?, bridgeSessionId?, reason:FailureReason, error }
 | { zcode_type:"mobile-diagnostic",            event:"state-transition"|"socket-close"|"socket-error"|"recover-start"|"recover-scheduled"|"pair-status"|"failure",
                                                 timestamp, state?, previousState?, pairStatus?:"waiting"|"matched",
                                                 closeCode?, closeReason?, wasClean?, wasPaired?,
                                                 failureReason?, failureMessage?, visibilityState?, online?, hiddenDurationMs? }
```

Supporting shapes — **[C]** verbatim:

```ts
ViewState           = { activeWorkspaceKey?, activeTaskId?, updatedAt:number }
WorkspaceRef        = { workspacePath, workspaceIdentity?, remoteSessionId?, label,
                        workspacePurpose?:"project"|"conversation",
                        kind:"local"|"remote",
                        connectionState?:"connected"|"disconnected"|"reconnecting",
                        lastConnectionError? }
TaskRef             = { taskId, title, workspacePath, workspaceIdentity?, remoteSessionId?,
                        workspaceLabel, workspaceKind:"local"|"remote",
                        createdAt, updatedAt, provider?, unreadAt?,
                        displayStatus?:"idle"|"running"|"completed"|"error",
                        pinned?, archived? }
WorkspaceList       = { workspaces:WorkspaceRef[], tasks?:TaskRef[],
                        activeWorkspaceKey?, activeTaskId? }
BootstrapResult     = { windowControlSessionId, workspaces:WorkspaceRef[], tasks:TaskRef[],
                        initialViewState?:ViewState, mobileViewState?:ViewState }
RuntimeWorkspaceTarget =
   | { bridgeSessionId, bridgeGeneration?, recoveryId?, kind:"local",
       workspaceKey, workspacePath, initialTaskId? }
   | { bridgeSessionId, bridgeGeneration?, recoveryId?, kind:"remote",
       workspaceKey, workspacePath, workspaceIdentity, remoteSessionId, initialTaskId? }
MobileDeviceInfo    = { platform, version, name, userAgent?, language?, languages?, browserPlatform?,
                        viewport?:{width,height,devicePixelRatio}, screen?:{width,height},
                        timezone?, online?, updatedAt }
PlatformMethod      = "isDockerAvailable" | "listWSLDistros" | "listDockerContainers"
                    | "listSSHConfigAliases" | "loadMcpFromUserDirectory"
                    | "saveMcpToUserDirectory" | "migrateLegacyCommonMcp"
FailureReason       = "session-not-found" | "session-expired" | "session-conflict"
                    | "workspace-closed" | "desktop-disconnected" | "invalid-mobile-connection"
                    | "desktop-bootstrap-timeout" | "connection-recovery-timeout"
                    | "relay-unavailable" | "unsupported-action" | "unexpected-error"
```

Dispatch table `routePayload` (`q2`, main-index @ 1 169 5xx):
`bootstrap-request`, `workspace-list-request`, `platform-request`, `mobile-view-state-update`,
`workspace-bridge-open`, `workspace-reconnect-request`, `rpc-frame`, `rpc-frame-ack`,
`mobile-diagnostic`; all others ignored. **[C]**

### 5.3 `rpc-frame` fragment schema — [C]
`x/chunks/out_main_chunk-WR3FEWGO.js` @ **471 600 – 476 400**:

```ts
const LIMITS = { maxPhysicalFrameBytes: 1024*1024,      // = Ho.maxFrameBytes
                 maxMessageBytes:      16*1024*1024,
                 maxFragments:         64,
                 assemblyTimeoutMs:    30_000,
                 transportIdMaxChars:  256 };

const id   = string.min(1).max(256).regex(/^[A-Za-z0-9._~-]+$/);
const identity = { bridgeSessionId: id, bridgeGeneration?: int>=0, recoveryId?: id };

rpcFrame = { zcode_type:"rpc-frame", ...identity,
             seq, messageSeq,                                  // 1-based, safe-integers
             fragmentIndex: 0..maxFragments-1, fragmentCount: 1..maxFragments,
             messageBytes: 1..maxMessageBytes,
             checksum: { algorithm:"crc32", value:/^[0-9a-f]{8}$/ },
             dataBase64: canonical-base64, min 4 chars, <= maxPhysicalFrameBytes }    // .strict()

rpcFrameAck = { zcode_type:"rpc-frame-ack", ...identity, ackMessageSeq }              // .strict()

relayDataEnvelope = { type:"data", payload: rpcFrame | rpcFrameAck,
                      client_ts?, server_ts? }                                        // .strict()
```

Fault `reasonCode` vocabulary (all `remote.rpcFrame.*`): `invalidIdentity`, `invalidPhysicalSeq`,
`invalidMessageSeq`, `invalidPhysicalLimit`, `invalidMessageLimit`, `invalidFragmentLimit`,
`invalidTimeout`, `emptyMessage`, `messageTooLarge`, `fragmentLimitExceeded`, `envelopeTooLarge`,
`sequenceOverflow`, `internalEnvelopeError`, `encodingFailed`, `outerMeterFailed`,
`invalidBase64`, `invalidMetadata`, `identityMismatch`, `physicalSequenceExhausted`,
`messageSequenceExhausted`, `physicalGap`, `messageGap`, `fragmentGap`, `metadataMismatch`,
`checksumMismatch`, `conflictingDuplicate`, `assemblyTimeout`, `ackGraceExceeded`,
`replayGraceExceeded`, `manuallyDegraded`. **[C]**

Acknowledged-relay flow control (`AcknowledgedWebRemoteControlRelayProtocol`, `At`, exported `b` = `_N`;
`x/chunks/out_main_chunk-NHZHAM44.js` @ **41 492 / 48 921**):

```ts
{ saturationHighWaterMarkBytes: 1024*1024,      // default 1 MB
  saturationLowWaterMarkBytes:   256*1024,      // default 256 KB
  replayBufferMaxBytes:          8*1024*1024,   // hard cap 8 MB
  replayBufferGraceMs:          45_000,         // hard cap 45 s
  assemblyTimeoutMs:             30_000 }
```
`rpc-frame-ack` releases the replay buffer through `ackMessageSeq`; the peer is expected to replay
unacknowledged batches after a reconnect (`onSendReady → replayUnacknowledged()`). **[SI]**

### 5.4 Representative message pair — [C, reconstructed from the schema + dispatch]

**(a) Mobile opens a workspace (control plane):**
```json
{ "type":"data",
  "payload": { "zcode_type":"workspace-bridge-open",
               "requestId":"req-7f1a",
               "bridgeSessionId":"bs_9c02…","bridgeGeneration":1,"recoveryId":"rec-44b1",
               "workspaceKey":"/home/me/proj","taskId":"5f2c9d1e-…" },
  "client_ts":1757890152000 }
```
```json
{ "type":"data",
  "payload": { "zcode_type":"workspace-bridge-ready",
               "requestId":"req-7f1a",
               "bridgeSessionId":"bs_9c02…","bridgeGeneration":1,"recoveryId":"rec-44b1",
               "bridge":{ "bridgeSessionId":"bs_9c02…","bridgeGeneration":1,"recoveryId":"rec-44b1",
                          "kind":"local","workspaceKey":"/home/me/proj",
                          "workspacePath":"/home/me/proj","initialTaskId":"5f2c9d1e-…" } },
  "server_ts":1757890152118 }
```

**(b) Same, but the RPC plane (first fragment of a 3-fragment message):**
```json
{ "type":"data",
  "payload": { "zcode_type":"rpc-frame",
               "bridgeSessionId":"bs_9c02…","bridgeGeneration":1,"recoveryId":"rec-44b1",
               "seq":1,"messageSeq":17,
               "fragmentIndex":0,"fragmentCount":3,"messageBytes":40960,
               "checksum":{ "algorithm":"crc32","value":"9f3ab21c" },
               "dataBase64":"AQAAAAA…" },
  "client_ts":1757890152500 }
```
```json
{ "type":"data",
  "payload": { "zcode_type":"rpc-frame-ack",
               "bridgeSessionId":"bs_9c02…","bridgeGeneration":1,"recoveryId":"rec-44b1",
               "ackMessageSeq":17 },
  "server_ts":1757890152530 }
```

### 5.5 Is it "ZCode Protocol v4 NDJSON"? — **[C] NO** (it is an adjacent protocol)

* Web Remote Control payloads are **one JSON object per WebSocket message** (`JSON.parse` of the
  whole frame). No newline delimiting, no `<json>\n` framing. **[C]**
* The inner tunnelled traffic is the **binary** `ChannelClient`/VQL protocol over the MessagePort
  attachment. **[C]** (§3.4)
* The **ZCode Protocol v4 NDJSON** does exist in the same binary, but on other transports:
  * `assertV4AttachmentNdjsonEnvelope` (`Lk`, host-index @ **306 299**):
    `if (utf8JsonByteLength({id:"9"*32, method, params}) + 1 > LIMITS.maxFrameBytes) throw new Error("proto.frameTooLarge")`
    → envelope is `{"id":…,"method":…,"params":…}\n`, **1 MB** per line. **[C]**
  * Envelope encoder `pJ` = `utf8JsonByteLength` (JSON length), imported from
    `chunk-BG4MS6RN.js` (`_e as V`); limit `Gc` = the `{maxFrameBytes: 1024*1024, …}` bundle. **[C]**
  * Params builders: `buildSessionCreateParams`, `buildSessionResumeParams`,
    `buildSessionSendParams`, `buildSessionCompactParams` (host-index @ ~306 300–308 900). **[C]**
  * `-32602 Invalid params`, `-32601` JSON-RPC error codes with a
    `"Invalid params — <json>"` payload carrying zod issues. **[C]**
  * Topic wire frames: `wireVersion`, `kind:"complete"|"fragment"`,
    `deliveryKind:"initial"|"online"|"recovery"`, `logicalFrameId`, `logicalFrameOrdinal`,
    `topic` ∈ `conversation/<id>` | `sessions-index/<id>` | `workspace-config/<id>`,
    `subscriptionId`, `frame`, plus `crc32` checksum and `dataBase64` when fragmented. **[C]**
  * Handshake: `{kind:"hello", protocolVersion, connectionId, clientMode, deliveryProfile,
    serverTime, capabilities:{nativeDialogs,localTerminal,binaryFrames,compression,
    workspaceHookReview}, auth:{userId?}}` and
    `{kind:"clientHello", protocolVersion, clientId, clientKind:"desktop"|"web"|"mobileRemote"|"mobileApp",
      appVersion, capabilities?}`. `clientMode:"desktop-continuous"` must pair with
    `deliveryProfile:"continuous"` (superRefine-enforced). **[C]**
  * `measureTopicNotificationEnvelopeBytes` explicitly compares three transports:
    `cliNdjsonBytes`, `channelSocketBytes`, `mobileRelayBytes` — confirming the mobile relay is a
    *third* transport, not the NDJSON one. **[C]**

`clientMode:"web-remote-replayable"` also appears in the task-command and browser-execute schemas:

```ts
promote_task_command = { type:"promote_task_command", commandId, clientMode:"web-remote-replayable" }
cancel_task_command  = { type:"cancel_task_command",  commandId, clientMode:"web-remote-replayable" }
browser-execute-request = { …, clientMode?: "desktop-continuous" | "web-remote-replayable", … }
```
and in the browser-execute call site: `clientMode: e.clientMode ?? "desktop-continuous"` (main-index @ 1 463 000).
The WRC bridge always passes `"web-remote-replayable"` when attaching. **[C]**

---

## 6. Lifecycle, persistence, status object

### 6.1 Start / stop triggers — [C]

| Trigger | Mechanism |
|---|---|
| User opens the Web Remote Control dialog | renderer `getWebRemoteControlStatus()`; if it does not already match this window/workspace it calls `startWebRemoteControl({workspacePath, workspaceIdentity, remoteSessionId, initialTaskId})` |
| App restart | `restorePreviouslyEnabled(windowId, workspaces)` is invoked from BOTH `zcode:sync-window-tabs` and `zcode:sync-web-remote-control-workspaces` handlers (main-index @ 1 411 431 / 1 488 674). It loads `webRemoteControlLastEnabledContext` and, if a matching workspace is pushed by the renderer, auto-starts |
| Stop (user) | `stopWebRemoteControl()` → `stop(windowId)` → teardown reason `"manual-stop"` + `startupRestoreStorageProvider.clear()` |
| Stop (window closed) | `webRemoteControlManager.disposeWindow(windowId)` from the window `"closed"` handler (main-index @ 1 310 037) |
| Stop (endpoint changed) | `handleZCodeEndpointChanged` → `h$.current?.suspend(id, "endpoint-changed")` (main-index @ 1 476 751) |
| Stop (remote session gone) | `failRemoteSession(remoteSessionId, "window-host:connection-closed", {reason:"workspace-closed", …})` (main-index @ 1 331 563) |
| Stop (auth rotated) | `resetPairing` → teardown reason `"leaked-qr"` |
| Stop (restart) | `start` itself first calls `stopWindowRuntime(windowId, "restart")` |

There is **no** OS-level listener (no autostart, no tray toggle) — restore is renderer-driven.

### 6.2 Persistence — [C]
Persisted: relay `deviceSid` (settings), `passHash` (credential store), and
`webRemoteControlLastEnabledContext` (settings). A restart therefore keeps the device identity
(no re-scan needed) and re-enables the feature for the last workspace **if that workspace is still
open**. `stop()` clears only the last-enabled context.

### 6.3 `get-web-remote-control-status` return — [C]

Three shapes:

1. Feature gate disabled:
   `{ status:"idle", failure:{ reason:"unsupported-action", message:"Web remote control is disabled in this build." } }`
   (gate factory `xK(e = true)` — default **enabled**; no env switch found.)
2. No live runtime for this window: `{ status:"idle" }`
3. Live runtime — `buildRuntimeStatus` (`O`, main-index @ ~1 163 000). **COMPLETE field list:**

```ts
{
  status:                 "starting" | "running" | "connecting" | "active" | "error" | "idle",
  sessionId:              string,                  // == deviceSid   (for multiple sessions, last one wins)
  windowControlSessionId: string,                  // == deviceSid; canonical, matches bootstrap-request
  mobileConnected:        boolean,
  mobileViewState:        { activeWorkspaceKey?, activeTaskId?, updatedAt } | undefined,
  mobileDeviceInfo:       { platform, version, name, userAgent?, language?, languages?,
                            browserPlatform?, viewport?:{width,height,devicePixelRatio},
                            screen?:{width,height}, timezone?, online?, updatedAt } | undefined,
  qrUrl:                  string,                  // == connectUrl
  connectUrl:             string,                  // == qrUrl
  workspacePath:          string,
  workspaceIdentity:      string | undefined,
  remoteSessionId:        string | undefined,
  initialTaskId:          string | undefined,      // currentBridge.initialTaskId ?? runtime.initialTaskId
  error:                  string | undefined,
  failure:                { reason: FailureReason, message?: string } | undefined
}
```

`status` state machine (`mapTransportState`, `V2`): transport `connecting|registering|authenticating`
→ `status:"starting"` (or `"active"` if a mobile was already connected); `waiting_terminal` →
`"running"` (mobile not yet paired); `paired` → `"active"` + `mobileConnected=true` + flush outbound
buffer; `kicked` → terminal `failure={reason:"session-conflict", message:"Web remote control connection was kicked by relay."}`;
`error` → `"error"`. A 3 s grace timer (`lhe = 3e3`) downgrades `active`→`running` on mobile drop.
**[C]**

`statusChanged` is pushed to the owning window only:
`onStatusChanged: (windowId, status) => sendWebRemoteControlStatusChangedToWindow(BrowserWindow.fromId(windowId), status)`
→ `webContents.send("zcode:web-remote-control-status-changed", status)`. **[C]**

### 6.4 The value returned by the `start` / `refreshPairing` invokes — [C, verbatim]
Note it is a **subset** of the pushed status (no `mobileConnected` / `mobileViewState` /
`mobileDeviceInfo` / `error` / `failure`; and `status` is collapsed to `"active"|"running"`):

```js
{
  status: tt.status === "active" ? "active" : "running",
  sessionId: deviceSid,
  windowControlSessionId: deviceSid,
  qrUrl, connectUrl,
  workspacePath, workspaceIdentity, remoteSessionId, initialTaskId
}
```

### 6.5 Renderer status semantics (cross-check) — [C]
`out/renderer/assets/styles-DyAcaLKy.js` @ ~3 072 882:
* label switch on `idle | starting | running | connecting | active | error`
* failure→message switch on the 11 `FailureReason` values (`session-conflict` with a message
  containing `"kicked"` maps to a distinct "kicked" copy)
* a legacy comparison helper still references `deviceToken` and `expiresAt` (fields **no longer
  produced** by the 3.11.2 status object — dead code)
* the dialog polls `getWebRemoteControlStatus()` **every 1 000 ms** while open, and renders the QR
  with `QRCode.toDataURL(qrUrl, {margin:1, width:320})`

### 6.6 `sync` channels — [C]
* `zcode:sync-web-remote-control-workspaces` ← renderer pushes `WorkspaceRef[]` (validated by `fh`).
  Main stores per-window, then `pushWorkspaceListUpdated` sends
  `{zcode_type:"workspace-list-updated", result:{workspaces, tasks, activeWorkspaceKey, activeTaskId}}`
  **only when a signature (`JSON.stringify` of sorted keys) changes**.
* `zcode:sync-web-remote-control-tasks` ← renderer pushes `TaskRef[]` (validated by `hh`).
  The renderer only pushes when WRC `status` is `running` or `active`.
* `zcode:web-remote-control-reconnect-workspace` — main→renderer request
  `{requestId:"web-remote-reconnect-<ts>-<rand>", workspaceKey}`, renderer replies
  `{requestId, workspaceKey, success:true}` or `{requestId, workspaceKey, success:false, error}`;
  120 s timeout.

---

## 7. Every other network-reachable surface (main / host / scheduler)

Deduplicated sweep (`x/main-index.js` == `x/chunks/out_main_index.js`; `x/host-index.js` == `x/chunks/out_host_index.js`).
Grep targets: `createServer`, `.listen(`, `WebSocketServer`, `createConnection`, `WebSocket(`,
`from"net"`, `from"http"`, `from"https"`, `from"ws"`, `hono`, `express`, `fastify`, `koa`, `0.0.0.0`.
Note: `.listen(` matches in chunks `X2DDW7XG`/`KGXW6KHC` are the RPC **event subscription**
`listen(channel, event, arg)` method, not sockets.

### 7.1 Listening sockets — complete list

| # | Process | Primitive | Bind | Purpose | Evidence |
|---|---|---|---|---|---|
| 1 | **host process only** | `http.createServer` | **`127.0.0.1:0` (ephemeral port)** | **Remote media-preview proxy.** Path prefix `"/__zcode_media/"`; `GET`/`HEAD` only, `405` otherwise, `404` for unknown/expired token, `416` invalid `Range`, `429` when > 2 concurrent ranges, `409` if the file changed. URL shape `http://127.0.0.1:<port>/__zcode_media/<token>`; token = `randomBytes(32).toString("hex")`; lease TTL 7200 s, idle TTL 600 s, max file 512 MB, chunk 1 MB, max 2 concurrent. Scoped to `workspaceIdentity\0remoteSessionId`. **Registered in the channel server only when `scope.kind === "remote" && clientMode === "desktop-continuous"`** (`x/host-index.js` @ 2 295 248) — a *web-remote-replayable* (Web Remote Control) attachment does **not** get this proxy. | `x/host-index.js` @ **2 203 631 / 2 214 800 / 2 210 946** (`listen({host:"127.0.0.1",port:0})`, `var J4="/__zcode_media/"`, `createRemoteMediaPreviewProxy`). Literal `__zcode_media` occurs **only** in `x/host-index.js`. |
| 2 | **host process only** | `net.createServer` | **UNIX domain socket** at `<ZCODE_HOME or configDir>/computer-use/run/<name>` (+ reservation socket at `<path>.host-reservation`, pending path `<path>.pending`) — *not* TCP | **CUA (Computer Use) permission broker** JSON-RPC. Auth token = `randomBytes(32).toString("hex")`, sent as the first NDJSON line `{"id":0,"method":"authenticate","params":{"token":…}}\n`. `maxFrameBytes` default **67 108 864 (64 MB)**. Directory forced to `0700`, socket `0600`, refuses paths not owned by the current uid, socket path length budget 100 chars. Optional dev exposure writes `broker-credentials.json` when `ZCODE_CUA_DEV_EXPOSE_BROKER=1`. | **server:** `x/host-index.js` @ 518 549 (`createConnection as cgt, createServer as dgt`) and @ **929 611** (`createServer as mNe`; `.host-reservation`, `.pending`, `listenOn`, `ZCODE_CUA_DEV_EXPOSE_BROKER` ×4). **client only:** `x/main-index.js` @ 73 050 / 446 427 (imports unused: `EGe`/`hst` occur once each); `x/chunks/out_scheduler_index.js` @ 618 116 / 967 735 (`zVe`/`ydt` occur once each, `host-reservation` 0×) |
| 3 | **host process only** | `http.createServer` | `127.0.0.1:<ZCODE_OFFPEAK_MOCK_PORT or 45197>` | **Off-peak mock gateway — E2E/test only**, gated on `ZCODE_OFFPEAK_MOCK==="1"`. Routes: `GET /__e2e/off-peak/requests`, `GET /api/v1/off-peak/ticket/availability`, `POST /api/v1/off-peak/ticket`, `POST /api/v1/off-peak/ticket/status`, `POST /api/v1/off-peak/ticket/:id/settle`, `POST /api/v1/off-peak/anthropic/v1/messages` (proxies upstream). On `EADDRINUSE` it reuses the existing instance. | `x/host-index.js` @ **2 104 966 / 2 110 749 / 2 111 265** — `ZCODE_OFFPEAK_MOCK` occurs **25×** in `x/host-index.js` and **0×** in main and scheduler |
| 4 | Electron (dev only) | Chromium CDP | `127.0.0.1:9229` | `app.commandLine.appendSwitch("remote-debugging-port","9229")` when `!app.isPackaged` and `ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT!=="1"` | `x/main-index.js` @ **1 457 060** |

**Total listening sockets in the entire product: 2** — one loopback HTTP ephemeral port and one
UNIX socket, both in the **host** process (plus the E2E-only mock gateway, off by default).
Neither is exposed by, related to, or reachable from Web Remote Control.

**No other listener exists.** `0.0.0.0` appears in `x/main-index.js` only inside an SSRF
**block-list** (`BlockList` with `0.0.0.0/8`, RFC1918, CGNAT, link-local, TEST-NET, multicast,
`::`, `::1`, `fc00::/7`, `fe80::/10`, `ff00::/8`, `2001:db8::/32`) used to reject remote image
downloads that resolve to private addresses (`resolvePublicRemoteUrl`, ~1 403 887).

### 7.2 Outbound clients (no listener, but network-reachable)

| Target | Purpose | Transport | Evidence |
|---|---|---|---|
| `wss://zcode.z.ai/ws`, `wss://zcode.chatglm.site/ws` | **Web Remote Control relay (device)** | `ws` WebSocket, `perMessageDeflate` | main-index @ 1 144 858 |
| `<server>/ws/host?token=<token>` | **Remote-workspace "server" target** (`kind:"server"`, `{url, token}`) — the ZCode Protocol host RPC over WS | `ws` WebSocket, header `x-zcode-rpc-host-capability: <capability>` + `Authorization: Bearer <token>` | host-index @ **2 231 523–2 233 500**; `resolveServerRemoteEndpoints` builds `infoUrl=<base>/api/server-info`, `wsUrl=<base>/ws`, `hostCapabilityUrl=<base>/api/rpc-host-capability`, `hostWsUrl=<base>/ws/host` |
| `<base>/api/server-info` | GET, `Authorization: Bearer <token>` → `{serverId, name?, version, protocolVersion:1, authRequired, workspaces:[{path,label?,workspaceIdentity?}], capabilities:{desktopContinuous:true, websocketRpc:true}}` | HTTPS | host-index @ 2 231 800 (`fetchServerInfo`) |
| `<base>/api/rpc-host-capability` | **POST**, `Authorization: Bearer <token>` → `{capability, expiresAt}` (strict) | HTTPS | host-index @ 2 232 600 (`fetchHostCapability`) |
| `http://<localhost>` (random port) | **CDP** to a headless Chrome the app launches itself (`--headless=new … --remote-debugging-port=0`), then reads the DevTools ws URL from a temp file. Class `WebSocketCdpTransport`. | `ws` WebSocket (JSON CDP) | main-index @ **1 029 630 / 1 033 120** |
| `https://api.telegram.org/bot<token>/…`, `…/file/bot<token>/…` | Telegram bot long-polling + file download | HTTPS | host-index literals |
| `https://open.feishu.cn`, `https://accounts.feishu.cn`, `https://open.larksuite.com`, `https://accounts.larksuite.com` | Feishu/Lark bot WebSocket + OAuth | HTTPS/WSS | host-index literals |
| `https://ilinkai.weixin.qq.com` | WeChat bot | HTTPS | host-index literal |
| `https://zcode.z.ai/api/v1/oauth/token`, `https://chat.z.ai/api/oauth/authorize`, `…/api/oauth/userinfo`, `https://api.z.ai/api/auth/z/login`, `https://bigmodel.cn/login`, `https://open.bigmodel.cn/api/anthropic` | OAuth / login / provider endpoints | HTTPS | main+host literals |
| `https://zcode.z.ai/api/v1/event/report` | telemetry | HTTPS | main literal |
| `https://cdn.zcode-ai.com/zcode/electron/releases`, `https://cdn.codegeex.cn/zcode/electron/releases` | auto-update feed | HTTPS | main literal |
| `http://<intranet host>:12345/zcode`, `http://<intranet host>:3850/api/intranet/probe` | intranet mirror for remote-runtime assets (`INTRANET_MACHINE_HOST`, default `studio.zcode-ai.com`) | HTTP | main+host |
| `https://proj-xtrace-…log.aliyuncs.com/rum/web/v2` | ARMS RUM telemetry | HTTPS | WR3FEWGO |
| SSH / WSL / Docker targets | remote workspace connect (out of scope of HTTP) | `child_process` ssh, `wsl.exe`, docker socket | main-index |
| Electron `net` module | renderer/main HTTP for the coding-plan webview etc. | Chromium net stack | main-index |

---

## 8. Note on a directly-relevant mismatch worth flagging

The relay's `WebRemoteControlRelayPayloadSerializer` (NHZHAM44 @ 48 997) builds
`{type:"data", payload, client_ts}` and caches it per object (WeakMap), and
`isOversize` rejects anything above **`maxPhysicalFrameBytes = 1 048 576`**.
`measurePayloadBytes` is also what the bridge uses to budget `rpc-frame` fragments —
so a single app payload and a single rpc-frame envelope are both capped at **1 MB**, while a
*logical* RPC message may be up to **16 MB** spread over up to **64** fragments. **[C]**

---

## 9. Evidence index (file / offset)

| Fact | File | Offset |
|---|---|---|
| IPC channel constants | `x/chunks/out_main_chunk-WR3FEWGO.js` | 10 127 |
| IPC channel constants (preload mirror) | `x/preload-index.cjs` | 478 255 |
| `contextBridge` WRC API | `x/preload-index.cjs` | 490 769 |
| Handler registration `registerWebRemoteControlIpcHandlers` | `x/main-index.js` | 1 417 724 |
| Endpoint constants (`ft`,`Xr`,`Yh`,`Xh`) | `x/chunks/out_main_chunk-WR3FEWGO.js` | 669–1 011 |
| `buildZCodeEndpointUrls` | `x/chunks/out_main_chunk-WR3FEWGO.js` | 4 183 |
| `resolveWebRemoteControlRelayWsUrl` | `x/chunks/out_main_chunk-WR3FEWGO.js` | 2 928 |
| `WebRemoteControlDeviceTransport` | `x/main-index.js` | 1 144 858 |
| `createWebRemoteControlManager` | `x/main-index.js` | 1 178 110 |
| `authorizeStart` / start TTL 30 s | `x/main-index.js` | 1 158 346 |
| `createNodeWebRemoteControlRelayAuthProvider` | `x/main-index.js` | 1 178 500 |
| Relay auth storage provider | `x/main-index.js` | 1 179 068 |
| Feature gate | `x/main-index.js` | 1 179 965 |
| `createWorkspaceBridge` | `x/main-index.js` | 1 169 101 |
| `createWebRemoteControlSharedHostAttachments` | `x/main-index.js` | 1 347 841 |
| Manager construction / env overrides | `x/main-index.js` | 1 466 208–1 468 400 |
| App payload union `lC` | `x/chunks/out_main_chunk-WR3FEWGO.js` | 494 188 – 497 173 |
| rpc-frame schema + limits `le` | `x/chunks/out_main_chunk-WR3FEWGO.js` | 471 600 – 476 400 |
| QR URL builder `ZV` | `x/chunks/out_main_chunk-WR3FEWGO.js` | 529 638 |
| Heartbeat/reconnect helpers | `x/chunks/out_main_chunk-WR3FEWGO.js` | 529 900 |
| MessagePort / ChannelClient protocol | `x/chunks/out_main_chunk-X2DDW7XG.js` | whole file |
| Acknowledged relay protocol + serializer | `x/chunks/out_main_chunk-NHZHAM44.js` | 41 492 / 48 921 / 48 997 |
| Topic wire frames + hello/clientHello | `x/chunks/out_main_chunk-NHZHAM44.js` | 6 462 / 33 570 |
| `attach-service-port` schema | `x/chunks/out_main_chunk-WR3FEWGO.js` | 499 901 |
| Limits bundle `Ho` (`maxFrameBytes` etc.) | `x/chunks/out_host_chunk-RWMCBKS2.js` | ~329 229 |
| Server-info / capability schemas | `x/chunks/out_host_chunk-RWMCBKS2.js` | 542 219 |
| `assertV4AttachmentNdjsonEnvelope` | `x/host-index.js` | 306 299 |
| Remote media-preview proxy | `x/host-index.js` | 2 203 631 / 2 214 800 |
| CUA broker socket | `x/main-index.js` 73 050 / 446 427; `x/host-index.js` 518 549 / 929 611 | — |
| Off-peak mock gateway | `x/host-index.js` | 2 104 966 / 2 110 749 |
| Remote server WS client | `x/host-index.js` | 2 231 523 – 2 234 800 |
| CDP transport + headless Chrome | `x/main-index.js` | 1 029 630 / 1 033 120 |
| Dev `--remote-debugging-port=9229` | `x/main-index.js` | 1 457 060 |
| Renderer dialog + status switches | `out/renderer/assets/styles-DyAcaLKy.js` | 3 069 600 – 3 079 500 |
