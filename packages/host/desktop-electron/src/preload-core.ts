/**
 * The renderer half of the desktop IPC carrier: the `ClientTransportHooks`
 * face the preload installs as `window.__DSH_TRANSPORT__`, pure over injected
 * Electron primitives so tests drive it without a renderer. `fetch` rides one
 * invoke round trip with correlated cancellation; `openStream` yields one
 * async iterator per logical stream fed by main-process events; `ownsHost`
 * declares the renderer owns its host outright.
 * @module @deepseek-ai/dsh-host-desktop-electron/preload-core
 */

import {
  parseDesktopIpcMessage,
  type DesktopIpcId,
  type DesktopIpcMessage,
} from './ipc-protocol.ts'

/**
 * The transport face this package assembles: structurally the connection
 * client's `ClientTransportHooks` (the page global `__DSH_TRANSPORT__`).
 * Declared locally because a host-face package cannot import the client
 * subpath that owns the original; the carrier test pins the shape against
 * the real `createWebConnectionRpc` at compile time.
 */
export interface DesktopTransportHooks {
  /** Transport for generic unary RPC channels; same signature as the global `fetch`. */
  fetch(input: URL, init: RequestInit): Promise<Response>
  /** Carrier-local Gateway stream opener; one async iterator per logical stream. */
  openStream(endpoint: string, payload: unknown, signal: AbortSignal): AsyncIterable<unknown>
  /** The transport owner declares the page owns the Host outright. */
  readonly ownsHost: boolean
}

/** One invoke-style round trip to the main process. */
export type PreloadInvoke = (channel: string, payload: unknown) => Promise<unknown>

/** One event subscription against the main process. */
export type PreloadOn = (channel: string, listener: (payload: unknown) => void) => () => void

/** One fire-and-forget message to the main process. */
export type PreloadSend = (channel: string, payload: unknown) => void

/** The renderer primitives the transport is assembled from. */
export interface PreloadRpc {
  readonly invoke: PreloadInvoke
  readonly on: PreloadOn
  readonly send: PreloadSend
  /** Fresh correlation id for one fetch or stream. */
  newId(): DesktopIpcId
}

/** IPC channels between the preload and the main process. */
export const DESKTOP_FETCH_CHANNEL = 'dsh-desktop:fetch'
/** IPC channel carrying one fetch cancellation to the main process. */
export const DESKTOP_FETCH_CANCEL_CHANNEL = 'dsh-desktop:fetch-cancel'
/** IPC channel carrying one logical stream's open request to the main process. */
export const DESKTOP_OPEN_STREAM_CHANNEL = 'dsh-desktop:open-stream'
/** IPC channel carrying one logical stream's cancellation to the main process. */
export const DESKTOP_STREAM_CANCEL_CHANNEL = 'dsh-desktop:stream-cancel'
/** IPC channel the main process uses to push one logical stream's lifecycle events. */
export const DESKTOP_STREAM_EVENT_CHANNEL = 'dsh-desktop:stream-event'

/** One stream lifecycle event the main process pushes. */
export type DesktopStreamEvent = Extract<
  DesktopIpcMessage,
  { readonly t: 'stream-item' | 'stream-end' | 'stream-error' }
>

/** Serialized fetch round trip both directions share. */
export interface PreloadFetchPayload {
  readonly id: DesktopIpcId
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body?: string
}

/**
 * Assemble the desktop transport hooks over the preload primitives.
 * @param rpc - invoke/on/send primitives and a stream-id source.
 * @returns the hooks the preload installs before any client plugin loads.
 */
