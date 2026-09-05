# Agent Note: system-notification answers over the forwarded-event waterfall

Status: implemented

English | [中文](2026-09-02-desktop-notification-answers.zh.md)

## Problem

A pending approval or question waits inside the application window, so an operator working elsewhere can leave an agent blocked indefinitely without knowing. The desktop shell owns an OS notification surface a browser tab cannot reach — but an answer from a notification must not become a second referee over pending state: the seam's waterfall already decides every race, and the shell must not retain a parallel pending table.

## Decision

Join the Gateway's forwarded-event waterfall as one more client generation.

- After the carrier settles, main opens the `$events` logical stream over the existing `open-stream` carrier request (the endpoint, payload, and result route are the gateway package's exported wire vocabulary — the one home for the protocol). The ready frame names this shell's client id; stream frames route to a main-owned stream id, not the renderer relay set.
- A `waterfall` frame for `approval/request` presents an OS notification whose buttons answer with `allowed-once`/`rejected` — posted as one `client-request` envelope to the gateway's `$events/result` RPC, exactly the path the renderer answers through. The Gateway's semantics stay the only referee: first answer wins, late results are idempotent no-ops, and this shell keeps no second pending table beyond the notifications themselves.
- A `waterfall` frame for `user-questions/request` presents a focus-only notification (questions answer with structured drafts a notification cannot carry); body activation brings the window forward without answering. Dismissing any notification never answers — the waterfall keeps waiting on its other deliveries.
- A `cancel` frame — the renderer answered, the agent aborted, the session ended — collapses the notification. A button click removes its notification locally before posting; a late cancel for it is then a no-op.
- Unsupported notification sessions degrade to no notifications (`Notification.isSupported()` gates the constructor); the window keeps answering everything.

## Alternatives considered

- **A dedicated notification-answer API.** Rejected: a second endpoint means a second referee; `$events/result` already carries first-answer-wins and idempotent late results for every client generation.
- **Answer questions inline from the notification.** Rejected: question answers are structured drafts; a notification's buttons cannot carry them honestly, so the notification only surfaces and focuses.
- **Delivering pending state to the renderer for presentation.** Rejected: the renderer already holds the in-window cards; the notification is a second presentation of the same waterfall delivery, not a new owner of pending state.

## Consequences

- The e2e drives a real approval end to end: the composition fixture creates an agent, opens its turn, and asks one real approval; the stubbed notification surface captures what main presents, the test activates the allow action, and the seam records `allowed-once` — the whole loop crosses the real carrier, Gateway waterfall, and result RPC.
- The hub is pure over injected presentation and posting faces: its state machine (presentation, answering, collapse, dismissal, malformed frames, posting failures) is covered headlessly at full branch coverage; `apps/desktop/src/pending-notifications.ts` owns no Electron import.
- macOS shows notification buttons only in packaged builds; dev builds still notify, and body activation focuses the window (recorded as a known limitation of the desktop README).
