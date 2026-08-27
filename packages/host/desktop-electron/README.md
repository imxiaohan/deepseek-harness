---
description: "The desktop shell's host plugin: a virtual webServer over the IPC carrier (zero listening sockets), the desktopRuntime lane, and the Electron-free carrier protocol shared by the host child and the app."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-desktop-electron

English | [中文](README.zh.md)

## Summary

The desktop shell's host-side package: the tree-side plugin providing the virtual `webServer` service (a route registry and index-injection collection with no listening socket) and the `desktopRuntime` carrier lane (the connection shared fetch handler, the Gateway wire stream, the boot payload, and plugin-bundle bytes), plus the Electron-free carrier halves — the IPC wire protocol, the host-child bridge, and the preload transport core — that the Electron app assembles.

## Table of Contents

- [Summary](#summary)
- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

## Use this package

Compose the plugin as the `desktop-electron` row of the `desktop` profile (`@deepseek-ai/dsh-desktop-app`); it must mount before the rows that inject `webServer` (`modules`, `connection`, the API Gateway). The Electron app (`apps/desktop`) imports the carrier halves: `serveDesktopHost` in the host child over the process channel, `createDesktopTransport` in the preload as `window.__DSH_TRANSPORT__`, and `loopbackCarrierUrl` where the main process relays renderer fetches with the synthesized loopback Host.

## Understand the implementation

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The tree-side plugin: `VirtualWebServer` + `DesktopRuntime` services |
| [`src/virtual-web-server.ts`](src/virtual-web-server.ts) | The socket-free route registry standing in for the HTTP carrier service |
| [`src/ipc-protocol.ts`](src/ipc-protocol.ts) | The JSON wire protocol between main, host child, and preload |
| [`src/host-bridge.ts`](src/host-bridge.ts) | The host-child dispatch: fetch round trips, stream pumping, boot and bundle answers |
| [`src/preload-core.ts`](src/preload-core.ts) | The renderer transport over injected invoke/on/send primitives |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion (no runtime invariant; REAL-composition boot covers the carrier) |

The virtual `webServer`'s `host` getter returns the carrier's synthesized loopback authority — the same value the bridge mints into every host-side request — so bind-dependent consumers pick their loopback branch; `port` throws, because the desktop composition listens on no port.

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

The package deliberately imports no Electron module: the Electron app (`apps/desktop`) assembles the carrier halves over its own primitives, which is what keeps the in-memory carrier tests process-free. `preload-core.ts` declares its own `DesktopTransportHooks` interface rather than importing the client face's `ClientTransportHooks` — a host-face package cannot reach the `/client` subpath, and the carrier test pins the shape behaviorally against the real dispatch. The design record is the [desktop surface note](../../../.agents/notes/proposed/architecture/2026-08-27-desktop-electron-surface.md).

</details>
