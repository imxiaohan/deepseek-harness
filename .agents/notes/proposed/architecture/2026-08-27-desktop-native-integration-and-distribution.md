# Agent Note: Desktop native integration and distribution

Status: proposed

English | [中文](2026-08-27-desktop-native-integration-and-distribution.zh.md)

## Problem

The implemented [Electron shell and zero-port carrier](../../implemented/architecture/2026-08-27-desktop-electron-surface.md) runs the shared Harness product in a desktop window, but it does not yet provide integrations a browser tab cannot own: native directory dialogs, keychain-backed credentials, system-notification answers, application deep links, signed artifacts, crash recovery, or an update channel.

These features cross privileged operating-system and release boundaries. They must extend existing capability and answer paths rather than add Electron-only business APIs, and distribution must preserve the current rule that host and renderer ship as one unit without protocol negotiation.

## Proposal

### Native capability providers

- Add `@deepseek-ai/dsh-host-directory-picker-electron` as a provider for the existing `directoryPicker` capability. It calls `dialog.showOpenDialog`; `host.pickDirectory` and its client consumer remain unchanged under the [directory-picker decision](../../implemented/architecture/2026-07-28-directory-picker-capability-seam.md).
- Add a `safeStorage`-backed credentials provider beside the environment provider. The credentials Service Definition and consumers remain unchanged; the provider owns Electron availability and encryption failures.
- Register application deep links in Electron main, validate their complete input before dispatch, and route accepted operations through existing application commands or APIs rather than exposing renderer navigation as authority.
- Project pending approvals and questions into system notifications. A notification answer uses the same `/api/respond` operation and pending rpcId table as the renderer, so the existing first-answer-wins and `not-pending` behavior remains the only referee.

Each provider is an independent package behind an existing capability or command path and joins the desktop bundle only. Desktop-specific presentation uses additive client slots when necessary; shared client packages remain unchanged.

### Distribution hardening

`apps/desktop` owns electron-builder configuration, platform signing and notarization, distributable artifact verification, crash-recovery policy, and the update client. Release automation publishes complete application artifacts. An update replaces host code, renderer assets, profile bundles, and the Electron shell together; renderer-only updates remain unsupported while the wire has no protocol version.

The application reports update and recovery failures through desktop-owned UI and diagnostics without bypassing orderly host-child shutdown. Packaging validation runs against the installed artifact rather than workspace symlinks.

### Milestones

- M3 delivers the native directory picker, keychain credentials, validated deep links, and notification answers.
- M4 delivers signed distributable artifacts, crash recovery policy, and a whole-application update channel.

## Alternatives considered

**Put native behavior directly in shared client packages.** It forks browser behavior around Electron globals and bypasses the capability providers and slots that already isolate host and presentation differences.

**Give notification answers their own pending-state authority.** Two referees can accept conflicting answers. Reusing `/api/respond` keeps the existing pending rpcId table authoritative.

**Update renderer assets independently.** It creates separately released wire peers without version negotiation and can pair an old host with a new client graph.

**Move the shell to a separate repository before distribution.** It makes release hardening depend on stable published package and wire contracts that do not yet exist. Extraction remains a later option once the shell is a pure external consumer.

## Acceptance criteria

- Desktop directory selection and stored credentials use the existing capability methods, and tests cover cancellation, provider failure, and disposal through a real desktop composition.
- Deep links reject malformed, unsupported, and cross-authority inputs before they reach a command or host API.
- Notifications reflect pending approvals and questions, and answering or dismissing them preserves the existing first-answer-wins and terminal receipt behavior.
- Release jobs produce signed, installable artifacts for supported platforms and verify startup, profile boot, native providers, orderly shutdown, and update rollback from the installed application.
- Updates replace the complete application and cannot install renderer assets independently.

## Risks

`safeStorage`, notifications, protocol registration, signing, and update mechanisms differ by operating system and desktop session. Each provider and release lane needs native platform evidence; source-mode or mocked Electron tests are insufficient for a claim of platform support.

Notification answers can arrive after renderer action, expiry, restart, or session disposal. The existing pending rpcId operation must decide every race, and notifications must collapse terminal receipts without retaining a second pending table.

An interrupted whole-application update can strand an unusable installation. The update design needs atomic replacement or rollback and must preserve user data outside application artifacts.
