/**
 * The desktop's notification answerer: one more client generation in the
 * Gateway's forwarded-event waterfall. Pending approval requests project
 * into OS notifications whose buttons answer through the same
 * `$events/result` RPC the renderer uses, so the Gateway's first-answer-wins
 * and idempotent-late-result semantics remain the only referee — this module
 * keeps no second pending table beyond the notifications themselves. Pure
 * over injected presentation and posting faces, so tests drive it headlessly.
 * @module @deepseek-ai/dsh-desktop/pending-notifications
 */

/** Locale-owned copy the notifications present. */
export interface PendingNotificationCopy {
  readonly approvalTitle: string
  readonly allow: string
  readonly deny: string
  readonly questionTitle: string
}

/** One notification to present. */
export interface PendingNotificationSpec {
  readonly title: string
  readonly body: string
  /** Button labels in order; empty when the notification only focuses. */
  readonly actions: readonly string[]
}

/** Presentation events one notification reports back. */
export interface PendingNotificationEvents {
  /** A button was activated; `action` indexes {@link PendingNotificationSpec.actions}. */
  onAnswer(action: number): void
  /** The notification body was activated without answering. */
  onFocus(): void
  /** The user dismissed the notification without answering. */
  onDismissed(): void
}

/** The presentation face this hub drives. */
export interface PendingNotifier {
  /**
   * Present one notification.
   * @param spec - title, body, and button labels.
   * @param events - answer, focus, and dismissal callbacks.
   * @returns a handle that can close the notification.
   */
  show(spec: PendingNotificationSpec, events: PendingNotificationEvents): { close(): void }
}

/** The wire answer face: one `$events/result` round trip. */
export interface PendingResultPoster {
  /**
   * Post one Remote-event result.
   * @param result - the client-request payload for `$events/result`.
   * @returns the HTTP status the carrier answered.
   */
  post(result: {
    readonly clientId: string
    readonly eventId: string
    readonly outcome:
      | { readonly kind: 'next' }
      | { readonly kind: 'result'; readonly value?: unknown }
  }): Promise<number>
}

/** Diagnostic sink for non-fatal posting failures. */
export interface PendingNotificationLogger {
  warn(text: string): void
}

/** The hub's construction faces. */
export interface PendingNotificationHubOptions {
  readonly notifier: PendingNotifier
  readonly poster: PendingResultPoster
  readonly logger: PendingNotificationLogger
  readonly copy: PendingNotificationCopy
  /** Raises the application window; body activations invoke it. */
  readonly focus: () => void
}

/** Button order the answer callback indexes: allow, then deny. */
const ANSWER_ACTIONS = ['allowed-once', 'rejected'] as const

/** Whether one value is a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A non-empty string test shared by every frame field this hub reads. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * The notification answerer's state machine. Feed it the `$events` stream's
 * downlink frames; it presents, collapses, and answers pending waterfalls.
 */
export class PendingNotificationHub {
  private readonly options: PendingNotificationHubOptions
  private clientId: string | undefined
  private readonly shown = new Map<string, { close(): void }>()

  /** @param options - presentation, posting, diagnostics, and copy faces. */
  constructor(options: PendingNotificationHubOptions) {
    this.options = options
  }

  /**
   * Consume one downlink frame.
   * @param frame - one `$events` stream item as the carrier delivered it.
   */
  handleFrame(frame: unknown): void {
    if (!isRecord(frame)) return
    switch (frame.type) {
      case 'ready':
        if (isNonEmptyString(frame.clientId)) this.clientId = frame.clientId
        return
      case 'waterfall':
        this.presentWaterfall(frame)
        return
      case 'cancel':
        // The waterfall settled elsewhere (the renderer answered, the agent
        // cancelled, the session ended): collapse without answering.
        if (isNonEmptyString(frame.eventId)) this.closeOne(frame.eventId)
        return
      default:
        // Emit frames and anything unnamed carry nothing to answer.
        return
    }
  }

  /** Close every presented notification; the stream it rode has ended. */
  dispose(): void {
    for (const eventId of [...this.shown.keys()]) this.closeOne(eventId)
  }

  /** Present one waterfall as a notification, when its event is answerable here. */
  private presentWaterfall(frame: Record<string, unknown>): void {
    const eventId = frame.eventId
    if (!isNonEmptyString(eventId) || !isRecord(frame.request) || this.shown.has(eventId)) return
    if (this.clientId === undefined) return
    const clientId = this.clientId
    const copy = this.options.copy
    let spec: PendingNotificationSpec | undefined
    let outcomes: readonly ('allowed-once' | 'rejected')[] | undefined
    if (frame.event === 'approval/request') {
      const toolName = frame.request.toolName
      const reason = frame.request.reason
      const body = isNonEmptyString(reason) && isNonEmptyString(toolName)
        ? `${toolName}: ${reason}`
        : isNonEmptyString(toolName) ? toolName
          : isNonEmptyString(reason) ? reason
            : undefined
      if (body === undefined) return
      spec = { title: copy.approvalTitle, body, actions: [copy.allow, copy.deny] }
      outcomes = ANSWER_ACTIONS
    } else if (frame.event === 'user-questions/request') {
      const questions = frame.request.questions
      const first: unknown = Array.isArray(questions) ? questions[0] : undefined
      const question = isRecord(first) && isNonEmptyString(first.question) ? first.question : undefined
      if (question === undefined) return
      // Questions answer with structured drafts; the notification only brings
      // the window forward, and dismissing or answering in the window settles
      // the waterfall through the existing referee.
      spec = { title: copy.questionTitle, body: question, actions: [] }
    } else {
      return
    }
    const handle = this.options.notifier.show(spec, {
      onAnswer: (action) => {
        const outcome = outcomes?.[action]
        if (outcome === undefined) return
        // Local-first removal: the click is the user's answer; a late
        // cancellation frame or a racing renderer answer is a no-op either way.
        this.closeOne(eventId)
        void this.options.poster.post({ clientId, eventId, outcome: { kind: 'result', value: outcome } })
          .then((status) => {
            if (status !== 200) {
              this.options.logger.warn(`dsh desktop: notification answer answered ${String(status)}; the window may still hold the request`)
            }
          }, (error: unknown) => {
            this.options.logger.warn(`dsh desktop: notification answer failed: ${String(error)}`)
          })
      },
      onFocus: () => {
        this.options.focus()
      },
      onDismissed: () => {
        // Dismissal is not an answer; the waterfall keeps waiting on its
        // other deliveries.
        this.closeOne(eventId)
      },
    })
    this.shown.set(eventId, handle)
  }

  /** Remove and close one presented notification, if any. */
  private closeOne(eventId: string): void {
    const handle = this.shown.get(eventId)
    if (handle === undefined) return
    this.shown.delete(eventId)
    handle.close()
  }
}
