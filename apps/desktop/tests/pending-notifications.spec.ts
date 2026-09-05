/**
 * The notification answerer's state machine over injected faces: presentation
 * on waterfalls, the answer RPC on button activation, collapse on
 * cancellation, and dismissal that never answers.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  PendingNotificationHub,
  type PendingNotificationEvents,
  type PendingNotificationSpec,
  type PendingNotifier,
  type PendingResultPoster,
} from '../src/pending-notifications.ts'

const COPY = {
  approvalTitle: 'Approval requested',
  allow: 'Allow',
  deny: 'Deny',
  questionTitle: 'Question waiting',
}

/** One recorded notification and the means to drive its events. */
interface Recorded {
  readonly spec: PendingNotificationSpec
  readonly events: PendingNotificationEvents
  close: () => void
}

function harness() {
  const recorded: Recorded[] = []
  const posted: Array<{ clientId: string; eventId: string; outcome: unknown }> = []
  const warnings: string[] = []
  const focused: number[] = []
  const notifier: PendingNotifier = {
    show: (spec, events) => {
      const entry: Recorded = { spec, events, close: vi.fn() }
      recorded.push(entry)
      return { close: () => { entry.close() } }
    },
  }
  const poster: PendingResultPoster = {
    post: async (result) => {
      posted.push({ clientId: result.clientId, eventId: result.eventId, outcome: result.outcome })
      return 200
    },
  }
  const hub = new PendingNotificationHub({
    notifier,
    poster,
    logger: { warn: (text) => { warnings.push(text) } },
    copy: COPY,
    focus: () => { focused.push(focused.length) },
  })
  return { hub, recorded, posted, warnings, focused }
}

const ready = { type: 'ready', clientId: 'client-1', host: { home: '/home' } }
const approval = {
  type: 'waterfall',
  event: 'approval/request',
  eventId: 'event-1',
  agentId: 'agent-1',
  request: { toolName: 'bash', reason: 'rm -rf build' },
}
const question = {
  type: 'waterfall',
  event: 'user-questions/request',
  eventId: 'event-2',
  agentId: 'agent-1',
  request: { questions: [{ id: 'q1', question: 'Deploy now?' }] },
}

