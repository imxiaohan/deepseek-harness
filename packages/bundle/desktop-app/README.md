---
description: "The dsh desktop surface: the same harness, roster, and presets as the Web GUI in an Electron application with native integration, booted by `dsh desktop`."
kind: "package-bundle"
---

# @deepseek-ai/dsh-desktop-app

English | [中文](README.zh.md)

## Summary

The dsh desktop-surface profile bundle: `cordis.patch.yml` over `dsh-base` mirroring the Web bundle's rows minus the HTTP carrier family (`webserver`, `web-runtime`, `web-startup`, `client-hmr`), with the `desktop-electron` row providing the virtual `webServer` the retained rows inject and the IPC carrier replacing every listening socket. `dsh desktop` (alias of `--profile desktop`) boots it.

## Table of Contents

- [Summary](#summary)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

## Model Experience

Indirectly, through the composed rows: the patch layer recomposes the same roster the Web bundle composes, and each row owns its model-facing behavior.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- The desktop shell freezes user-patch reload (`patchReload: 'frozen'` at boot): Electron's Node cannot mount the vendored config-HMR service, so `cordis.patch.yml` edits apply on restart.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The patch mirrors `dsh-web-app`'s row set minus the HTTP carrier family; the `desktop-electron` row must mount before every row injecting `webServer`. The composition's zero-port guarantee is the row absence itself: no package that binds a socket composes, and the REAL boot test asserts the virtual `webServer`'s semantics (`host` is the synthesized loopback authority; `port` throws). The design record is the [desktop surface note](../../../.agents/notes/proposed/architecture/2026-08-27-desktop-electron-surface.md).

</details>
