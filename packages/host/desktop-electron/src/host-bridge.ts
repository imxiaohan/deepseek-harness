/**
 * The host-child half of the desktop IPC carrier: dispatches protocol
 * messages against the booted composition — fetch round trips through the
 * connection shared handler, logical streams through the Gateway wire stream,
 * and the boot payload from the tree — pure over an injected channel so tests
 * drive it without a process.
 * @module @deepseek-ai/dsh-host-desktop-electron/host-bridge
 */

import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import type { DesktopHostChannel, DesktopIpcId, DesktopIpcMessage } from './ipc-protocol.ts'

/** The booted composition's carrier lanes the bridge dispatches onto. */
export interface DesktopHostRuntime {
  /** Plugin-asset and `/api` fetch handler (loopback-authority requests in, responses out). */
  fetch(request: Request): Promise<Response>
  /** Gateway wire-stream opener for logical Remote streams. */
  openStream(endpoint: string, payload: unknown, signal: AbortSignal): Promise<AsyncIterable<unknown>>
  /** Gateway error-to-wire mapper for terminal stream frames. */
  failure(error: unknown): unknown
  /** Index injection rows for the desktop index render. */
  bootPayload(): { injections: readonly IndexInjection[] }
}

/**
 * Serve the desktop carrier protocol until the returned disposer runs.
 * The channel adapter rejects malformed process values before dispatch.
 * @param channel - the host child's process channel.
 * @param runtime - the booted composition's lanes.
 * @returns the disposer detaching the listener, aborting work, and awaiting quiescence.
 */
export function serveDesktopHost(channel: DesktopHostChannel, runtime: DesktopHostRuntime): () => Promise<void> {
  const fetches = new Map<DesktopIpcId, FetchOperation>()
  const streams = new Map<DesktopIpcId, CarrierOperation>()
  let disposal: Promise<void> | undefined
  const dispose = channel.onMessage((message) => {
    handleMessage(message, channel, runtime, fetches, streams)
  })
  send(channel, { t: 'boot-res', injections: [...runtime.bootPayload().injections] })
  return () => {
    if (disposal !== undefined) return disposal
    dispose()
    const operations = [...fetches.values(), ...streams.values()]
    for (const operation of operations) operation.abort.abort(new Error('desktop host bridge disposed'))
    disposal = Promise.allSettled(operations.map(operation => operation.done)).then(() => {})
    return disposal
  }
}

/** One abortable carrier operation whose disposer waits for settlement. */
interface CarrierOperation {
  readonly abort: AbortController
  readonly done: Promise<void>
}

/** One fetch operation that reads at most one response-body chunk per pull. */
interface FetchOperation extends CarrierOperation {
  pull(): void
}

/** Dispatch one protocol message. */
function handleMessage(
  message: DesktopIpcMessage,
  channel: DesktopHostChannel,
  runtime: DesktopHostRuntime,
  fetches: Map<DesktopIpcId, FetchOperation>,
  streams: Map<DesktopIpcId, CarrierOperation>,
): void {
  switch (message.t) {
    case 'fetch': {
      if (fetches.has(message.id)) return
      const operation = startFetch(message, channel, runtime)
      const done = operation.done.finally(() => {
        fetches.delete(message.id)
      })
      fetches.set(message.id, { ...operation, done })
      return
    }
    case 'fetch-cancel': {
      fetches.get(message.id)?.abort.abort(new Error('desktop fetch cancelled'))
      return
    }
    case 'fetch-pull': {
      fetches.get(message.id)?.pull()
      return
    }
    case 'open-stream': {
      if (streams.has(message.id)) return
      const abort = new AbortController()
      const done = pumpStream(message.id, message.endpoint, message.payload, channel, runtime, abort.signal)
        .finally(() => {
          streams.delete(message.id)
        })
      streams.set(message.id, { abort, done })
      return
    }
    case 'stream-cancel': {
      streams.get(message.id)?.abort.abort(new Error('Remote stream cancelled'))
      return
    }
    default:
      // The process adapter consumes shutdown; responses and stream frames
      // flow child→main. The bridge ignores any such inbound message.
      return
  }
}

