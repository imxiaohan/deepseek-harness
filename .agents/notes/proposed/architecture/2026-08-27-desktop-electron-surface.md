# Agent Note: Desktop surface — an Electron application over the reserved IPC carrier

Status: proposed

English | [中文](2026-08-27-desktop-electron-surface.zh.md)

## Problem

The GUI stack ships exactly one physical carrier: the Web composition's loopback HTTP server with its WebSocket downlinks and `frontend-static` dist serving. A desktop product needs the same host plugin tree and the same browser client roster without a listening port, plus integration a browser tab cannot provide: native directory dialogs, keychain-backed credentials, system notifications for pending approvals and questions, and application deep links.

The [GUI layering record](../../archived/architecture/2026-07-19-gui-layering-and-rpc-protocol.md) — now archived — reserved exactly this slot: "a future Electron application reuses the same web client packages over an IPC fetch carrier", with `dsh-host-webserver` explicitly not reused. No shell exists. The reserved seams are unproven at desktop scale: `window.__DSH_TRANSPORT__` has exactly one in-repo provider (the experimental webworker runtime's tunnel), the transport-subclass reservation is a hypothetical row in that archived record, and no composition has booted the client roster without the HTTP carrier. Repository placement is also undecided: this monorepo versus a separate repository consuming published packages.

## Proposal

Build the desktop surface as a third application in this repository. `apps/desktop` is an Electron application booted over a new `desktop` profile (`@deepseek-ai/dsh-base` plus a new `@deepseek-ai/dsh-desktop-app` bundle patch). The host plugin tree, the wire protocol, and the entire browser plugin roster stay unchanged; the new code is the IPC carrier, the Electron shell, and small native capability providers behind existing seams.

### Repository placement

This repository, not a separate one. The same-PR rule — an agent-loop or `SessionEventMap` change updates every client projection in one PR — is only enforceable where the carrier and the client roster live beside what they project. The apiproxy wire deliberately carries no protocol version because client and host ship together; a second repository would turn every pre-release repackaging into cross-repository version alignment and freeze contracts the root instructions explicitly keep unfrozen before the first tagged release. Extraction becomes correct only when the shell is a pure consumer of stable published packages — the same event the layering RFC names for introducing protocol version negotiation.

### Carrier design

- Host side: a desktop host plugin composes the transport-agnostic fetch handler exactly as the Web node half does — `HostConnectionService.createSharedFetchHandler('/api')` — and bridges the resulting `FetchHandler` over `ipcMain.handle` instead of mounting a webserver route. The Typert gateway's interceptor registration on `ctx.connection.rpc` is transport-independent and carries over unchanged.
- Virtual `webServer` service: the retained rows' node halves hard-inject `webServer` — `ClientModuleRegistry` (`inject: ['webServer', 'loader']`, the `/plugins` bundle route, the `webserver/index-inject` listener), the connection node half (the `/api` route), and the API Gateway's WebSocket upgrade — while `dsh-host-webserver` listens on activation and the layering record assigns it to Web only. The shell host plugin therefore provides a same-named virtual `webServer`: a route registry accepting `register`/`registerUpgrade`/`registerFallback`, plus the index-injection collection the desktop index render consumes. The custom-scheme handler serves the index and the `/plugins` bundle route from that registry; the IPC uplink bypasses the Node-HTTP routes and dispatches at fetch level through the shared handler, so the `/api` and upgrade routes registered into the virtual service exist only to satisfy the injection contract and are never hit by a request.
- Renderer side: the preload script sets `window.__DSH_TRANSPORT__ = { fetch, openStream, loadBundle, ownsHost: true }` before any client plugin loads — the current `ClientTransportHooks` face. `dsh-client-connection`'s browser half already consumes that global (the served web app leaves it unset and gets HTTP plus the Gateway WebSocket), `dsh-client-modules`' module system accepts `loadBundle` as the bundle-byte seam, and the experimental webworker runtime is the working precedent.
- Uplink: the carrier rides the transport `fetch` hook — serialize the `Request` over `ipcRenderer.invoke`, run it through the shared fetch handler in the main process, serialize the `Response` back. Envelope minting, zod parsing, rpcId echo checks, and unary deadlines stay in the connection client. The client's `resolveBase` takes the page's same-origin, and a custom-scheme origin mints no loopback authority — a fetch `Request` carries no Host header of its own — so the bridge synthesizes an explicit loopback `host` header (`127.0.0.1`) when reconstructing the `Request`, letting the Host/Origin fence pass unchanged if the bridge applies `HostConnectionService.requestRejection` at its entrance; the bridge's WebContents-origin check is the outer gate.
- Downlink: the carrier rides the transport `openStream` hook — one async iterator per logical stream backed by a `MessageChannelMain` port; the webworker tunnel proves the hook substitutable. `ConnectionController` keeps handshake, reconnect, and baseline replay unchanged; a renderer reload is simply a connection-generation loss.
- Bundle bytes: a privileged custom scheme serves the application index — with the `__DSH_BOOT__` graph injected — and the plugin bundles, so the module system's default URL loading keeps working; `loadBundle` over IPC remains the documented alternative when the shell owns the bytes.

### New packages and composition

- `packages/bundle/desktop-app` (`@deepseek-ai/dsh-desktop-app`): a `cordis.patch.yml` over `dsh-base` mirroring the Web bundle's rows. It keeps `modules`, `connection`, `api-remotes`, the `api/*-controller` rows, the storage/workspace/projection rows, and the agent-plane rows the Web surface disables behind presets; it drops `webserver`, `web-runtime` (which carries `frontend-static` through its fallback seat), `web-startup`, and `client-hmr`, and inserts the desktop rows below; the Web `connection` row injects `webRuntime` for its `trustedHosts` config, so the desktop patch restates that row's config.
- `packages/host/desktop-electron` (`@deepseek-ai/dsh-host-desktop-electron`): the shell host plugin. It owns window lifecycle, menus, tray, the single-instance lock, deep links, the custom scheme handler, and the IPC bridge; it provides the virtual `webServer` service and a `desktopRuntime` service; it forwards answerable `approval/*` and `question/*` frames to system notifications, with answers routed through the same `/api/respond` path and pending-rpcId table the renderer uses — no second referee.
- `apps/desktop`: assembly only — mixtures stay in `apps/` per the layering RFC. The main process boots the `desktop` profile over `@deepseek-ai/dsh-app-boot`'s profile machinery; `runProfile` — today app-local in `apps/cli` — is lifted into `dsh-app-boot` as part of this work so both apps share fail-loud startup and the healed profile module fallback, and its process-signal semantics stay unchanged while the shell plugin owns Electron's `app.quit` ordering; electron-builder packaging, signing, and auto-update live here.
- `PROFILE_TEMPLATES` in `@deepseek-ai/dsh-app-boot` gains the `desktop` tuple, and `apps/cli` gains a `dsh desktop` subcommand aliasing `--profile desktop`, mirroring the `web` subcommand.
- Capability providers behind existing seams, each an independent small package: `@deepseek-ai/dsh-host-directory-picker-electron` implements `ctx.directoryPicker` with `dialog.showOpenDialog` ([the directory-picker seam](../../implemented/architecture/2026-07-28-directory-picker-capability-seam.md) makes `host.pickDirectory` unchanged), and a `safeStorage`-backed provider implements the credentials capability beside the `.env` provider.

### Privileged authority

On the Web carrier, every `/api` request passes the Host/Origin browser-trust fence plus persistent browser-session authentication (`HostConnectionService.requestRejection`) before dispatch, and the client gates the privileged surface — settings and credentials, agent-preset authoring, host-native actions — on `ctx.connection.isLoopback`, which holds for loopback page authorities, transports declaring `ownsHost`, and non-browser contexts. The desktop carrier makes the same decisions at its own entry points: the preload declares `ownsHost: true` (the webworker precedent — the renderer owns its host outright), the bridge synthesizes a loopback authority for the fence (carrier design above), and it accepts requests only from the application's own renderer WebContents — an in-app IPC channel is loopback-equivalent, and with no listening port there is no other process to fence. This is a non-escalation requirement: the set of callers authorized for privileged operations may not widen relative to the Web carrier ([the browser-trust decision](../../implemented/architecture/2026-07-28-api-browser-trust-boundary.md) stays authoritative for HTTP).

### Web-owned mechanics to share

- `__DSH_BOOT__` assembly already lives in the modules node half: `ClientModuleRegistry.graph()` and the exported `bootInjections()` produce the graph and its injection rows, and the webserver only collects them (the `webserver/index-inject` event) and renders them (the exported `renderIndexInjections` pure function). Nothing moves: the desktop index consumes the same service and generator and reuses the same render function, so both surfaces share one generator by construction.
- Client HMR: the Web composition disables shared HMR because its reload lifecycle is untested; desktop development composes against the loopback HTTP surface until a desktop reload row is warranted, rather than mounting an untested reload chain in a shipped composition.
- Versioning: none is introduced. The desktop bundle ships host and client together, so auto-update must replace the whole application; a partial renderer update would reintroduce an independently released client without protocol negotiation.

### Milestones

- M1, thin shell: the Electron main process boots the Web profile and the window loads the authenticated loopback URL (`BrowserAuth.authenticatedUrl`). This validates packaging, signing, auto-update, and emitting system notifications (the answer path is M3) with zero carrier work and must not become the end state. Shipped finding: the profile tree runs in a host child process — the same binary under `ELECTRON_RUN_AS_NODE=1` — because the vendored Loader's plugin imports fast-path through Node's internal ESM loader, which the Electron main process does not expose; the Loader's fallback now resolves against the config tree (vendor modification log), and the shell freezes user-patch reload because the vendored config-HMR service requires `--expose-internals`.
- M2, the desktop bundle and IPC carrier: the custom scheme, the preload transport, and the dropped webserver rows; the surface stops listening on any port.
- M3, native capability providers: the Electron directory picker, keychain credentials, deep links, and notification answers.
- M4, distribution hardening: crash isolation by forking the host tree into a child process if evidence demands it — the carrier interface survives that fork unchanged — plus the update channel.

### Testing

Carrier protocol tests run the full wire serialization, zod, and frame-decoding path over an in-memory IPC bridge, mirroring the connection package's in-memory fetch-handler wire tests. A REAL-composition test boots the `desktop` profile through the Loader and asserts zero listening ports and a complete `__DSH_BOOT__` graph. The in-memory bridge tests assert that the bridge mints requests with a loopback `host` header and pin `resolveBase`'s URL resolution under a custom-scheme origin; the REAL-composition test asserts the retained rows' fibers activate against the virtual `webServer` service. Desktop product-user-visible behavior adds a keyless snapshot through a real runnable example per [the testing policy](../../../../docs/testing.md), and the Web gates stay green without modification.

## Alternatives considered

**A separate repository consuming published packages.** It breaks the same-PR rule for client projections, forces pre-release contract freezing the root instructions reject, and demands protocol versioning the wire deliberately omits. Correct only after contracts stabilize for external consumers.

**Loopback HTTP inside Electron as the end state.** It keeps a listening port, the DNS-rebinding and origin attack surface, and the host-binding restrictions the Web carrier carries, and it reuses `dsh-host-webserver` the layering RFC explicitly assigns to Web only. Acceptable as milestone 1, rejected as the target.

**A non-Node shell (Tauri or similar).** The host tree is a Node plugin ecosystem — `node:sqlite`, `sandbox-exec`, the Landlock native addon, subprocess trees. A non-Node shell forces the host into a sidecar process and adds a process boundary for no capability gain.

**Forking the client roster into desktop-specific UI packages.** It duplicates every `ui-*` package the roster composes. Desktop differences go through new slot registrations in small packages, per the client export discipline.

**A second wire protocol for IPC.** The four-quadrant envelope is channel-independent by design; the carrier swap is a `doFetch` subclass plus two stream virtuals. A protocol fork would double every contract, schema, and test the apiproxy owns.

**The host tree in a child process from day one.** Crash isolation before evidence of need. The carrier interface survives a later fork unchanged, so the split is deferrable without redesign.

## Acceptance criteria

- `dsh desktop` and the packaged application boot the `desktop` profile with no listening TCP port, asserted by the REAL-composition boot test; the retained `modules` and `connection` rows activate against the shell's same-named virtual `webServer` service.
- The renderer completes the readiness handshake — `host.describe` plus both downlink streams — entirely over IPC; the only external `http(s)` requests are user-initiated navigations.
- The privileged method set is callable from the application's renderer and unreachable from any process outside the application, with no port to connect to.
- The browser plugin roster mounts unchanged: no `dsh.client` package is forked or duplicated, and the `__DSH_BOOT__` graph for the same roster matches the Web composition's.
- The desktop index render consumes the same graph generator the Web index rendering does (`bootInjections` from the modules node half); no graph code is duplicated or moved.
- Carrier protocol tests over the in-memory IPC bridge, the REAL-composition boot test, and at least one keyless snapshot of an assembled desktop transcript exist and pass; `pnpm run test:gui` and `DSH_SNAPSHOT=replay pnpm run test:web` stay green without modification.

## Risks

The reserved seams are unproven end-to-end. `window.__DSH_TRANSPORT__` has one in-repo provider (the experimental webworker runtime, inside a worker sandbox), and no composition has booted the client roster as a standalone application carrier; the desktop surface is the seam's first application consumer, and implementation may discover gaps in `dsh-client-connection` or `dsh-client-modules`. Fixes must land in the shared seam — benefiting the webworker runtime too — never as a desktop fork of either package.

Electron's application lifecycle interleaves with fiber disposal: `app.quit` ordering, renderer destruction mid-turn, and signal handling each need their own shutdown tests, following the defensive-patterns requirements for teardown work.

The desktop index render consumes the injection point every browser session trusts through a new physical path; the Web and desktop renders must serve identical graph content for the same roster, pinned by test.

System-notification answers add a second entry to the answer path for approvals and questions. They ride the existing pending-rpcId table, and a notification answer arriving after resolution collapses to the existing `not-pending` receipt; any second referee would fork the "first answer wins" rule.

Whole-application updates are a discipline risk: auto-update tooling that patches renderer assets alone would silently reintroduce an independently released client without protocol negotiation.

This note applies the archived layering record's carrier plan and does not supersede it; the active [transport layering record](../../implemented/architecture/2026-07-24-web-config-tree-boot-and-transport-layering.md) owns the current carrier boundaries and the [web client architecture](../../implemented/architecture/2026-07-19-gui-web-client-architecture.md) the browser object layer. The archived record is frozen: when this ships, the desktop rows update the active records in the same change, and the archived hypothetical IPC row stays historical.
