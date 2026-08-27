# dsh desktop

English | [中文](README.zh.md)

The Electron shell over the harness, milestones 1–2 of the [desktop surface note](../../.agents/notes/proposed/architecture/2026-08-27-desktop-electron-surface.md). The main process owns the window and the IPC carrier: renderer fetches relay to a host child (this binary under `ELECTRON_RUN_AS_NODE=1`, where Node's internal ESM loader is intact) that boots the `desktop` profile, while the application index and plugin bundles serve over the privileged `dsh-desktop://` scheme and the `/api` trust fence reads the bridge's synthesized loopback authority — the surface listens on no TCP port.

## Run

```sh
pnpm --filter @deepseek-ai/dsh-desktop run dev     # build the shell and open the window
DSH_DESKTOP_PROFILE=web pnpm --filter @deepseek-ai/dsh-desktop run dev   # milestone-1 loopback mode
pnpm --filter @deepseek-ai/dsh-desktop run dist    # electron-builder packaging (release/)
dsh desktop                                        # the CLI alias for --profile desktop
```

The preload installs `window.__DSH_TRANSPORT__ = { fetch, openStream, ownsHost: true }` before any client plugin loads (the shell runs `contextIsolation: false` so the connection client receives the hooks by reference; the carrier's trust line is the main process's sender gate). The shell owns Electron's quit ordering, keeps the single-instance lock, and reports fatal conditions through the console, a system notification, and an error dialog.

## Known Limitations and Deferred Work

- Milestone 3 (native capability providers: the Electron directory picker, keychain credentials, deep links, and notification answers) and milestone 4 (update channel, crash isolation) remain; see the [note](../../.agents/notes/proposed/architecture/2026-08-27-desktop-electron-surface.md).
- No Electron e2e runs in CI yet; the carrier's non-Electron halves are covered by `packages/host/desktop-electron/tests/carrier.host.spec.ts`, the full composition by `tests/desktop-profile.spec.ts` (REAL boot, zero carrier rows, virtual webServer semantics), and the zero-port surface by the local smoke.
- `electron-builder` packaging over pnpm workspace symlinks needs a hoisted install for a distributable artifact; `run dist` validates the configuration shape only until that lands with the update channel (milestone 4).