export function createDesktopTransport(rpc: PreloadRpc): DesktopTransportHooks {
  return {
    async fetch(input, init) {
      const headers: Record<string, string> = {}
      const headerInit = init.headers
      if (headerInit !== undefined) {
        if (Array.isArray(headerInit)) {
          for (const [key, value] of headerInit) headers[key] = value
        } else if (headerInit instanceof Headers) {
          headerInit.forEach((value, key) => { headers[key] = value })
        } else {
          for (const [key, value] of Object.entries(headerInit)) headers[key] = value
        }
      }
      const id = rpc.newId()
      const payload: PreloadFetchPayload = {
        id,
        url: input.href,
        method: init.method ?? 'GET',
        headers,
        ...typeof init.body === 'string' ? { body: init.body } : {},
      }
      const signal = init.signal
      signal?.throwIfAborted()
      let rejectAborted: ((reason?: unknown) => void) | undefined
      const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject })
      const abort = (): void => {
        rpc.send(DESKTOP_FETCH_CANCEL_CHANNEL, { id })
        rejectAborted?.(signal?.reason)
      }
      signal?.addEventListener('abort', abort, { once: true })
      let raw: unknown
      try {
        raw = signal === undefined
          ? await rpc.invoke(DESKTOP_FETCH_CHANNEL, payload)
          : await Promise.race([rpc.invoke(DESKTOP_FETCH_CHANNEL, payload), aborted])
      } finally {
        signal?.removeEventListener('abort', abort)
      }
      const response = parseDesktopIpcMessage(raw)
      if (response?.t !== 'fetch-res' || response.id !== id || response.bodyStream === true) {
        throw new Error('desktop fetch received an invalid response')
      }
      const body = response.bodyBase64 !== undefined
        // Node/DOM fetch accept Uint8Array bodies; the generic mismatch is a
        // typings artifact of the shared Node+browser source.
        ? (Uint8Array.from(atob(response.bodyBase64), char => char.charCodeAt(0)) as unknown as BodyInit)
        : response.body
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    },
    openStream(endpoint, payload, signal) {
      return streamOver(rpc, endpoint, payload, signal)
    },
    ownsHost: true,
  }
}

/** Yield one logical stream fed by main-process events until it terminates. */
async function* streamOver(
  rpc: PreloadRpc,
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
): AsyncGenerator<unknown, void, unknown> {
  signal.throwIfAborted()
  const id = rpc.newId()
  const queue: DesktopStreamEvent[] = []
  let notify: (() => void) | undefined
  let cancellationSent = false
  let cancelled = false
  let resolveCancellation: ((value: 'cancelled') => void) | undefined
  const cancellation = new Promise<'cancelled'>((resolve) => {
    resolveCancellation = resolve
  })
  const deliver = (event: DesktopStreamEvent): void => {
    if (cancelled) return
    queue.push(event)
    notify?.()
  }
  const dispose = rpc.on(DESKTOP_STREAM_EVENT_CHANNEL, (raw) => {
    const event = parseDesktopIpcMessage(raw)
    if (event?.t !== 'stream-item' && event?.t !== 'stream-end' && event?.t !== 'stream-error') return
    if (event.id === id) deliver(event)
  })
  const sendCancel = (): void => {
    if (cancellationSent) return
    cancellationSent = true
    rpc.send(DESKTOP_STREAM_CANCEL_CHANNEL, { id })
  }
  const abort = (): void => {
    cancelled = true
    queue.splice(0)
    sendCancel()
    resolveCancellation?.('cancelled')
    notify?.()
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    const acknowledgement = await Promise.race([
      rpc.invoke(DESKTOP_OPEN_STREAM_CHANNEL, { id, endpoint, payload }),
      cancellation,
    ])
    if (acknowledgement === 'cancelled') return
    if (acknowledgement !== 'ok') throw new Error('desktop stream received an invalid acknowledgement')
    while (true) {
      while (queue.length === 0) {
        if (signal.aborted) return
        await new Promise<void>((resolve) => { notify = resolve })
        notify = undefined
      }
      const event = queue.shift() as DesktopStreamEvent
      if (event.t === 'stream-item') yield event.value
      else if (event.t === 'stream-end') return
      else throw new Error(`desktop stream failed: ${JSON.stringify(event.error)}`)
    }
  } finally {
    dispose()
    signal.removeEventListener('abort', abort)
    sendCancel()
  }
}
