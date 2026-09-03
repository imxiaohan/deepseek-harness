# Agent Note: safeStorage credentials and the native-op envelope

Status: implemented

English | [中文](2026-09-02-desktop-safe-storage-credentials.zh.md)

## Problem

The desktop shell composed the file-backed credentials provider, so stored keys sat in a plaintext YAML document while the operating system offered a keychain the Electron main process can reach — and `safeStorage` exists only there, unreachable from the plain-Node host child. The picker had already added one host→main round trip as a bespoke message pair; a second host-initiated surface arrived with this work, and the seam note's anticipated trigger for extracting a shared envelope.

## Decision

Extract one native-op envelope and build the credential store behind it.

- The bespoke `pick-directory`/`pick-directory-res` pair became `native-request`/`native-ok`/`native-error`: a closed `DesktopNativeOp` vocabulary (the directory chooser plus ten credential operations), per-op argument and value validation in the carrier parse (a mapped union narrows `args` per `op` for main's dispatch), and `native-error` carrying an operation's business failure while structural invalidity stays fatal. `DesktopRuntime.nativeRequest` is the typed lane; the picker provider moved onto it unchanged in behavior.
- The lane binds lazily to the host child's process IPC channel, gated on the `DSH_DESKTOP_HOST_CHILD` marker main sets in the spawn environment — explicit over implicit, because a vitest fork also has `process.send`. Lazy binding is what makes a boot-time consumer possible: the connection row initializes the browser-session secret during composition boot, before any post-boot wiring could attach a lane. The host entry's dispatcher remains the sole authority for invalid-message fatality; the lane's listener consumes only messages the carrier parse admits.
- Electron main owns the store: one `safeStorage`-encrypted JSON document under `userData` (`refs` as ciphertext by name, `records` as ciphertext with the kind tag in the clear so presence facts never decrypt), written atomically at `0600`, refused beyond owner permissions, and corrupted only loudly. The single writer makes the file lock unnecessary — one in-process operation chain serializes writes — and `modifyRecord` exclusion runs as a per-key lease that self-expires after the local provider's lock-wait bound, so a crashed mutation cannot wedge a key.
- `@deepseek-ai/dsh-credentials-electron` is the seam consumer: it mirrors the local provider's environment layering exactly (inherited environment read-only and winning, `.env` fallbacks below the store, the same shadowing rejection) and forwards every managed-store operation. The desktop bundle disables the base `credentials` row and inserts this one.
- `BrowserAuth` now degrades instead of failing activation when its record cannot be served: an unavailable keychain or an unreadable record yields a launch-lifetime signing secret with a warning, so a keyring-less Linux session boots and CI can run the desktop lane without a secret service. The local provider benefits from the same hardening.

## Alternatives considered

- **Keep per-surface message pairs.** Rejected at the second surface: ten credential pairs would bloat the closed union while the envelope keeps one validation seam and per-op narrowing for dispatch.
- **Store ciphertext from the host child, keeping the local provider's document machinery.** Rejected: it requires refactoring a security-critical provider into an extension seam, and ciphertext comparison breaks change detection (random IV); giving main the whole store deletes the lock instead of moving it.
- **Bind the native lane in the host entry after boot.** Rejected: the connection row's boot-time secret crosses before any post-boot wiring runs; the lazy process-channel binding is the transport that already exists from tick zero.
- **Fail activation when the keychain is unavailable.** Rejected: a desktop Linux session without a secret service would brick at boot over a cookie-signing convenience; degradation with a warning keeps the failure owned and observable.

## Consequences

- The carrier now carries both directions over one envelope; fetch/stream ids and native ids keep disjoint correlation namespaces (`ntv-native:`).
- The desktop profile's REAL-composition test intercepts `process.send` and answers the boot-time lease/abort pair, standing in for main exactly at the interface it uses; the e2e lane stubs `safeStorage` with an identity face and drives set/resolve/describe through a trigger marker (mirroring the picker's discipline), so the OS keychain is never required in CI.
- Records carry their kind tag in the clear beside the ciphertext: enumeration and description stay decryption-free, and the wire validator (`isDesktopCredentialRecord`) is the one home for the record shape on both the wire and the durable boundary.
