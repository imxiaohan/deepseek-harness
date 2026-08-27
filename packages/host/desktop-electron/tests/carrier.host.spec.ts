/**
 * Carrier protocol tests over an in-memory bridge: the preload transport and
 * the host bridge speak the real IPC protocol end to end — the preload's
 * fetch serialization, the bridge's loopback-authority reconstruction through
 * a real `HostConnectionService` dispatch, and the stream relay's frame
 * lifecycle — without a process or an Electron.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import {
  CARRIER_LOOPBACK_HOST,
  createDesktopTransport,
  loopbackCarrierUrl,
  serveDesktopHost,
  type DesktopHostChannel,
  type DesktopHostRuntime,
  type DesktopIpcMessage,
} from '../src/index.ts'
import {
  DESKTOP_FETCH_CHANNEL,
  type DesktopStreamEvent,
  type PreloadFetchPayload,
  type PreloadRpc,
} from '../src/preload-core.ts'

/** One paired in-memory renderer↔main↔host carrier. */
interface Carrier {
  readonly transport: ReturnType<typeof createDesktopTransport>
  readonly hostRuntime: DesktopHostRuntime
  /** Messages the renderer-side rpc sent toward main, per channel. */
  readonly sent: Map<string, unknown[]>
  /** Push one main→renderer stream event. */
  deliverStream(event: DesktopStreamEvent): void
  /** Answer the pending renderer invoke on one channel as the main process would. */
  answerInvoke(channel: string, value: unknown): void
}

/**
 * Assemble the carrier: the preload transport over a recording rpc, the host
 * bridge over a recording channel, with the test driving the main-process
 * relay between them (loopback mapping and sender gating live in the app).
 */
function createCarrier(runtime: DesktopHostRuntime): Carrier {
  const sent = new Map<string, unknown[]>()
  const invokers = new Map<string, (value: unknown) => void>()
  const streamListeners = new Set<(event: DesktopStreamEvent) => void>()
  const rpc: PreloadRpc = {
    invoke: async (channel, payload) => {
      const list = sent.get(channel) ?? []
      list.push(payload)
      sent.set(channel, list)
      return new Promise((resolve) => { invokers.set(channel, resolve) })
    },
    on: (_channel, listener) => {
      streamListeners.add(listener)
      return () => { streamListeners.delete(listener) }
    },
    send: (channel, payload) => {
      const list = sent.get(channel) ?? []
      list.push(payload)
      sent.set(channel, list)
    },
    newId: () => `id-${String(sent.size)}-${randomUUID()}`,
  }
  return {
    transport: createDesktopTransport(rpc),
    hostRuntime: runtime,
    sent,
    deliverStream: (event) => { for (const listener of [...streamListeners]) listener(event) },
    answerInvoke: (channelName, value) => {
      invokers.get(channelName)?.(value)
      invokers.delete(channelName)
    },
  }
}

describe('loopbackCarrierUrl', () => {
  it('rewrites the renderer scheme origin onto the loopback authority', () => {
    expect(loopbackCarrierUrl('dsh-desktop://app/api/session.list?x=1'))
      .toBe(`http://${CARRIER_LOOPBACK_HOST}/api/session.list?x=1`)
    expect(loopbackCarrierUrl('http://example.dev/api/x')).toBe(`http://${CARRIER_LOOPBACK_HOST}/api/x`)
  })
})

