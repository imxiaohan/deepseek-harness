---
description: "The desktop shell's host plugin: a virtual webServer over the IPC carrier (zero listening sockets), the desktopRuntime lane, and the Electron-free carrier protocol shared by the host child and the app."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-desktop-electron

English | [中文](README.zh.md)

## Summary

The desktop shell's host-side package: the tree-side plugin providing the virtual `webServer` service (a route registry and index-injection collection with no listening socket) and the `desktopRuntime` carrier lane (API and registered plugin-asset fetches, the Gateway wire stream, and the boot payload), plus the Electron-free carrier halves — the IPC wire protocol, the host-child bridge, and the preload transport core — that the Electron app assembles.

## Table of Contents

- [Summary](#summary)
- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

## Use this package

Compose the plugin as the `desktop-electron` row of the `desktop` profile (`@deepseek-ai/dsh-desktop-app`); it must mount before the rows that inject `webServer` (`modules`, `connection`, the API Gateway). The Electron app (`apps/desktop`) imports the carrier halves: `serveDesktopHost` in the host child over the process channel, `createDesktopTransport` in the preload as `window.__DSH_TRANSPORT__`, and `loopbackCarrierUrl` where the main process gives host routes their loopback URL. Electron main admits requests from the committed trusted main-frame document before this package receives them.

## Understand the implementation

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The tree-side plugin: `VirtualWebServer` + `DesktopRuntime` services |
| [`src/virtual-web-server.ts`](src/virtual-web-server.ts) | The socket-free route registry standing in for the HTTP carrier service |
| [`src/ipc-protocol.ts`](src/ipc-protocol.ts) | The JSON wire protocol between main, host child, and preload |
| [`src/host-bridge.ts`](src/host-bridge.ts) | The host-child dispatch: initial boot publication, fetch round trips, and stream pumping |
| [`src/preload-core.ts`](src/preload-core.ts) | The renderer transport over injected invoke/on/send primitives |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion (no runtime invariant; REAL-composition boot covers the carrier) |

The host bridge publishes the boot payload once its message listener is installed; the main process does not create the scheme-loaded window before receiving it. Both process adapters validate every carrier message and terminate their process on invalid fields instead of leaving boot, fetch, or stream work pending. Fetch and stream cancellation crosses both IPC hops, and bridge disposal aborts and awaits every active operation before profile teardown completes. Plugin combo URLs keep their complete pathname and query string through the fetch protocol and run through the virtual server's registered `/plugins` handler; custom-scheme `/api` requests, including Session export downloads, use the shared API Fetch handler after Electron main authorizes the document. Scheme response bodies advance by one binary chunk per main-process pull, so the process channel and its endpoints never materialize a complete Session archive. The virtual `webServer`'s `host` getter returns the loopback authority used by host-side URLs, so bind-dependent consumers pick their loopback branch; `port` throws, because the desktop composition listens on no port.

## Model Experience

None, as the IPC carrier bridges the renderer and the booted composition and registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- Stream frames relay through the main process (renderer↔main↔host child) rather than a direct `MessageChannelMain` port; the relay is message-based until latency evidence demands ports.
- Answerable-frame notification forwarding is milestone 3; the tree side exposes no forwarding lane yet.

<a id="dev-note"></a>

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The package deliberately imports no Electron module: the Electron app (`apps/desktop`) assembles the carrier halves over its own primitives, which is what keeps the in-memory carrier tests process-free. `preload-core.ts` declares its own `DesktopTransportHooks` interface rather than importing the client face's `ClientTransportHooks` — a host-face package cannot reach the `/client` subpath, and the carrier test pins the shape behaviorally against the real dispatch. The design record is the [desktop carrier decision](../../../.agents/notes/implemented/architecture/2026-08-27-desktop-electron-surface.md).

</details>
