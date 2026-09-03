# Agent Note: validated application deep links

Status: implemented

English | [中文](2026-09-02-desktop-deep-links.zh.md)

## Problem

The desktop shell registered no external protocol, so nothing outside the application could carry an intent into it, and the single-instance path only focused the window. A deep link is OS-delivered input reaching the Electron main process directly — the most privileged ingress the shell has — so its vocabulary must be closed and its validation complete before anything a link names touches a command or host API.

## Decision

A pure validator owns admission, and main dispatches accepted intents through the existing application API.

- The public scheme is `dsh://`. Registration (`setAsDefaultProtocolClient`) happens only in packaged builds — dev builds share one Electron binary, and registering there would claim every unpackaged dev app's links.
- Ingress: macOS `open-url` (prevented default, queued before readiness), the warm `second-instance` argv on every platform, and a cold-start argv scan drained after the carrier settles. All three feed one `enqueueDeepLink`.
- `parseDesktopDeepLink` validates completely: the exact `dsh:` scheme, no credentials or fragments, no pathname, one closed operation (`open` with a single `path` parameter that must be an absolute POSIX or Windows-drive path), a bounded length, exactly one parameter. Malformed, unsupported, and cross-authority input — including anything claiming the internal privileged `dsh-desktop://` scheme — is refused with a console diagnostic and never reaches a dispatch.
- An accepted `open` focuses (or creates) the window and adopts the workspace through the existing `workspace/create` Remote over the carrier: one `client-request` envelope POSTed to the loopback `/api` route, the same shared handler and Electron-main admission every renderer API call already uses. A refused operation (a path that no longer exists) is a diagnostic with the window already in front; only a broken carrier fails the shell.

## Alternatives considered

- **Dispatch through renderer navigation (`window.loadURL`).** Rejected: the note's rule — renderer navigation is not authority; a link naming a URL would smuggle renderer-navigation intents past main's validation.
- **Deliver the intent to the renderer for dispatch.** Deferred: no client-side intent consumer exists yet, and routing through the existing host API needs none; a renderer consumer can join later behind the same validator.
- **Register the scheme in dev too.** Rejected: unpackaged Electron builds share one binary and one protocol database entry; dev registration would hijack `dsh://` for every checkout.
- **A wider operation vocabulary now.** Rejected: one operation with complete validation is the honest first vocabulary; ops join with their own validation and dispatch, not by loosening admission.

## Consequences

- The e2e lane drives the warm ingress deterministically: a second Electron instance carrying the link exits on the single-instance lock after handing its argv over, and the composition's workspace registry shows the adopted workspace through the fixture probe.
- The validator is pure and headless-tested over accepted, malformed, unsupported, and cross-authority shapes; `apps/desktop/src/deep-link.ts` holds the single home for the vocabulary.
