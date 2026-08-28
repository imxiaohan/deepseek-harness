# dsh desktop

English | [中文](README.zh.md)

The Electron shell over the harness, implementing the [desktop carrier decision](../../.agents/notes/implemented/architecture/2026-08-27-desktop-electron-surface.md). The main process owns the window and the IPC carrier: renderer fetches relay to a host child (this binary under `ELECTRON_RUN_AS_NODE=1`, using the Loader's config-tree import fallback) that boots the `desktop` profile, while the application index and plugin bundles serve over the privileged `dsh-desktop://` scheme. Main-frame document admission authorizes carrier calls, host routes receive synthesized loopback URLs, and the surface listens on no TCP port.

## Run

```sh
pnpm --filter @deepseek-ai/dsh-desktop run dev     # build the shell and open the window
DSH_DESKTOP_PROFILE=web pnpm --filter @deepseek-ai/dsh-desktop run dev   # milestone-1 loopback mode
pnpm --filter @deepseek-ai/dsh-desktop run dist    # electron-builder packaging (release/)
dsh desktop                                        # launch the Electron app through the public CLI
```

The CLI starts its installed `@deepseek-ai/dsh-desktop` assembly and passes `--patch` overlays and remaining app arguments to the host child in a validated process-launch envelope; direct `dsh --profile desktop` runs only that host profile and does not create a window. The preload installs `window.__DSH_TRANSPORT__ = { fetch, openStream, ownsHost: true }` before any client plugin loads. The shell runs `contextIsolation: false` so the connection client receives those hooks by reference, but accepts carrier IPC and custom-scheme host routes only from the window's current main frame while it remains on the loaded authority; reload cancels work owned by the outgoing document, and cross-authority navigation and child windows are denied. Custom-scheme response bodies cross the process channel one pull-driven binary chunk at a time, so Session export does not materialize a complete archive in the host or main process. Quit sends a platform-independent shutdown message, waits for the host bridge and profile tree to reach quiescence, then force-terminates the child only after the bounded grace period. The shell rejects a second launch while one instance is active and reports fatal conditions through the console, a system notification, and an error dialog before exiting nonzero.

## Known Limitations and Deferred Work

- Native capability providers (the Electron directory picker, keychain credentials, deep links, and notification answers) and distribution hardening remain proposed; see the [native integration and distribution note](../../.agents/notes/proposed/architecture/2026-08-27-desktop-native-integration-and-distribution.md).
- Windows has no native Electron e2e lane. Linux CI runs `test:desktop:built` under Xvfb; the same built-application suite runs directly on macOS and covers authority, zero host listens, reload cancellation, malformed IPC, renderer failure, signals, normal shutdown, and the single-instance lock.
- `electron-builder` packaging over pnpm workspace symlinks needs a hoisted install for a distributable artifact; `run dist` validates the configuration shape only until that lands with the update channel (milestone 4).
