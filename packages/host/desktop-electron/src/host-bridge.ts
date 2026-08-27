/**
 * The host-child half of the desktop IPC carrier: dispatches protocol
 * messages against the booted composition — fetch round trips through the
 * connection shared handler, logical streams through the Gateway wire stream,
 * the boot payload and plugin-bundle bytes from the tree — pure over an
 * injected channel so tests drive it without a process.
 * @module @deepseek-ai/dsh-host-desktop-electron/host-bridge
 */

import type { DesktopHostChannel, DesktopIpcMessage } from './ipc-protocol.ts'

/** The booted composition's carrier lanes the bridge dispatches onto. */
export interface DesktopHostRuntime {
  /** Shared `/api` fetch handler (loopback-authority requests in, responses out). */
  fetch(request: Request): Promise<Response>
  /** Gateway wire-stream opener for logical Remote streams. */
  openStream(endpoint: string, payload: unknown, signal: AbortSignal): AsyncIterable<unknown>
  /** Gateway error-to-wire mapper for terminal stream frames. */
  failure(error: unknown): unknown
  /** Index injection rows for the desktop index render. */
  bootPayload(): { injections: readonly unknown[] }
  /** Bytes of one plugin's client bundle. */
  bundleBytes(pkg: string): Uint8Array
}

/**
 * Serve the desktop carrier protocol until the returned disposer runs.
 * Unknown messages are ignored (a newer main against an older child degrades
 * loudly at the caller, not by killing the channel).
 * @param channel - the host child's process channel.
 * @param runtime - the booted composition's lanes.
 * @returns the disposer detaching the listener and aborting open streams.
 */
export function serveDesktopHost(channel: DesktopHostChannel, runtime: DesktopHostRuntime): () => void {
  const aborts = new Map<string, AbortController>()
  const dispose = channel.onMessage((message) => {
    void handleMessage(message, channel, runtime, aborts)
  })
  return () => {
    dispose()
    for (const abort of aborts.values()) abort.abort(new Error('desktop host bridge disposed'))
    aborts.clear()
  }
}

/** Dispatch one protocol message. */
async function handleMessage(
  message: DesktopIpcMessage,
  channel: DesktopHostChannel,
  runtime: DesktopHostRuntime,
  aborts: Map<string, AbortController>,
): Promise<void> {
  switch (message.t) {
    case 'boot':
      channel.send({ t: 'boot-res', injections: [...runtime.bootPayload().injections] })
      return
    case 'bundle': {
      const bytes = runtime.bundleBytes(message.package)
      channel.send({ t: 'bundle-res', id: message.id, bytesBase64: encodeBase64(bytes) })
      return
    }
    case 'fetch': {
      let response: Response
      try {
        response = await runtime.fetch(new Request(message.url, {
          method: message.method,
          headers: message.headers,
          ...message.body === undefined ? {} : { body: message.body },
        }))
      } catch (error) {
        // A thrown transport failure is a 500: the carrier contract keeps
        // envelope-level errors inside fetch responses.
        channel.send({
          t: 'fetch-res',
          id: message.id,
          status: 500,
          statusText: 'desktop host fetch failed',
          headers: {},
          body: error instanceof Error ? error.message : String(error),
        })
        return
      }
      channel.send(await serializeResponse(message.id, response))
      return
    }
    case 'open-stream': {
      if (aborts.has(message.id)) return
      const abort = new AbortController()
      aborts.set(message.id, abort)
      void pumpStream(message.id, message.endpoint, message.payload, channel, runtime, aborts, abort)
      return
    }
    case 'stream-cancel': {
      aborts.get(message.id)?.abort(new Error('Remote stream cancelled'))
      return
    }
    default:
      // Responses and stream frames flow child→main only; an inbound frame of
      // these shapes is a protocol echo the child ignores.
      return
  }
}

/** Pump one logical stream until it ends, errors, or is cancelled. */
async function pumpStream(
  id: string,
  endpoint: string,
  payload: unknown,
  channel: DesktopHostChannel,
  runtime: DesktopHostRuntime,
  aborts: Map<string, AbortController>,
  abort: AbortController,
): Promise<void> {
  const remove = (): void => { aborts.delete(id) }
  try {
    const source = await runtime.openStream(endpoint, payload, abort.signal)
    for await (const value of source) {
      channel.send({ t: 'stream-item', id, value })
    }
    remove()
    channel.send({ t: 'stream-end', id })
  } catch (error) {
    remove()
    if (abort.signal.aborted) return
    channel.send({ t: 'stream-error', id, error: runtime.failure(error) })
  }
}

/** Serialize one fetch `Response` onto the protocol. */
async function serializeResponse(id: string, response: Response): Promise<DesktopIpcMessage> {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => { headers[key] = value })
  const buffer = new Uint8Array(await response.arrayBuffer())
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