describe('the in-memory carrier', () => {
  it('round-trips one unary call through the real HostConnectionService dispatch', async () => {
    const ctx = new Context()
    const service = new HostConnectionService(ctx, [], {
      isAuthenticated: () => true,
      authorizeIndex: () => true,
      authenticatedUrl: (base: string) => base,
    } as unknown as ConstructorParameters<typeof HostConnectionService>[2])
    // The Gateway's interceptor row: claims every endpoint, so the shared
    // handler dispatches through the real envelope/zod path.
    const disposer = service.rpc.intercept('/api', () => true, async (_endpoint, payload) => ({
      ok: true as const,
      value: { echoed: payload },
    }))
    const handler = service.createSharedFetchHandler('/api')
    const seen: Request[] = []
    const carrier = createCarrier({
      fetch: async (request) => {
        seen.push(request)
        return handler.fetch(request)
      },
      openStream: async function* () {},
      failure: error => error,
      bootPayload: () => ({ injections: [] }),
      bundleBytes: () => new Uint8Array(),
    })

    const call = carrier.transport.fetch(
      new URL('/api/registry.describe', 'dsh-desktop://app'),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'registry.describe', payload: {} }),
      },
    )
    // Drive the main-process relay: loopback mapping plus the synthesized
    // Host header the fence reads.
    const payload = carrier.sent.get(DESKTOP_FETCH_CHANNEL)?.[0] as PreloadFetchPayload
    expect(payload.url).toBe('dsh-desktop://app/api/registry.describe')
    const dispatched = new Request(loopbackCarrierUrl(payload.url), {
      method: payload.method,
      headers: { ...payload.headers, host: CARRIER_LOOPBACK_HOST },
      ...(payload.body === undefined ? {} : { body: payload.body }),
    })
    const response = await carrier.hostRuntime.fetch(dispatched)
    carrier.answerInvoke(DESKTOP_FETCH_CHANNEL, {
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body: await response.text(),
    })
    const settled = await call
    expect(settled.status).toBe(200)
    const envelope = await settled.clone().json() as { result: { ok: boolean; value: unknown } }
    expect(envelope.result.ok).toBe(true)
    // The reconstructed request carries the synthesized loopback Host.
    expect(seen[0]?.headers.get('host')).toBe(CARRIER_LOOPBACK_HOST)
    disposer()
    await ctx.fiber.dispose()
  })

  it('relays the stream lifecycle through the host bridge, one logical stream at a time', async () => {
    const opened: { endpoint: string; payload: unknown }[] = []
    // The host bridge over an in-memory channel; the test drives the
    // main-process relay between the preload rpc and this channel.
    const toHost: ((message: DesktopIpcMessage) => void)[] = []
    const fromHost: DesktopIpcMessage[] = []
    const runtime: DesktopHostRuntime = {
      fetch: async () => new Response('unused'),
      openStream: async function* (endpoint, payload) {
        opened.push({ endpoint, payload })
        yield { type: 'ready' }
        yield { type: 'emit', event: 'tick' }
      },
      failure: error => ({ message: String(error) }),
      bootPayload: () => ({ injections: [] }),
      bundleBytes: () => new Uint8Array(),
    }
    const disposeHost = serveDesktopHost({
      send: (message) => { fromHost.push(message) },
      onMessage: (listener) => {
        toHost.push(listener)
        return () => {}
      },
    }, runtime)
    try {
      const sent = new Map<string, unknown[]>()
      const streamListeners = new Set<(event: DesktopStreamEvent) => void>()
      const record = (channel: string, payload: unknown): void => {
        const list = sent.get(channel) ?? []
        list.push(payload)
        sent.set(channel, list)
      }
      const rpc: PreloadRpc = {
        invoke: (channel, payload) => {
          record(channel, payload)
          const request = payload as { id: string; endpoint: string; payload: unknown }
          for (const deliver of [...toHost]) deliver({ t: 'open-stream', id: request.id, endpoint: request.endpoint, payload: request.payload })
          return Promise.resolve('ok')
        },
        on: (_channel, listener) => {
          streamListeners.add(listener)
          return () => { streamListeners.delete(listener) }
        },
        send: (channel, payload) => {
          record(channel, payload)
          const request = payload as { id: string }
          for (const deliver of [...toHost]) deliver({ t: 'stream-cancel', id: request.id })
        },
        newId: () => `stream-${String(sent.size)}`,
      }
      const deliverHostFrames = (): void => {
        for (const message of fromHost.splice(0)) {
          if (message.t === 'stream-item') {
            for (const listener of [...streamListeners]) listener({ kind: 'item', id: message.id, value: message.value })
          } else if (message.t === 'stream-end') {
            for (const listener of [...streamListeners]) listener({ kind: 'end', id: message.id })
          } else if (message.t === 'stream-error') {
            for (const listener of [...streamListeners]) listener({ kind: 'error', id: message.id, error: message.error })
          }
        }
      }

      const transport = createDesktopTransport(rpc)
      const controller = new AbortController()
      const iterator = transport.openStream?.('$events', { args: {} }, controller.signal)
      expect(iterator).toBeDefined()
      const read = (async () => {
        const items: unknown[] = []
        for await (const item of iterator!) items.push(item)
        return items
      })()
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      deliverHostFrames()
      // The generator parks until the frames arrive; pump once more for the
      // terminal wake.
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      deliverHostFrames()
      expect(await read).toEqual([{ type: 'ready' }, { type: 'emit', event: 'tick' }])
      expect(opened).toEqual([{ endpoint: '$events', payload: { args: {} } }])
      expect(fromHost).toEqual([])
    } finally {
      disposeHost()
    }
  })

  it('serves the host-bridge protocol over an in-memory channel', async () => {
    const inbound: DesktopIpcMessage[] = []
    const outbound: DesktopIpcMessage[] = []
    const channel: DesktopHostChannel = {
      send: (message) => { outbound.push(message) },
      onMessage: (listener) => {
        const push = (message: DesktopIpcMessage): void => {
          inbound.push(message)
          listener(message)
        }
        queueMicrotask(() => {
          push({ t: 'boot' })
          push({ t: 'bundle', id: 'b1', package: '@deepseek-ai/dsh-x' })
        })
        return () => {}
      },
    }
    const dispose = serveDesktopHost(channel, {
      fetch: async () => new Response('{"type":"server-response"}', { headers: { 'content-type': 'application/json' } }),
      openStream: async function* () {},
      failure: error => error,
      bootPayload: () => ({ injections: [{ kind: 'global', name: '__DSH_BOOT__', value: { rev: 'r' } }] }),
      bundleBytes: () => new Uint8Array([1, 2, 3]),
    })
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    expect(outbound).toContainEqual({ t: 'boot-res', injections: [{ kind: 'global', name: '__DSH_BOOT__', value: { rev: 'r' } }] })
    const bundle = outbound.find(message => message.t === 'bundle-res')
    expect(bundle).toMatchObject({ t: 'bundle-res', id: 'b1', bytesBase64: 'AQID' })
    dispose()
    expect(inbound.map(message => message.t)).toEqual(['boot', 'bundle'])
  })
})