describe('the pending notification hub', () => {
  it('presents an approval waterfall with answer buttons', () => {
    const { hub, recorded } = harness()
    hub.handleFrame(ready)
    hub.handleFrame(approval)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.spec).toEqual({
      title: COPY.approvalTitle,
      body: 'bash: rm -rf build',
      actions: [COPY.allow, COPY.deny],
    })
  })

  it('answers a button activation through the result RPC and closes locally', async () => {
    const { hub, recorded, posted } = harness()
    hub.handleFrame(ready)
    hub.handleFrame(approval)
    recorded[0]!.events.onAnswer(0)
    expect(posted).toEqual([{
      clientId: 'client-1',
      eventId: 'event-1',
      outcome: { kind: 'result', value: 'allowed-once' },
    }])
    // A late cancellation for the answered event is a no-op collapse.
    hub.handleFrame({ type: 'cancel', eventId: 'event-1' })
    expect(recorded[0]!.close).toHaveBeenCalledTimes(1)
  })

  it('denies through the second button', async () => {
    const { hub, recorded, posted } = harness()
    hub.handleFrame(ready)
    hub.handleFrame(approval)
    recorded[0]!.events.onAnswer(1)
    expect(posted).toEqual([{
      clientId: 'client-1',
      eventId: 'event-1',
      outcome: { kind: 'result', value: 'rejected' },
    }])
  })

  it('collapses without answering when the waterfall settles elsewhere', () => {
    const { hub, recorded, posted } = harness()
    hub.handleFrame(ready)
    hub.handleFrame(approval)
    hub.handleFrame({ type: 'cancel', eventId: 'event-1' })
    expect(recorded[0]!.close).toHaveBeenCalledTimes(1)
    expect(posted).toHaveLength(0)
  })

  it('dismissal is not an answer', () => {
    const { hub, recorded, posted } = harness()
    hub.handleFrame(ready)
    hub.handleFrame(approval)
    recorded[0]!.events.onDismissed()
    expect(recorded[0]!.close).toHaveBeenCalledTimes(1)
    expect(posted).toHaveLength(0)
  })

  it('body activation focuses the window without answering', () => {
    const { hub, recorded, posted, focused } = harness()
    hub.handleFrame(ready)
    hub.handleFrame(approval)
    recorded[0]!.events.onFocus()
    expect(focused).toHaveLength(1)
    expect(posted).toHaveLength(0)
    expect(recorded[0]!.close).toHaveBeenCalledTimes(0)
  })

  it('presents a question as focus-only and answers nothing from it', () => {
    const { hub, recorded, posted } = harness()
    hub.handleFrame(ready)
    hub.handleFrame(question)
    expect(recorded[0]!.spec).toEqual({
      title: COPY.questionTitle,
      body: 'Deploy now?',
      actions: [],
    })
    // Focus-only notifications expose no buttons; the activation path is focus.
    recorded[0]!.events.onFocus()
    expect(posted).toHaveLength(0)
  })

  it('ignores waterfalls before the ready frame named a client', () => {
    const { hub, recorded } = harness()
    hub.handleFrame(approval)
    expect(recorded).toHaveLength(0)
  })

  it('ignores unrelated events, malformed frames, and repeated deliveries', () => {
    const { hub, recorded } = harness()
    hub.handleFrame(ready)
    hub.handleFrame({ type: 'waterfall', event: 'settings/document-updated', eventId: 'x', request: {} })
    hub.handleFrame({ type: 'emit', event: 'api-session/added', args: [] })
    hub.handleFrame('not a frame')
    hub.handleFrame(approval)
    hub.handleFrame(approval)
    expect(recorded).toHaveLength(1)
  })

  it('ignores a ready frame without a client id and a cancel without an event id', () => {
    const { hub, recorded } = harness()
    hub.handleFrame({ type: 'ready', clientId: 7 })
    hub.handleFrame(approval)
    hub.handleFrame({ type: 'cancel', eventId: '' })
    expect(recorded).toHaveLength(0)
  })

  it('presents a tool name alone as the body', () => {
    const { hub, recorded } = harness()
    hub.handleFrame(ready)
    hub.handleFrame({
      type: 'waterfall',
      event: 'approval/request',
      eventId: 'event-5',
      request: { toolName: 'bash' },
    })
    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.spec.body).toBe('bash')
  })

  it('skips a question frame whose questions carry nothing presentable', () => {
    const { hub, recorded } = harness()
    hub.handleFrame(ready)
    hub.handleFrame({
      type: 'waterfall',
      event: 'user-questions/request',
      eventId: 'event-6',
      request: { questions: 'nope' },
    })
    hub.handleFrame({
      type: 'waterfall',
      event: 'user-questions/request',
      eventId: 'event-7',
      request: { questions: [{ question: 42 }] },
    })
    expect(recorded).toHaveLength(0)
  })

  it('presents a body-less reason alone and skips a blank approval', () => {
    const { hub, recorded } = harness()
    hub.handleFrame(ready)
    hub.handleFrame({
      type: 'waterfall',
      event: 'approval/request',
      eventId: 'event-3',
      request: { reason: 'continue anyway?' },
    })
    hub.handleFrame({
      type: 'waterfall',
      event: 'approval/request',
      eventId: 'event-4',
      request: {},
    })
    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.spec.body).toBe('continue anyway?')
  })

  it('ignores an action activation a notification never offered', () => {
    const { hub, recorded, posted } = harness()
    hub.handleFrame(ready)
    hub.handleFrame(question)
    hub.handleFrame(approval)
    recorded[0]!.events.onAnswer(0)
    recorded[1]!.events.onAnswer(7)
    expect(posted).toHaveLength(0)
  })

  it('warns when the answer RPC does not land', async () => {
    const recorded_: Recorded[] = []
    const notifier: PendingNotifier = {
      show: (spec, events) => {
        const entry: Recorded = { spec, events, close: vi.fn() }
        recorded_.push(entry)
        return { close: () => { entry.close() } }
      },
    }
    const hub = new PendingNotificationHub({
      notifier,
      poster: { post: async () => 500 },
      logger: { warn: (text) => { expect(text).toContain('500') } },
      copy: COPY,
      focus: () => {},
    })
    hub.handleFrame(ready)
    hub.handleFrame(approval)
    recorded_[0]!.events.onAnswer(0)
    await new Promise(resolve => setImmediate(resolve))
  })

  it('warns when the answer RPC rejects', async () => {
    const recorded_: Recorded[] = []
    const notifier: PendingNotifier = {
      show: (spec, events) => {
        const entry: Recorded = { spec, events, close: vi.fn() }
        recorded_.push(entry)
        return { close: () => { entry.close() } }
      },
    }
    const hub = new PendingNotificationHub({
      notifier,
      poster: { post: () => Promise.reject(new Error('ipc closed')) },
      logger: { warn: (text) => { expect(text).toContain('ipc closed') } },
      copy: COPY,
      focus: () => {},
    })
    hub.handleFrame(ready)
    hub.handleFrame(approval)
    recorded_[0]!.events.onAnswer(0)
    await new Promise(resolve => setImmediate(resolve))
  })

  it('dispose closes everything it presented', () => {
    const { hub, recorded } = harness()
    hub.handleFrame(ready)
    hub.handleFrame(approval)
    hub.handleFrame(question)
    hub.dispose()
    expect(recorded[0]!.close).toHaveBeenCalledTimes(1)
    expect(recorded[1]!.close).toHaveBeenCalledTimes(1)
  })
})
