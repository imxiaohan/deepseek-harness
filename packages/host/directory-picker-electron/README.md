---
description: "Electron-native backend of the directory-picker seam: routes each pick to the Electron main process, which opens the shell window's OS chooser over the desktop IPC carrier."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-directory-picker-electron

English | [中文](README.zh.md)

## Summary

The desktop shell picks a workspace directory through the Electron-native chooser: `dsh-host-directory-picker-electron` registers the `native` capability and routes each pick over the desktop IPC carrier to the Electron main process, which opens `dialog.showOpenDialog` attached to the shell window and relays the chosen absolute path back (`null` on cancel). The provider runs in the desktop host child under plain Node and imports no Electron module; the dialog lives in the main process. The desktop bundle pins this backend beside the renderless native flow occupant, so one row pair composes both faces.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Only the desktop shell composes this backend: it reads the `desktopRuntime` carrier lane, which the desktop host child binds at boot. Any other composition fails loudly on the first pick instead of silently degrading.

### When to choose it

Choose this backend for the desktop application, where the Electron main process owns the window a chooser should attach to. Workstation-local web deployments compose the [subprocess native backend](../directory-picker-native/README.md) instead; remote deployments compose the [browse backend](../directory-picker-browse/README.md).

### What an operator experiences

Each pick opens one native chooser parented to the application window and waits for the operator; the chosen directory resolves as an absolute path and a cancel resolves `null`. The browser half is the existing renderless native flow occupant — every `open` request drives `directoryPicker/pick` and reports the one outcome.

### Observable failures

A cancel returns `null`, not an error. A dropped carrier channel or a failed dialog reports the carrier's error through the pick rejection; a composition without the desktop lane rejects with an actionable error on the first pick.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

The backend is a thin service over the desktop carrier: `ElectronDirectoryPicker` registers the `native` capability whose `pick` reads `ctx.get('desktopRuntime').pickDirectory(signal)`. The host child binds that lane over its process channel at boot; one correlated `pick-directory` request travels host→main, the main process opens the chooser and answers with one `pick-directory-res`. The correlation id namespace and validation mirror the fetch/stream carrier.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `ElectronDirectoryPicker` service with the stable `native` capability |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these when the backend contract is not enough: the seam definition first, then the carrier that carries the round trip.

- [Directory-picker seam](../directory-picker/README.md) — the `native` capability contract and the typed error vocabulary.
- [Directory-picker capability seam decision](../../../.agents/notes/implemented/architecture/2026-07-28-directory-picker-capability-seam.md) — why backends differ in interaction shape; this package is the anticipated Electron provider.
- [Desktop-electron host plugin](../desktop-electron/README.md) — the IPC carrier protocol and the native-op lane binding.
- [Subprocess native backend](../directory-picker-native/README.md) — the workstation-local alternative for web deployments.

-----

<a id="model-experience"></a>
## Model Experience

None, as the GUI-host picking backend registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define where the Electron interaction applies. They are current package constraints, not a task backlog.

- **Desktop-shell only** — the provider reads the `desktopRuntime` lane, so a composition outside the desktop bundle rejects the first pick loudly rather than degrading.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Each pick is one carrier round trip; the chooser outcome is only the returned path.
