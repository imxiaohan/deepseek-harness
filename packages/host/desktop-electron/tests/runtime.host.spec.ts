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
})
