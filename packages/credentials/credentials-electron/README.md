---
description: "OS-keychain-backed credentials provider for the desktop shell: the managed store lives in Electron main behind safeStorage, reached over the desktop IPC carrier while the environment and .env layers stay unchanged."
kind: "package-reference"
---

# @deepseek-ai/dsh-credentials-electron

English | [中文](README.zh.md)

## Summary

The desktop shell keeps the credentials seam's environment half exactly as the [local provider](../credentials-local/README.md) serves it — the inherited process environment wins read-only, project and user `.env` files fall back below the managed store — while the managed writable source moves into the Electron main process: one `safeStorage`-encrypted document under the app's `userData`, reached over the desktop IPC carrier's native lane. `dsh-credentials-electron` registers `ctx.credentials`; the seam, its consumers, and the Remote surface are unchanged. Only the desktop composition mounts it, because the `desktopRuntime` lane it reads exists only there.

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

Only the desktop shell composes this provider: it reads the `desktopRuntime` carrier lane, which exists only in the desktop host child. Any other composition fails loudly on the first operation instead of silently degrading.

### When to choose it

The desktop surface composes this provider so stored credentials sit behind the operating system's keychain (macOS Keychain, Windows DPAPI, Linux libsecret/KWallet) instead of a plaintext document. Workstation and remote web deployments keep the [local provider](../credentials-local/README.md).

### What an operator experiences

A key stored through the Models page resolves from the keychain on the very next model request; the inherited environment still wins over it, and `.env` files still fall back below it. Writes the environment would shadow are rejected with the same actionable error as the local provider's.

### Observable failures

When the OS keychain is unavailable (a keyring-less Linux session), storing and reading fail with an actionable error while presence facts (`describe`, `listRecords`) keep answering; the browser-session secret degrades to a launch-lifetime value instead of failing the boot. A document whose ciphertext no longer matches this system's keychain fails loud with a recovery hint rather than reading as empty.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

The provider is a thin seam adapter: the environment layers resolve locally through the launch-environment snapshot, and every managed-store operation crosses the carrier as one native op — the main process owns the encrypted document, serializes writes in one process, and answers `modifyRecord` exclusion as a per-key lease that self-expires, so a crashed mutation cannot wedge a key. Because the main process is the single writer, no cross-process file lock exists; the document is written atomically at `0600` and refused when group or other permission bits are set.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The `ElectronCredentialProvider` service: environment layering plus per-op native round trips |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these when the provider contract is not enough: the seam first, then the carrier that carries the round trips.

- [Credentials seam](../credentials/README.md) — the reference/key spaces, per-operation resolution, and UI-safe descriptions.
- [Local provider](../credentials-local/README.md) — the file-backed twin whose environment layering this provider mirrors.
- [Desktop-electron host plugin](../../host/desktop-electron/README.md) — the native-op lane and the closed op vocabulary.
- [Credentials subsystem reference](../../../docs/subsystems/credentials.md) — the exhaustive contracts.

-----

<a id="model-experience"></a>
## Model Experience

None, as the credential provider registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define where the keychain store applies. They are current package constraints, not a task backlog.

- **Desktop-shell only** — the provider reads the `desktopRuntime` lane, so a composition outside the desktop bundle rejects the first operation loudly rather than degrading.
- **No external-edit hot reload** — the main process is the single writer, so unlike the local provider there is no document watcher; edits can only happen through the seam.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Store invariants (single writer, lease expiry, owner-only mode) are enforced in the main-process store and covered by its tests in `apps/desktop`.
