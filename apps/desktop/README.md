# dsh desktop

English | [中文](README.zh.md)

The Electron thin shell over the harness, milestone 1 of the [desktop surface note](../../.agents/notes/proposed/architecture/2026-08-27-desktop-electron-surface.md). The main process boots the Web profile through `@deepseek-ai/dsh-app-boot`'s `runProfile`, then loads the process-token loopback URL (`BrowserAuth.authenticatedUrl`) in one window — zero carrier work, and deliberately not the end state.

## Run

```sh
pnpm --filter @deepseek-ai/dsh-desktop run dev     # build the shell and open the window
DSH_DESKTOP_PROFILE=web pnpm --filter @deepseek-ai/dsh-desktop run dev
pnpm --filter @deepseek-ai/dsh-desktop run dist    # electron-builder packaging (release/)
```

The shell passes `--no-open` to the Web profile (the window is the browser handoff), keeps the single-instance lock, and owns Electron's quit ordering: `before-quit` defers the final quit until the profile tree's bounded shutdown disposes. A fatal boot reports through the console, a system notification, and an error dialog — milestone 1's validation of the notification emission path.

## Known Limitations and Deferred Work

- Milestone 1 keeps the loopback HTTP carrier; the IPC carrier, custom scheme, and zero-port surface land in milestone 2, and answerable-frame notification replies in milestone 3 ([note](../../.agents/notes/proposed/architecture/2026-08-27-desktop-electron-surface.md)).
- No Electron e2e runs in CI yet; the shell's non-Electron logic is covered by `tests/app-url.spec.ts`, and the dev run is the milestone's packaging validation.
- `electron-builder` packaging over pnpm workspace symlinks needs a hoisted install for a distributable artifact; `run dist` validates the configuration shape only until that lands with the update channel (milestone 4).