/** Start one unary or pull-driven fetch operation. */
function startFetch(
  message: Extract<DesktopIpcMessage, { t: 'fetch' }>,
  channel: DesktopHostChannel,
  runtime: DesktopHostRuntime,
): FetchOperation {
  const abort = new AbortController()
  const { signal } = abort
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let reading = false
  let finishBody: (() => void) | undefined
  const bodyDone = new Promise<void>((resolve) => { finishBody = resolve })
  const finish = (): void => { finishBody?.() }
  const cancelBody = (): void => {
    finish()
    if (reader !== undefined) void reader.cancel(signal.reason).catch(() => {})
  }
  signal.addEventListener('abort', cancelBody, { once: true })

  const done = (async (): Promise<void> => {
    try {
      let response: Response
      try {
        response = await runtime.fetch(new Request(message.url, {
          method: message.method,
          headers: message.headers,
          signal,
          ...message.body === undefined ? {} : { body: message.body },
        }))
      } catch (error) {
        if (signal.aborted) return
        response = new Response(error instanceof Error ? error.message : String(error), {
          status: 500,
          statusText: 'desktop host fetch failed',
        })
      }
      if (signal.aborted) {
        if (response.body !== null) await Promise.allSettled([response.body.cancel(signal.reason)])
        return
      }
      signal.throwIfAborted()
      if (message.streamBody !== true) {
        if (message.method.toUpperCase() === 'HEAD' || response.body === null) {
          send(channel, serializeResponseHead(message.id, response, false))
          return
        }
        reader = response.body.getReader()
        const body = await readResponseBody(reader, signal)
        signal.throwIfAborted()
        send(channel, serializeResponseBody(message.id, response, body))
        return
      }
      if (message.method.toUpperCase() === 'HEAD' || response.body === null) {
        send(channel, serializeResponseHead(message.id, response, false))
        return
      }
      reader = response.body.getReader()
      send(channel, serializeResponseHead(message.id, response, true))
      await bodyDone
    } catch (error) {
      if (!signal.aborted) {
        send(channel, {
          t: 'fetch-res',
          id: message.id,
          status: 500,
          statusText: 'desktop host fetch failed',
          headers: {},
          body: error instanceof Error ? error.message : String(error),
        })
      }
    } finally {
      signal.removeEventListener('abort', cancelBody)
      if (reader !== undefined) await Promise.allSettled([reader.cancel(signal.reason)])
    }
  })()

  return {
    abort,
    done,
    pull() {
      if (reader === undefined || reading || signal.aborted) return
      reading = true
      void (async () => {
        try {
          const next = await reader.read()
          signal.throwIfAborted()
          if (next.done) {
            send(channel, { t: 'fetch-end', id: message.id })
            finish()
          } else {
            send(channel, {
              t: 'fetch-chunk',
              id: message.id,
              bodyBase64: encodeBase64(next.value),
            })
          }
        } catch (error) {
          if (!signal.aborted) {
            send(channel, {
              t: 'fetch-error',
              id: message.id,
              error: error instanceof Error ? error.message : String(error),
            })
          }
          finish()
        } finally {
          reading = false
        }
      })()
    },
  }
}

/** Pump one logical stream until it ends, errors, or is cancelled. */
async function pumpStream(
  id: DesktopIpcId,
  endpoint: string,
  payload: unknown,
  channel: DesktopHostChannel,
  runtime: DesktopHostRuntime,
  signal: AbortSignal,
): Promise<void> {
  try {
    const source = await runtime.openStream(endpoint, payload, signal)
    for await (const value of source) {
      signal.throwIfAborted()
      send(channel, { t: 'stream-item', id, value })
    }
    signal.throwIfAborted()
    send(channel, { t: 'stream-end', id })
  } catch (error) {
    if (signal.aborted) return
    send(channel, { t: 'stream-error', id, error: runtime.failure(error) })
  }
}

/** Read a complete unary response while retaining a cancellable body reader. */
async function readResponseBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const next = await reader.read()
    signal.throwIfAborted()
    if (next.done) break
    chunks.push(next.value)
    size += next.value.byteLength
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

/** Serialize one complete unary fetch body onto the protocol. */
function serializeResponseBody(
  id: DesktopIpcId,
  response: Response,
  buffer: Uint8Array,
): DesktopIpcMessage {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => { headers[key] = value })
  const asText = decodeUtf8(buffer)
  return asText === undefined
    ? {
      t: 'fetch-res',
      id,
      status: response.status,
      statusText: response.statusText,
      headers,
      body: null,
      bodyBase64: encodeBase64(buffer),
    }
    : {
      t: 'fetch-res',
      id,
      status: response.status,
      statusText: response.statusText,
      headers,
      body: asText,
    }
}

/** Serialize response metadata with either no body or a pull-driven body. */
function serializeResponseHead(
  id: DesktopIpcId,
  response: Response,
  bodyStream: boolean,
): DesktopIpcMessage {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => { headers[key] = value })
  return {
    t: 'fetch-res',
    id,
    status: response.status,
    statusText: response.statusText,
    headers,
    body: null,
    ...bodyStream ? { bodyStream: true } : {},
  }
}

/** Send one frame unless the process channel has already closed. */
function send(channel: DesktopHostChannel, message: DesktopIpcMessage): void {
  try {
    channel.send(message)
  } catch (processChannelClosed) {
    void processChannelClosed
  }
}

/** UTF-8 decode that rejects invalid byte sequences instead of replacing them. */
function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return decoded.includes('\uFFFD') ? undefined : decoded
  } catch {
    return undefined
  }
}

/** Standard base64 for protocol bodies. */
function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}
