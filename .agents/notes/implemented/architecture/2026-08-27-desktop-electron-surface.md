# Agent Note: Desktop Electron shell and zero-port IPC carrier

Status: implemented

English | [中文](2026-08-27-desktop-electron-surface.zh.md)

## Problem

The Web composition uses a loopback HTTP server, WebSocket downlinks, and static-file routes as its physical browser carrier. A desktop application needs the same host tree, wire protocol, presets, and browser client roster without inheriting a listening port or creating a desktop-specific client fork. Electron also adds process, navigation, renderer-failure, and application-shutdown lifecycles that must dispose the host tree to quiescence.

The archived [GUI layering record](../../archived/architecture/2026-07-19-gui-layering-and-rpc-protocol.md) reserves this arrangement: an Electron application reuses the Web client packages over an IPC fetch carrier and does not compose `dsh-host-webserver`. The active [transport layering record](2026-07-24-web-config-tree-boot-and-transport-layering.md) owns the shared transport split, and the [Web client architecture](2026-07-19-gui-web-client-architecture.md) owns the browser object layer.

## Decision

### Repository and composition

The desktop application lives in this repository. Keeping its carrier and client roster beside the projected host APIs preserves the rule that an agent-loop or `SessionEventMap` change updates every client projection in one change. The apiproxy wire has no protocol version because host and client ship together; extracting the shell becomes valid only when it consumes stable published packages with explicit protocol negotiation.

`apps/desktop` is the published Electron assembly launched by `dsh desktop`. Its host child boots the `desktop` profile, which layers `@deepseek-ai/dsh-desktop-app` over `@deepseek-ai/dsh-base`. The desktop bundle mirrors the Web rows except for the HTTP carrier family (`webserver`, `web-runtime`, `web-startup`, and `client-hmr`) and adds `@deepseek-ai/dsh-host-desktop-electron`. Direct `dsh --profile desktop` remains the windowless profile entry used by the host child and recorded-session tests.

The CLI resolves its installed `@deepseek-ai/dsh-desktop` assembly and passes profile overlays and application arguments through a validated process-launch envelope. Electron's single-instance lock rejects a second launch rather than silently discarding that envelope.

### Carrier

- The host package provides a virtual `webServer` service because retained node rows inject that service for plugin routes, index injections, the `/api` route, and the Gateway upgrade. Its route registry owns no server or socket; `host` returns the host-side loopback authority and `port` throws.
- The host package also provides `desktopRuntime`. It dispatches plugin-asset requests through the virtual registry, API requests through `HostConnectionService.createSharedFetchHandler('/api')`, logical streams through the Gateway wire lane, and index boot data through the shared module graph generator.
- The preload installs `window.__DSH_TRANSPORT__ = { fetch, openStream, ownsHost: true }` before client plugins load. The connection client consumes the same transport hooks used by the experimental worker carrier. The shell uses `contextIsolation: false` so browser-native `Request`, `Response`, and stream values cross by reference; Electron main, not renderer-world isolation, authorizes every carrier call.
- Renderer fetches and logical streams relay through Electron main to the host child. Abort messages cross both IPC hops and reach the host operation's signal. Reload, main-frame navigation, window closure, renderer failure, and shell shutdown cancel operations owned by the departing renderer generation.
- The privileged `dsh-desktop://` scheme serves the injected application index and registered plugin bundles. Scheme `/api` requests use the same host fetch lane, including Session export; response bodies cross the host/main process channel one pull-driven binary chunk at a time so neither endpoint materializes a complete archive.

### Privileged authority

The preload declares `ownsHost: true`, which lets the shared client expose loopback-only product operations. Electron main accepts IPC and custom-scheme host routes only from the current window's committed main-frame document while it remains on the loaded authority. A main-frame navigation start revokes that document's admission before any replacement commits, cancels its active operations, and prevents it from opening new work during unload. Cross-authority navigation, external redirects, subframes, child windows, webviews, and foreign WebContents cannot reach the carrier.

The host child receives loopback URLs because custom-scheme origins have no host-route semantics. This URL rewrite is not HTTP authentication: the Web carrier continues to own Host/Origin and browser-session checks under the [browser trust decision](2026-07-28-api-browser-trust-boundary.md), while Electron main owns desktop document admission.

### Process lifecycle

The profile tree runs in a host child using the Electron binary under `ELECTRON_RUN_AS_NODE=1`. The Electron binary exposes no Node internal ESM loader in either mode, so the vendored Loader uses its config-tree import fallback. The child keeps profile disposal independent from main and renderer failure; putting the tree in Electron main would gain no loader advantage and would couple both lifecycles.

Normal window closure, `SIGINT`, and `SIGTERM` call `app.quit()`. Shutdown stops admitting work, closes listeners, sends the platform-independent host shutdown message, aborts and awaits active bridge operations, and disposes the profile tree before the child exits. A bounded grace period force-terminates only a child that does not reach quiescence. Fatal renderer or IPC failures follow the same drain path and preserve a nonzero application exit.

Desktop user-patch reload is frozen because the vendored config-HMR service requires Node internals the Electron binary does not expose. Host and client remain one release unit; a partial renderer update is unsupported.

### Verification

Unit suites pin IPC field validation, request and response serialization, bounded response streaming, cancellation, runtime dispatch, and virtual registry lifecycle. A REAL-composition suite boots the desktop profile, verifies the retained rows are active, compares shared browser roster entries and scheduling phases with Web except for transport-owned HMR, and reads the exact shared boot graph.

The built-application Playwright suite forbids socket listens in the host child; rejects foreign authorities, frames, windows, redirects, and malformed IPC; and verifies reload cancellation, single-instance rejection, renderer failure, normal exit, signals, bridge disposal, and final host-child exit. Linux PR and master CI run the suite under Xvfb; local macOS runs it directly. A keyless recorded-session scenario replays through `dsh --profile desktop`.

## Alternatives considered

**A separate repository consuming published packages.** It breaks coordinated client projection updates, forces pre-release contract freezing, and requires protocol versioning that the current wire deliberately omits. It becomes appropriate only after the packages and wire are stable external APIs.

**Loopback HTTP inside Electron as the final carrier.** It retains a listening port, browser-origin attack paths, and host-binding constraints, and composes the HTTP package that the layering decision assigns only to Web.

**A non-Node shell.** The host tree depends on Node services, native addons, and subprocess control. A non-Node shell still needs a Node sidecar and adds another runtime without adding a required capability.

**A desktop-specific client roster.** It duplicates browser feature packages and weakens coordinated projection changes. Desktop-only presentation belongs in additive slot registrations, not forks of shared packages.

**A second application wire protocol.** The connection envelopes and Gateway streams are carrier-independent. A second protocol would duplicate validation, cancellation, error, and replay semantics.

**The host tree inside Electron main.** It removes one process hop but couples Electron and profile teardown, while the Electron binary still lacks the internal ESM loader. The child process provides an independently bounded lifecycle.

## Consequences

The desktop profile has no TCP or WebSocket listener and reuses the shared browser roster, boot graph, unary envelopes, stream values, and session transcript behavior. The carrier adds two IPC hops and an explicit host-child lifecycle, but cancellation and pull-driven response flow preserve bounded work across them.

Electron main is a security-critical document admission point because the renderer world intentionally shares transport values with client code. Any new carrier entry must apply the same committed-main-frame and loaded-authority rule before dispatch.

Native capability providers and distributable release hardening are not part of this decision. They remain in the [desktop native integration and distribution proposal](../../proposed/architecture/2026-08-27-desktop-native-integration-and-distribution.md).
