import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import {
  apply,
  DesktopRuntime,
  VirtualWebServer,
} from '../src/index.ts'

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

function context(): Context {
  ctx = new Context()
  return ctx
}

describe('DesktopRuntime', () => {
  it('mounts both desktop services', () => {
    const current = context()
    apply(current)

    expect(current.get('webServer')).toBeInstanceOf(VirtualWebServer)
    expect(current.get('desktopRuntime')).toBeInstanceOf(DesktopRuntime)
  })

  it('resolves and caches the shared API fetch handler', async () => {
    const current = context()
    const runtime = new DesktopRuntime(current)
    expect(() => runtime.handler()).toThrow('no connection service')

    const lane = { fetch: async () => new Response('api') }
    let created = 0
    current.provide('connection', {
      createSharedFetchHandler: () => {
        created += 1
        return lane
      },
    })

    expect(runtime.handler()).toBe(lane)
    expect(runtime.handler()).toBe(lane)
    expect(created).toBe(1)
    expect(await (await runtime.fetch(new Request('http://127.0.0.1/api/x'))).text()).toBe('api')
  })

  it('dispatches plugin assets through the virtual server', async () => {
    const current = context()
    const runtime = new DesktopRuntime(current)
    expect(() => runtime.fetch(new Request('http://127.0.0.1/plugins/x.js')))
      .toThrow('no webServer service')

    const webServer = new VirtualWebServer(current)
    webServer.register({
      kind: 'exact',
      path: '/plugins',
      handler: (_request, response) => { response.end(Buffer.from('exact')) },
    })
    webServer.register({
      kind: 'prefix',
      path: '/plugins',
      handler: (_request, response) => { response.end(Buffer.from('prefix')) },
    })

    expect(await (await runtime.fetch(new Request('http://127.0.0.1/plugins'))).text()).toBe('exact')
    expect(await (await runtime.fetch(new Request('http://127.0.0.1/plugins/x.js'))).text()).toBe('prefix')
  })

  it('opens Gateway streams and maps failures', async () => {
    const current = context()
    const runtime = new DesktopRuntime(current)
    const signal = new AbortController().signal
    expect(() => runtime.openStream('$events', {}, signal)).toThrow('no typertGateway service')
    expect(() => runtime.failure(new Error('failed'))).toThrow('no typertGateway service')

    const source = (async function* () { yield 'item' })()
    const failure = { code: 'mapped' }
    current.provide('typertGateway', {
      wireStream: {
        open: async () => source,
        failure: () => failure,
      },
    })

    expect(await runtime.openStream('$events', {}, signal)).toBe(source)
    expect(runtime.failure(new Error('failed'))).toBe(failure)
  })

  it('collects the virtual server boot payload', () => {
    const current = context()
    const runtime = new DesktopRuntime(current)
    expect(() => runtime.bootPayload()).toThrow('no webServer service')

    new VirtualWebServer(current)
    current.on('webserver/index-inject', (table) => {
      table.push({ kind: 'global', name: '__BOOT__', value: { ready: true } })
    })

    expect(runtime.bootPayload()).toEqual({
      injections: [{ kind: 'global', name: '__BOOT__', value: { ready: true } }],
    })
  })

  it('routes a native operation through the host-child IPC channel', async () => {
    const current = context()
    const runtime = new DesktopRuntime(current)
    const previousEnv = process.env.DSH_DESKTOP_HOST_CHILD
    const previousSend = process.send?.bind(process)
    const sent: unknown[] = []
    process.env.DSH_DESKTOP_HOST_CHILD = '1'
    Object.defineProperty(process, 'send', {
      value: (message: unknown) => {
        sent.push(message)
        return true
      },
      writable: true,
      configurable: true,
    })
    const emitInbound = (value: unknown): void => {
      void (process.emit as unknown as (event: string, payload: unknown) => unknown)('message', value)
    }
    try {
      const waited = runtime.nativeRequest('directory-pick', undefined, new AbortController().signal)
      await new Promise(resolve => setImmediate(resolve))
      const request = sent[0] as { t: string; id: string }
      expect(request.t).toBe('native-request')
      emitInbound({ t: 'native-ok', id: request.id, op: 'directory-pick', value: '/chosen' })
      await expect(waited).resolves.toBe('/chosen')
    } finally {
      if (previousEnv === undefined) delete process.env.DSH_DESKTOP_HOST_CHILD
      else process.env.DSH_DESKTOP_HOST_CHILD = previousEnv
      Object.defineProperty(process, 'send', { value: previousSend, writable: true, configurable: true })
    }
  })

  it('fails loud outside the desktop host child', async () => {
    const current = context()
    const runtime = new DesktopRuntime(current)
    const previousEnv = process.env.DSH_DESKTOP_HOST_CHILD
    delete process.env.DSH_DESKTOP_HOST_CHILD
    try {
      expect(() => runtime.nativeRequest('directory-pick', undefined, new AbortController().signal))
        .toThrow('no native host lane is bound')
    } finally {
      if (previousEnv !== undefined) process.env.DSH_DESKTOP_HOST_CHILD = previousEnv
    }
  })
})
