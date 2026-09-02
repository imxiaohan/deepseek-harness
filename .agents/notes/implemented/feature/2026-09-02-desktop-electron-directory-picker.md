# Agent Note: Electron-native directory picker over the desktop carrier

Status: implemented

English | [中文](2026-09-02-desktop-electron-directory-picker.zh.md)

## Problem

The desktop shell composes the [directory-picker seam](../architecture/2026-07-28-directory-picker-capability-seam.md), and the seam note anticipated an Electron provider of the `native` interaction. The subprocess backend (`osascript`, Zenity, Win32 COM) opens an unparented chooser from the host child, while the desktop shell owns a window the chooser should attach to — and `dialog.showOpenDialog` exists only in the Electron main process, which the host child (plain Node under `ELECTRON_RUN_AS_NODE`) cannot import. The picker is the first host-initiated native operation: until now every carrier request flowed main→host.

## Decision

Route the pick over the existing IPC carrier in reverse, as one correlated round trip, and keep the seam untouched.

- Two protocol messages join the closed carrier union: host→main `pick-directory` (correlation id only) and main→host `pick-directory-res` (the chosen absolute path or `null`). `parseDesktopIpcMessage` validates both exactly like every other message; a malformed frame still terminates the receiving process.
- `createNativeHostClient(channel)` in `dsh-host-desktop-electron` owns the host-child half: it allocates `DesktopIpcId`-correlated waiters, resolves the matched response, and rejects on caller abort or a failed send. An abort drops the waiter and abandons any late result — Electron's dialog has no programmatic close, so nothing tries to dismiss the chooser.
- `DesktopRuntime` gains the lane the seam consumes: `pickDirectory(signal)` fails loud when no lane is bound, and `attachNativeHost(channel)` (called once by `apps/desktop/src/host.ts` while serving the carrier, disposed with the bridge) binds it.
- Electron main answers `pick-directory` by opening `dialog.showOpenDialog` parented to the shell window (`openDirectory`/`createDirectory`, locale-owned title); a dialog failure enters the existing fatal lane (`fatal.host.nativePick`) because the requester is the trusted host child, not the renderer.
- `@deepseek-ai/dsh-host-directory-picker-electron` is the seam consumer: it registers the stable `native` capability whose `pick` reads `desktopRuntime.pickDirectory`. The desktop bundle pins it beside the renderless native flow occupant, replacing the adaptive chooser row — the desktop operator always sits at the display, so the electron-native interaction is unconditional and no probe runs.

The client flow, the workspace controller, the Remote method, and the browse interaction are unchanged; one composition row pair swaps the backend exactly as the seam decision described.

## Alternatives considered

- **Spawn the subprocess backend from the host child.** Rejected: it opens an unparented chooser, duplicates the window's own dialog, and ignores the Electron capability the shell exists to provide.
- **Serve the dialog from a renderer `ipcRenderer` call.** Rejected: the capability lives on the host-side service; routing host→renderer→host couples the pick to document admission lifetimes (a reload would cancel an open chooser) and grants the renderer a native-op broker it must not own.
- **A generic `native-op` envelope now.** Deferred: one message pair per native surface keeps validation closed and concrete; a second host-initiated surface (keychain credentials) can extract a shared envelope when its payload shape is known.

## Consequences

- The carrier now carries both directions: main→host requests (fetch, streams) and host→main native requests. Each direction keeps its own correlation namespace (`ntv-native:` ids never collide with fetch/stream ids).
- The e2e suite drives the round trip by stubbing `dialog.showOpenDialog` in main after launch; a trigger marker arms the host-side probe so stub and probe cannot race (a boot-time probe would open a real chooser before the stub lands). The OS chooser itself is not automatable by Playwright.
- Coverage: the protocol parser, the native client (100% branch), the provider service, and the REAL desktop composition (the profile boots and the composed picker reports `native`) run headless; the Electron lane (Xvfb/native CI) owns the platform evidence.
