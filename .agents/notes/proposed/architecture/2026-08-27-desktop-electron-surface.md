# Agent Note: Desktop surface — an Electron application over the reserved IPC carrier

Status: proposed

English | [中文](2026-08-27-desktop-electron-surface.zh.md)

## Problem

The GUI stack ships exactly one physical carrier: the Web composition's loopback HTTP server with its WebSocket downlinks and `frontend-static` dist serving. A desktop product needs the same host plugin tree and the same browser client roster without a listening port, plus integration a browser tab cannot provide: native directory dialogs, keychain-backed credentials, system notifications for pending approvals and questions, and application deep links.

The [GUI layering RFC](../../implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md) reserved exactly this slot — "a future Electron application reuses the same web client packages over an IPC fetch carrier", with `dsh-host-webserver` explicitly not reused — but no shell exists. The reserved seams are unproven at desktop scale: `window.__DSH_TRANSPORT__` has one consumer (the worker preview's postMessage tunnel), the `AbstractApiClient` transport-subclass row is a hypothetical example in the RFC's subclass table, and no composition has booted the client roster without the HTTP carrier. Repository placement is also undecided: this monorepo versus a separate repository consuming published packages.

## Proposal

Build the desktop surface as a third application in this repository. `apps/desktop` is an Electron application booted over a new `desktop` profile (`@deepseek-ai/dsh-base` plus a new `@deepseek-ai/dsh-desktop-app` bundle patch). The host plugin tree, the wire protocol, and the entire browser plugin roster stay unchanged; the new code is the IPC carrier, the Electron shell, and small native capability providers behind existing seams.

### Repository placement

This repository, not a separate one. The same-PR rule — an agent-loop or `SessionEventMap` change updates every client projection in one PR — is only enforceable where the carrier and the client roster live beside what they project. The apiproxy wire deliberately carries no protocol version because client and host ship together; a second repository would turn every pre-release repackaging into cross-repository version alignment and freeze contracts the root instructions explicitly keep unfrozen before the first tagged release. Extraction becomes correct only when the shell is a pure consumer of stable published packages — the same event the layering RFC names for introducing protocol version negotiation.

### Carrier design

- Host side: a desktop host plugin composes the transport-agnostic fetch handler exactly as the Web node half does — `HostConnectionService.createSharedFetchHandler('/api', <apiproxy fallback>)` — and bridges the resulting `FetchHandler` over `ipcMain.handle` instead of mounting a webserver route. The Typert gateway's interceptor registration on `ctx.connection.rpc` is transport-independent and carries over unchanged.
- Renderer side: the preload script sets `window.__DSH_TRANSPORT__ = { createApiClient, fetch, loadBundle }` before any client plugin loads. `dsh-client-connection`'s browser half already prefers that global over `WebApiClient`, and `dsh-client-modules`' module system accepts `loadBundle` as the bundle-byte seam; the worker preview is the working precedent.
- Uplink: an `AbstractApiClient` subclass implements only `doFetch` — serialize the `Request` over `ipcRenderer.invoke`, run it through the shared fetch handler in the main process, serialize the `Response` back. Envelope minting, zod parsing, rpcId echo checks, and unary deadlines stay in the base class.
- Downlink: the subclass overrides `openMux`/`openHost` (`FixtureApiClient` proves these virtuals are substitutable) and consumes one async iterator per logical stream backed by a `MessageChannelMain` port. `ConnectionController` keeps handshake, reconnect, and baseline replay unchanged; a renderer reload is simply a connection-generation loss.
- Bundle bytes: a privileged custom scheme serves the application index — with the `__DSH_BOOT__` graph injected — and the plugin bundles, so the module system's default URL loading keeps working; `loadBundle` over IPC remains the documented alternative when the shell owns the bytes.

### New packages and composition

- `packages/bundle/desktop-app` (`@deepseek-ai/dsh-desktop-app`): a `cordis.patch.yml` over `dsh-base` mirroring the Web bundle's rows. It keeps `api-gateway`, `modules`, `connection`, `api-remotes`, `client-runtime`, the storage/workspace/projection rows, and the agent-plane rows the Web surface disables behind presets; it drops `webserver`, `frontend-static`, `web-runtime`, `web-startup`, and `client-hmr`, and inserts the desktop rows below.
- `packages/host/desktop-electron` (`@deepseek-ai/dsh-host-desktop-electron`): the shell host plugin. It owns window lifecycle, menus, tray, the single-instance lock, deep links, the custom scheme handler, and the IPC bridge; it provides a `desktopRuntime` service; it forwards answerable `approval/*` and `question/*` frames to system notifications, with answers routed through the same `/api/respond` path and pending-rpcId table the renderer uses — no second referee.
- `apps/desktop`: assembly only — mixtures stay in `apps/` per the layering RFC. The main process boots through `runProfile('desktop')` from `@deepseek-ai/dsh-app-boot`, reusing fail-loud startup, signal handling, and the healed profile module fallback; electron-builder packaging, signing, and auto-update live here.
- `PROFILE_TEMPLATES` in `@deepseek-ai/dsh-app-boot` gains the `desktop` tuple, and `apps/cli` gains a `dsh desktop` subcommand aliasing `--profile desktop`, mirroring the `web` subcommand.
- Capability providers behind existing seams, each an independent small package: `@deepseek-ai/dsh-host-directory-picker-electron` implements `ctx.directoryPicker` with `dialog.showOpenDialog` ([the directory-picker seam](../../implemented/architecture/2026-07-28-directory-picker-capability-seam.md) makes `host.pickDirectory` unchanged), and a `safeStorage`-backed provider implements the credentials capability beside the `.env` provider.

### Privileged authority

The Web carrier pins the privileged method set — `host.pickDirectory`, `host.openPath`, the settings and credentials plane, and the agent-preset authoring plane — to loopback through the Host-header fence with an empty trust list inside the connection node half. IPC carries no Host header, so the desktop carrier must make the same decision at its own entry point: the bridge accepts requests only from the application's own renderer WebContents, and with no listening port there is no other process to fence. The Typert gateway interceptor's `trusted-host` authority is satisfied because an in-app IPC channel is loopback-equivalent. This is a non-escalation requirement: the set of callers authorized for privileged operations may not widen relative to the Web carrier ([the browser-trust decision](../../implemented/architecture/2026-07-28-api-browser-trust-boundary.md) stays authoritative for HTTP).

### Web-owned mechanics to share

- `__DSH_BOOT__` injection currently lives in the webserver's index rendering. The custom-scheme handler must produce the same graph, so the graph composition moves into the modules node half (or is exported from it) and both surfaces consume one generator.
- Client HMR: the Web composition disables shared HMR because its reload lifecycle is untested; desktop development composes against the loopback HTTP surface until a desktop reload row is warranted, rather than mounting an untested reload chain in a shipped composition.
- Versioning: none is introduced. The desktop bundle ships host and client together, so auto-update must replace the whole application; a partial renderer update would reintroduce an independently released client without protocol negotiation.

### Milestones

- M1, thin shell: the Electron main process boots the Web profile and the window loads the loopback URL. This validates packaging, signing, auto-update, and notification plumbing with zero carrier work and must not become the end state.
- M2, the desktop bundle and IPC carrier: the custom scheme, the preload transport, and the dropped webserver rows; the surface stops listening on any port.
- M3, native capability providers: the Electron directory picker, keychain credentials, deep links, and notification answers.
- M4, distribution hardening: crash isolation by forking the host tree into a child process if evidence demands it — the carrier interface survives that fork unchanged — plus the update channel.

### Testing

Carrier protocol tests run the full wire serialization, zod, and frame-decoding path over an in-memory IPC bridge, mirroring the `InProcessApiClient` isomorphic precedent. A REAL-composition test boots the `desktop` profile through the Loader and asserts zero listening ports and a complete `__DSH_BOOT__` graph. Desktop product-user-visible behavior adds a keyless snapshot through a real runnable example per [the testing policy](../../../docs/testing.md), and the Web gates stay green without modification.

## Alternatives considered

**A separate repository consuming published packages.** It breaks the same-PR rule for client projections, forces pre-release contract freezing the root instructions reject, and demands protocol versioning the wire deliberately omits. Correct only after contracts stabilize for external consumers.

**Loopback HTTP inside Electron as the end state.** It keeps a listening port, the DNS-rebinding and origin attack surface, and the host-binding restrictions the Web carrier carries, and it reuses `dsh-host-webserver` the layering RFC explicitly assigns to Web only. Acceptable as milestone 1, rejected as the target.

**A non-Node shell (Tauri or similar).** The host tree is a Node plugin ecosystem — `node:sqlite`, `sandbox-exec`, the Landlock native addon, subprocess trees. A non-Node shell forces the host into a sidecar process and adds a process boundary for no capability gain.

**Forking the client roster into desktop-specific UI packages.** It duplicates every `ui-*` package the roster composes. Desktop differences go through new slot registrations in small packages, per the client export discipline.

**A second wire protocol for IPC.** The four-quadrant envelope is channel-independent by design; the carrier swap is a `doFetch` subclass plus two stream virtuals. A protocol fork would double every contract, schema, and test the apiproxy owns.

**The host tree in a child process from day one.** Crash isolation before evidence of need. The carrier interface survives a later fork unchanged, so the split is deferrable without redesign.

## Acceptance criteria

- `dsh desktop` and the packaged application boot the `desktop` profile with no listening TCP port, asserted by the REAL-composition boot test.
- The renderer completes the readiness handshake — `host.describe` plus both downlink streams — entirely over IPC; the only external `http(s)` requests are user-initiated navigations.
- The privileged method set is callable from the application's renderer and unreachable from any process outside the application, with no port to connect to.
- The browser plugin roster mounts unchanged: no `dsh.client` package is forked or duplicated, and the `__DSH_BOOT__` graph for the same roster matches the Web composition's.
- One shared graph generator produces the boot manifest for both the Web index rendering and the desktop index.
- Carrier protocol tests over the in-memory IPC bridge, the REAL-composition boot test, and at least one keyless snapshot of an assembled desktop transcript exist and pass; `pnpm run test:gui` and `DSH_SNAPSHOT=replay pnpm run test:web` stay green without modification.

## Risks

The reserved seams are unproven end-to-end. `window.__DSH_TRANSPORT__` and `loadBundle` each serve one consumer today; desktop implementation may discover gaps in `dsh-client-connection` or `dsh-client-modules`. Fixes must land in the shared seam — benefiting the worker preview too — never as a desktop fork of either package.

Electron's application lifecycle interleaves with fiber disposal: `app.quit` ordering, renderer destruction mid-turn, and signal handling each need their own shutdown tests, following the defensive-patterns requirements for teardown work.

Moving index rendering to a shared generator touches the injection point every browser session trusts; the Web and desktop generators must serve identical graph content for the same roster, pinned by test.

System-notification answers add a second entry to the answer path for approvals and questions. They ride the existing pending-rpcId table, and a notification answer arriving after resolution collapses to the existing `not-pending` receipt; any second referee would fork the "first answer wins" rule.

Whole-application updates are a discipline risk: auto-update tooling that patches renderer assets alone would silently reintroduce an independently released client without protocol negotiation.

This note applies the layering RFC's carrier plan and does not supersede it; the [WebSocket downlink carrier](../../implemented/architecture/2026-08-04-websocket-downlink-carrier.md) remains authoritative for the Web carrier's physical downlink, and the [web client architecture](../../implemented/architecture/2026-07-19-gui-web-client-architecture.md) for the browser object layer. When this ships, the layering note's hypothetical IPC-subclass row and its `apps/` slot assignment become factual and are updated in the same change.
