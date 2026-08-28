/**
 * Carrier protocol tests over an in-memory bridge: the preload transport and
 * the host bridge speak the real IPC protocol end to end — the preload's
 * fetch serialization, the bridge's loopback-authority reconstruction through
 * a real `HostConnectionService` dispatch, and the stream relay's frame
 * lifecycle — without a process or an Electron.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import {
  CARRIER_LOOPBACK_HOST,
  createDesktopTransport,
  DesktopIpcId,
  loopbackCarrierUrl,
  serveDesktopHost,
  type DesktopHostChannel,
  type DesktopHostRuntime,
  type DesktopIpcMessage,
} from '../src/index.ts'
import {
  DESKTOP_FETCH_CANCEL_CHANNEL,
  DESKTOP_FETCH_CHANNEL,
  DESKTOP_STREAM_CANCEL_CHANNEL,
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
  const streamListeners = new Set<(event: unknown) => void>()
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
    newId: () => DesktopIpcId(`id-${String(sent.size)}-${randomUUID()}`),
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
  it('serializes renderer fetch header, body, and binary response variants', async () => {
    const invoked: PreloadFetchPayload[] = []
    const replies = [
      { t: 'fetch-res', id: DesktopIpcId('fetch'), status: 200, statusText: 'OK', headers: {}, body: null, bodyBase64: '/w==' },
      { t: 'fetch-res', id: DesktopIpcId('fetch'), status: 204, statusText: 'No Content', headers: {}, body: null },
      { t: 'fetch-res', id: DesktopIpcId('fetch'), status: 200, statusText: 'OK', headers: {}, body: 'headers' },
    ]
    const transport = createDesktopTransport({
      invoke: async (_channel, payload) => {
        invoked.push(payload as PreloadFetchPayload)
        return replies.shift()
      },
      on: () => () => {},
      send: () => {},
      newId: () => DesktopIpcId('fetch'),
    })

    const binary = await transport.fetch(new URL('dsh-desktop://app/api/binary'), {
      headers: [['x-test', 'yes']],
      body: new Uint8Array([1]),
    })
    expect([...new Uint8Array(await binary.arrayBuffer())]).toEqual([255])
    expect(invoked[0]).toEqual({
      id: 'fetch',
      url: 'dsh-desktop://app/api/binary',
      method: 'GET',
      headers: { 'x-test': 'yes' },
    })

    const empty = await transport.fetch(new URL('dsh-desktop://app/api/empty'), {})
    expect(empty.status).toBe(204)
    expect(await empty.text()).toBe('')
    expect(invoked[1]?.headers).toEqual({})

    const nativeHeaders = await transport.fetch(new URL('dsh-desktop://app/api/headers'), {
      headers: new Headers([['x-native', 'yes']]),
    })
    expect(await nativeHeaders.text()).toBe('headers')
    expect(invoked[2]?.headers).toEqual({ 'x-native': 'yes' })
  })

  it('cancels renderer fetches and rejects invalid main-process responses', async () => {
    const sent: { channel: string; payload: unknown }[] = []
    let answer: ((value: unknown) => void) | undefined
    const transport = createDesktopTransport({
      invoke: async () => new Promise((resolve) => { answer = resolve }),
      on: () => () => {},
      send: (channel, payload) => { sent.push({ channel, payload }) },
      newId: () => DesktopIpcId('abort-fetch'),
    })
    const controller = new AbortController()
    const reason = new Error('caller stopped')
    const pending = transport.fetch(new URL('dsh-desktop://app/api/slow'), { signal: controller.signal })
    controller.abort(reason)

    await expect(pending).rejects.toBe(reason)
    expect(sent).toEqual([{
      channel: DESKTOP_FETCH_CANCEL_CHANNEL,
      payload: { id: 'abort-fetch' },
    }])
    answer?.({
      t: 'fetch-res',
      id: 'abort-fetch',
      status: 200,
      statusText: 'OK',
      headers: {},
      body: 'late',
    })

    const preAborted = new AbortController()
    preAborted.abort(reason)
    await expect(transport.fetch(new URL('dsh-desktop://app/api/unused'), { signal: preAborted.signal }))
      .rejects.toBe(reason)

    const invalid = createDesktopTransport({
      invoke: async () => ({
        t: 'fetch-res',
        id: 'other-fetch',
        status: 200,
        statusText: 'OK',
        headers: {},
        body: null,
      }),
      on: () => () => {},
      send: () => {},
      newId: () => DesktopIpcId('expected-fetch'),
    })
    await expect(invalid.fetch(new URL('dsh-desktop://app/api/invalid'), {}))
      .rejects.toThrow('invalid response')

    const unexpectedStream = createDesktopTransport({
      invoke: async () => ({
        t: 'fetch-res',
        id: 'unexpected-stream',
        status: 200,
        statusText: 'OK',
        headers: {},
        body: null,
        bodyStream: true,
      }),
      on: () => () => {},
      send: () => {},
      newId: () => DesktopIpcId('unexpected-stream'),
    })
    await expect(unexpectedStream.fetch(new URL('dsh-desktop://app/api/invalid-stream'), {}))
      .rejects.toThrow('invalid response')
  })

  it('accepts a signalled renderer fetch that completes before cancellation', async () => {
    const controller = new AbortController()
    const transport = createDesktopTransport({
      invoke: async () => ({
        t: 'fetch-res',
        id: 'signalled-fetch',
        status: 200,
        statusText: 'OK',
        headers: {},
        body: 'complete',
      }),
      on: () => () => {},
      send: () => {},
      newId: () => DesktopIpcId('signalled-fetch'),
    })

    expect(await (await transport.fetch(
      new URL('dsh-desktop://app/api/complete'),
      { signal: controller.signal },
    )).text()).toBe('complete')
  })

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
      openStream: async () => (async function* () {})(),
      failure: error => error,
      bootPayload: () => ({ injections: [] }),
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
      t: 'fetch-res',
      id: payload.id,
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
    await disposer()
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
      openStream: async (endpoint, payload) => (async function* () {
        opened.push({ endpoint, payload })
        yield { type: 'ready' }
        yield { type: 'emit', event: 'tick' }
      })(),
      failure: error => ({ message: String(error) }),
      bootPayload: () => ({ injections: [] }),
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
      const streamListeners = new Set<(event: unknown) => void>()
      const record = (channel: string, payload: unknown): void => {
        const list = sent.get(channel) ?? []
        list.push(payload)
        sent.set(channel, list)
      }
      const rpc: PreloadRpc = {
        invoke: (channel, payload) => {
          record(channel, payload)
          const request = payload as { id: ReturnType<typeof DesktopIpcId>; endpoint: string; payload: unknown }
          for (const deliver of [...toHost]) deliver({ t: 'open-stream', id: request.id, endpoint: request.endpoint, payload: request.payload })
          return Promise.resolve('ok')
        },
        on: (_channel, listener) => {
          streamListeners.add(listener)
          return () => { streamListeners.delete(listener) }
        },
        send: (channel, payload) => {
          record(channel, payload)
          const request = payload as { id: ReturnType<typeof DesktopIpcId> }
          for (const deliver of [...toHost]) deliver({ t: 'stream-cancel', id: request.id })
        },
        newId: () => DesktopIpcId(`stream-${String(sent.size)}`),
      }
      const deliverHostFrames = (): void => {
        for (const message of fromHost.splice(0)) {
          if (message.t === 'stream-item'
            || message.t === 'stream-end'
            || message.t === 'stream-error') {
            for (const listener of [...streamListeners]) listener(message)
          }
        }
      }

      const transport = createDesktopTransport(rpc)
      const controller = new AbortController()
      const iterator = transport.openStream?.('$events', { args: {} }, controller.signal)
      expect(iterator).toBeDefined()
      const read = (async () => {
        const items: unknown[] = []
        for await (const item of iterator) items.push(item)
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
      await disposeHost()
    }
  })

  it('settles a renderer stream after cancellation without sending a duplicate cancel', async () => {
    const sent: { channel: string; payload: unknown }[] = []
    const transport = createDesktopTransport({
      invoke: async () => 'ok',
      on: () => () => {},
      send: (channel, payload) => { sent.push({ channel, payload }) },
      newId: () => DesktopIpcId('cancelled-stream'),
    })
    const controller = new AbortController()
    const iterator = transport.openStream('$events', { args: {} }, controller.signal)[Symbol.asyncIterator]()
    const read = iterator.next()
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    controller.abort()

    await expect(read).resolves.toEqual({ done: true, value: undefined })
    expect(sent).toEqual([{
      channel: DESKTOP_STREAM_CANCEL_CHANNEL,
      payload: { id: 'cancelled-stream' },
    }])
  })

  it('settles cancellation while the stream-open acknowledgement is pending', async () => {
    const sent: { channel: string; payload: unknown }[] = []
    let listener: ((event: unknown) => void) | undefined
    const transport = createDesktopTransport({
      invoke: async () => new Promise(() => {}),
      on: (_channel, next) => {
        listener = next
        return () => { listener = undefined }
      },
      send: (channel, payload) => { sent.push({ channel, payload }) },
      newId: () => DesktopIpcId('pending-stream'),
    })
    const controller = new AbortController()
    const read = transport.openStream('$events', {}, controller.signal)[Symbol.asyncIterator]().next()
    await vi.waitFor(() => { expect(listener).toBeDefined() })

    controller.abort()
    listener?.({ t: 'stream-item', id: 'pending-stream', value: 'late' })

    await expect(read).resolves.toEqual({ done: true, value: undefined })
    expect(sent).toEqual([{
      channel: DESKTOP_STREAM_CANCEL_CHANNEL,
      payload: { id: 'pending-stream' },
    }])
    expect(listener).toBeUndefined()
  })

  it('rejects pre-aborted and remotely failed renderer streams', async () => {
    const preAborted = new AbortController()
    preAborted.abort()
    const unused = createDesktopTransport({
      invoke: async () => 'unused',
      on: () => () => {},
      send: () => {},
      newId: () => DesktopIpcId('unused'),
    })
    await expect(unused.openStream('$events', {}, preAborted.signal)[Symbol.asyncIterator]().next())
      .rejects.toThrow(/abort/i)

    let listener: ((event: unknown) => void) | undefined
    const sent: unknown[] = []
    const transport = createDesktopTransport({
      invoke: async () => 'ok',
      on: (_channel, next) => {
        listener = next
        return () => { listener = undefined }
      },
      send: (_channel, payload) => { sent.push(payload) },
      newId: () => DesktopIpcId('failed-stream'),
    })
    const read = transport.openStream('$events', {}, new AbortController().signal)[Symbol.asyncIterator]().next()
    await vi.waitFor(() => { expect(listener).toBeDefined() })
    listener?.({ t: 'invalid' })
    listener?.({ t: 'stream-item', id: 'another-stream', value: 'ignored' })
    listener?.({ t: 'stream-error', id: 'failed-stream', error: { code: 'failed' } })

    await expect(read).rejects.toThrow('desktop stream failed')
    expect(sent).toEqual([{ id: 'failed-stream' }])
    expect(listener).toBeUndefined()

    const invalidAcknowledgement = createDesktopTransport({
      invoke: async () => 'invalid',
      on: () => () => {},
      send: () => {},
      newId: () => DesktopIpcId('invalid-ack'),
    })
    await expect(invalidAcknowledgement.openStream(
      '$events',
      {},
      new AbortController().signal,
    )[Symbol.asyncIterator]().next()).rejects.toThrow('invalid acknowledgement')
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
          push({ t: 'fetch', id: DesktopIpcId('f1'), url: 'http://127.0.0.1/plugins/??x/client.js&rev=r', method: 'GET', headers: {} })
        })
        return () => {}
      },
    }
    const dispose = serveDesktopHost(channel, {
      fetch: async () => new Response(new Uint8Array([255]), { headers: { 'content-type': 'application/javascript' } }),
      openStream: async () => (async function* () {})(),
      failure: error => error,
      bootPayload: () => ({ injections: [{ kind: 'global', name: '__DSH_BOOT__', value: { rev: 'r' } }] }),
    })
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    expect(outbound).toContainEqual({ t: 'boot-res', injections: [{ kind: 'global', name: '__DSH_BOOT__', value: { rev: 'r' } }] })
    const fetched = outbound.find(message => message.t === 'fetch-res')
    expect(fetched).toMatchObject({
      t: 'fetch-res',
      id: 'f1',
      status: 200,
      headers: { 'content-type': 'application/javascript' },
      body: null,
      bodyBase64: '/w==',
    })
    await dispose()
    expect(inbound.map(message => message.t)).toEqual(['fetch'])
  })

  it('serializes host fetch successes and failures', async () => {
    const outbound: DesktopIpcMessage[] = []
    let receive: ((message: DesktopIpcMessage) => void) | undefined
    const dispose = serveDesktopHost({
      send: (message) => { outbound.push(message) },
      onMessage: (listener) => {
        receive = listener
        return () => { receive = undefined }
      },
    }, {
      fetch: async (request) => {
        if (request.url.endsWith('/error')) throw new Error('fetch exploded')
        if (request.url.endsWith('/string-error')) throw 'string failure'
        if (request.method === 'HEAD') return new Response('not sent')
        if (request.url.endsWith('/replacement')) {
          return new Response(new Uint8Array([0xef, 0xbf, 0xbd]))
        }
        expect(await request.text()).toBe('request body')
        return new Response('text response', { status: 201, headers: { 'x-result': 'yes' } })
      },
      openStream: async () => (async function* () {})(),
      failure: error => error,
      bootPayload: () => ({ injections: [] }),
    })

    receive?.({
      t: 'fetch',
      id: DesktopIpcId('text'),
      url: 'http://127.0.0.1/text',
      method: 'POST',
      headers: {},
      body: 'request body',
    })
    receive?.({ t: 'fetch', id: DesktopIpcId('replacement'), url: 'http://127.0.0.1/replacement', method: 'GET', headers: {} })
    receive?.({ t: 'fetch', id: DesktopIpcId('head'), url: 'http://127.0.0.1/head', method: 'HEAD', headers: {} })
    receive?.({ t: 'fetch', id: DesktopIpcId('error'), url: 'http://127.0.0.1/error', method: 'GET', headers: {} })
    receive?.({ t: 'fetch', id: DesktopIpcId('string-error'), url: 'http://127.0.0.1/string-error', method: 'GET', headers: {} })
    receive?.({ t: 'stream-end', id: DesktopIpcId('echo') })
    await vi.waitFor(() => {
      expect(outbound.filter(message => message.t === 'fetch-res')).toHaveLength(5)
    })

    expect(outbound).toContainEqual({
      t: 'fetch-res',
      id: 'text',
      status: 201,
      statusText: '',
      headers: { 'content-type': 'text/plain;charset=UTF-8', 'x-result': 'yes' },
      body: 'text response',
    })
    expect(outbound).toContainEqual(expect.objectContaining({
      t: 'fetch-res', id: 'replacement', body: null, bodyBase64: '77+9',
    }))
    expect(outbound).toContainEqual(expect.objectContaining({
      t: 'fetch-res', id: 'head', body: null,
    }))
    expect(outbound).toContainEqual(expect.objectContaining({
      t: 'fetch-res', id: 'error', status: 500, body: 'fetch exploded',
    }))
    expect(outbound).toContainEqual(expect.objectContaining({
      t: 'fetch-res', id: 'string-error', status: 500, body: 'string failure',
    }))
    await dispose()
    expect(receive).toBeUndefined()
  })

  it('pulls streamed host response bodies with bounded binary frames', async () => {
    const outbound: DesktopIpcMessage[] = []
    let receive: ((message: DesktopIpcMessage) => void) | undefined
    const dispose = serveDesktopHost({
      send: (message) => { outbound.push(message) },
      onMessage: (listener) => {
        receive = listener
        return () => { receive = undefined }
      },
    }, {
      fetch: async (request) => {
        if (request.url.endsWith('/empty')) return new Response(null, { status: 204 })
        if (request.url.endsWith('/head')) return new Response('not sent')
        if (request.url.endsWith('/wait-body')) return new Response(new ReadableStream())
        if (request.url.endsWith('/broken-error') || request.url.endsWith('/broken-string')) {
          return new Response(new ReadableStream({
            pull(controller) {
              controller.error(request.url.endsWith('/broken-error')
                ? new Error('body exploded')
                : 'body string failure')
            },
          }))
        }
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([0, 255]))
            controller.enqueue(new Uint8Array([1]))
            controller.close()
          },
        }), { headers: { 'content-type': 'application/zip' } })
      },
      openStream: async () => (async function* () {})(),
      failure: error => error,
      bootPayload: () => ({ injections: [] }),
    })

    receive?.({
      t: 'fetch', id: DesktopIpcId('archive'), url: 'http://127.0.0.1/archive',
      method: 'GET', headers: {}, streamBody: true,
    })
    await vi.waitFor(() => {
      expect(outbound).toContainEqual(expect.objectContaining({
        t: 'fetch-res', id: 'archive', body: null, bodyStream: true,
      }))
    })
    expect(outbound.some(message => message.t === 'fetch-chunk')).toBe(false)

    receive?.({ t: 'fetch-pull', id: DesktopIpcId('archive') })
    receive?.({ t: 'fetch-pull', id: DesktopIpcId('archive') })
    await vi.waitFor(() => {
      expect(outbound).toContainEqual({ t: 'fetch-chunk', id: 'archive', bodyBase64: 'AP8=' })
    })
    expect(outbound.filter(message => message.t === 'fetch-chunk')).toHaveLength(1)
    receive?.({ t: 'fetch-pull', id: DesktopIpcId('archive') })
    await vi.waitFor(() => {
      expect(outbound).toContainEqual({ t: 'fetch-chunk', id: 'archive', bodyBase64: 'AQ==' })
    })
    receive?.({ t: 'fetch-pull', id: DesktopIpcId('archive') })
    await vi.waitFor(() => {
      expect(outbound).toContainEqual({ t: 'fetch-end', id: 'archive' })
    })

    receive?.({
      t: 'fetch', id: DesktopIpcId('empty'), url: 'http://127.0.0.1/empty',
      method: 'GET', headers: {}, streamBody: true,
    })
    receive?.({
      t: 'fetch', id: DesktopIpcId('head'), url: 'http://127.0.0.1/head',
      method: 'HEAD', headers: {}, streamBody: true,
    })
    await vi.waitFor(() => {
      expect(outbound).toContainEqual(expect.objectContaining({
        t: 'fetch-res', id: 'empty', status: 204, body: null,
      }))
      expect(outbound).toContainEqual(expect.objectContaining({
        t: 'fetch-res', id: 'head', body: null,
      }))
    })

    for (const id of ['broken-error', 'broken-string']) {
      receive?.({
        t: 'fetch', id: DesktopIpcId(id), url: `http://127.0.0.1/${id}`,
        method: 'GET', headers: {}, streamBody: true,
      })
      await vi.waitFor(() => {
        expect(outbound).toContainEqual(expect.objectContaining({
          t: 'fetch-res', id, bodyStream: true,
        }))
      })
      receive?.({ t: 'fetch-pull', id: DesktopIpcId(id) })
    }
    await vi.waitFor(() => {
      expect(outbound).toContainEqual({ t: 'fetch-error', id: 'broken-error', error: 'body exploded' })
      expect(outbound).toContainEqual({ t: 'fetch-error', id: 'broken-string', error: 'body string failure' })
    })

    receive?.({
      t: 'fetch', id: DesktopIpcId('wait-body'), url: 'http://127.0.0.1/wait-body',
      method: 'GET', headers: {}, streamBody: true,
    })
    await vi.waitFor(() => {
      expect(outbound).toContainEqual(expect.objectContaining({
        t: 'fetch-res', id: 'wait-body', bodyStream: true,
      }))
    })
    receive?.({ t: 'fetch-pull', id: DesktopIpcId('wait-body') })
    receive?.({ t: 'fetch-cancel', id: DesktopIpcId('wait-body') })
    receive?.({ t: 'fetch-pull', id: DesktopIpcId('wait-body') })

    receive?.({ t: 'fetch-pull', id: DesktopIpcId('missing') })
    await dispose()
    expect(receive).toBeUndefined()
  })

  it('contains response serialization and closed-channel failures', async () => {
    const outbound: DesktopIpcMessage[] = []
    let receive: ((message: DesktopIpcMessage) => void) | undefined
    let bodyReadStarted = false
    let bodyCancelled = false
    let rejectBodyCancellation: ((error: Error) => void) | undefined
    let calls = 0
    const dispose = serveDesktopHost({
      send: (message) => {
        calls += 1
        if (calls > 2) throw new Error('channel closed')
        outbound.push(message)
      },
      onMessage: (listener) => {
        receive = listener
        return () => { receive = undefined }
      },
    }, {
      fetch: async (request) => {
        if (request.url.endsWith('/abort')) {
          return new Response(new ReadableStream({
            start() { bodyReadStarted = true },
            cancel() {
              bodyCancelled = true
              return new Promise<void>((_resolve, reject) => { rejectBodyCancellation = reject })
            },
          }))
        }
        return new Response(new ReadableStream({
          pull(controller) {
            controller.error(request.url.endsWith('/error') ? new Error('read failed') : 'read string failure')
          },
        }))
      },
      openStream: async () => (async function* () {})(),
      failure: error => error,
      bootPayload: () => ({ injections: [] }),
    })

    receive?.({ t: 'fetch', id: DesktopIpcId('read-error'), url: 'http://127.0.0.1/error', method: 'GET', headers: {} })
    receive?.({ t: 'fetch', id: DesktopIpcId('read-string'), url: 'http://127.0.0.1/string', method: 'GET', headers: {} })
    await vi.waitFor(() => {
      expect(outbound).toContainEqual(expect.objectContaining({
        t: 'fetch-res', id: 'read-error', status: 500, body: 'read failed',
      }))
    })
    receive?.({ t: 'fetch', id: DesktopIpcId('aborted-read'), url: 'http://127.0.0.1/abort', method: 'GET', headers: {} })
    await vi.waitFor(() => { expect(bodyReadStarted).toBe(true) })
    const disposal = dispose()
    await vi.waitFor(() => { expect(bodyCancelled).toBe(true) })
    let disposed = false
    void disposal.then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    rejectBodyCancellation?.(new Error('cancel cleanup failed'))
    await disposal
    expect(disposed).toBe(true)
    expect(receive).toBeUndefined()
  })

  it('cancels response bodies that arrive after bridge disposal', async () => {
    let receive: ((message: DesktopIpcMessage) => void) | undefined
    const resolveResponses: Array<(response: Response) => void> = []
    let bodyCancelled = false
    const dispose = serveDesktopHost({
      send: () => {},
      onMessage: (listener) => {
        receive = listener
        return () => { receive = undefined }
      },
    }, {
      fetch: () => new Promise<Response>((resolve) => { resolveResponses.push(resolve) }),
      openStream: async () => (async function* () {})(),
      failure: error => error,
      bootPayload: () => ({ injections: [] }),
    })

    receive?.({ t: 'fetch', id: DesktopIpcId('late-body'), url: 'http://127.0.0.1/late-body', method: 'GET', headers: {} })
    receive?.({ t: 'fetch', id: DesktopIpcId('late-empty'), url: 'http://127.0.0.1/late-empty', method: 'GET', headers: {} })
    await vi.waitFor(() => { expect(resolveResponses).toHaveLength(2) })
    const disposal = dispose()
    resolveResponses[0]?.(new Response(new ReadableStream({
      cancel() { bodyCancelled = true },
    })))
    resolveResponses[1]?.(new Response(null, { status: 204 }))

    await disposal
    expect(bodyCancelled).toBe(true)
    expect(receive).toBeUndefined()
  })

  it('deduplicates, cancels, and drains host fetches', async () => {
    const outbound: DesktopIpcMessage[] = []
    let receive: ((message: DesktopIpcMessage) => void) | undefined
    const signals: AbortSignal[] = []
    let started = 0
    const dispose = serveDesktopHost({
      send: (message) => { outbound.push(message) },
      onMessage: (listener) => {
        receive = listener
        return () => { receive = undefined }
      },
    }, {
      fetch: async (request) => {
        started += 1
        signals.push(request.signal)
        return new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => {
            queueMicrotask(() => { reject(new Error('test fetch aborted')) })
          }, { once: true })
        })
      },
      openStream: async () => (async function* () {})(),
      failure: error => error,
      bootPayload: () => ({ injections: [] }),
    })

    receive?.({ t: 'fetch', id: DesktopIpcId('active-fetch'), url: 'http://127.0.0.1/api/slow', method: 'GET', headers: {} })
    receive?.({ t: 'fetch', id: DesktopIpcId('active-fetch'), url: 'http://127.0.0.1/api/duplicate', method: 'GET', headers: {} })
    await vi.waitFor(() => { expect(started).toBe(1) })
    receive?.({ t: 'fetch-cancel', id: DesktopIpcId('missing-fetch') })
    receive?.({ t: 'fetch-cancel', id: DesktopIpcId('active-fetch') })
    await vi.waitFor(() => { expect(signals[0]?.aborted).toBe(true) })
    expect(outbound.some(message => message.t === 'fetch-res')).toBe(false)

    receive?.({ t: 'fetch', id: DesktopIpcId('disposed-fetch'), url: 'http://127.0.0.1/api/slow', method: 'GET', headers: {} })
    await vi.waitFor(() => { expect(started).toBe(2) })
    const disposal = dispose()
    expect(dispose()).toBe(disposal)
    await disposal
    expect(signals[1]?.aborted).toBe(true)
    expect(receive).toBeUndefined()
  })

  it('deduplicates, cancels, fails, and disposes host streams', async () => {
    const outbound: DesktopIpcMessage[] = []
    let receive: ((message: DesktopIpcMessage) => void) | undefined
    const signals: AbortSignal[] = []
    let opens = 0
    const dispose = serveDesktopHost({
      send: (message) => { outbound.push(message) },
      onMessage: (listener) => {
        receive = listener
        return () => { receive = undefined }
      },
    }, {
      fetch: async () => new Response(),
      openStream: async (_endpoint, payload, signal) => {
        opens += 1
        signals.push(signal)
        if (payload === 'fail') throw new Error('stream exploded')
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () => new Promise<IteratorResult<unknown>>((_resolve, reject) => {
                signal.addEventListener('abort', () => {
                  reject(new Error('test stream aborted'))
                }, { once: true })
              }),
            }
          },
        }
      },
      failure: error => ({ message: String(error) }),
      bootPayload: () => ({ injections: [] }),
    })

    receive?.({ t: 'open-stream', id: DesktopIpcId('active'), endpoint: '$events', payload: 'wait' })
    receive?.({ t: 'open-stream', id: DesktopIpcId('active'), endpoint: '$events', payload: 'duplicate' })
    await vi.waitFor(() => { expect(opens).toBe(1) })
    receive?.({ t: 'stream-cancel', id: DesktopIpcId('missing') })
    receive?.({ t: 'stream-cancel', id: DesktopIpcId('active') })
    await vi.waitFor(() => { expect(signals[0]?.aborted).toBe(true) })
    expect(outbound.some(message => message.t === 'stream-error' && message.id === 'active')).toBe(false)

    receive?.({ t: 'open-stream', id: DesktopIpcId('failed'), endpoint: '$events', payload: 'fail' })
    await vi.waitFor(() => {
      expect(outbound).toContainEqual({
        t: 'stream-error',
        id: 'failed',
        error: { message: 'Error: stream exploded' },
      })
    })

    receive?.({ t: 'open-stream', id: DesktopIpcId('disposed'), endpoint: '$events', payload: 'wait' })
    await vi.waitFor(() => { expect(opens).toBe(3) })
    await dispose()
    expect(signals[2]?.aborted).toBe(true)
    expect(receive).toBeUndefined()
  })
})
