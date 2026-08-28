import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { VirtualWebServer } from '../src/virtual-web-server.ts'

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

function server(): VirtualWebServer {
  ctx = new Context()
  return new VirtualWebServer(ctx)
}

describe('VirtualWebServer asset dispatch', () => {
  it('owns route, upgrade, fallback, injection, and socket-free lifecycle semantics', () => {
    const webServer = server()
    const handler = (_request: IncomingMessage, response: ServerResponse): void => { response.end() }
    const disposeExact = webServer.register({ kind: 'exact', path: '/exact', handler })
    const disposePrefix = webServer.register({ kind: 'prefix', path: '/', handler })
    expect(() => webServer.register({ kind: 'exact', path: '/exact', handler })).toThrow('duplicate exact')
    expect(() => webServer.register({ kind: 'prefix', path: '/', handler })).toThrow('duplicate prefix')
    expect(webServer.routeFor('/exact')?.kind).toBe('exact')
    expect(webServer.routeFor('/nested')?.kind).toBe('prefix')
    disposeExact()
    disposePrefix()
    expect(webServer.routeFor('/exact')).toBeUndefined()

    const upgrade = { path: '/socket', handler: () => {} } as never
    const disposeUpgrade = webServer.registerUpgrade(upgrade)
    expect(() => webServer.registerUpgrade(upgrade)).toThrow('duplicate upgrade')
    disposeUpgrade()
    const disposeReplacement = webServer.registerUpgrade(upgrade)
    disposeReplacement()

    const disposeFallback = webServer.registerFallback(handler)
    expect(webServer.fallback).toBe(handler)
    expect(() => webServer.registerFallback(handler)).toThrow('duplicate fallback')
    disposeFallback()
    expect(webServer.fallback).toBeUndefined()
    const disposeFallbackReplacement = webServer.registerFallback(handler)
    disposeFallback()
    expect(webServer.fallback).toBe(handler)
    disposeFallbackReplacement()

    ctx!.on('webserver/index-inject', (table) => {
      table.push({ kind: 'style', text: 'body {}' })
    })
    expect(webServer.collectIndexInjections()).toEqual([{ kind: 'style', text: 'body {}' }])
    expect(webServer.host).toBe('127.0.0.1')
    expect(() => webServer.port).toThrow('listens on no port')
  })

  it('preserves combo queries and returns route status, headers, and bytes', async () => {
    const webServer = server()
    webServer.register({
      kind: 'prefix',
      path: '/plugins',
      handler: (request, response) => {
        expect(request.method).toBe('GET')
        expect(request.url).toBe('/plugins/??a/client.js,b/client.js&rev=r')
        expect(request.headers.host).toBe('127.0.0.1')
        response.writeHead(201, { 'content-type': 'text/javascript' })
        response.end(Buffer.from('bundle'))
      },
    })

    const response = await webServer.fetchAsset(new Request(
      'http://127.0.0.1/plugins/??a/client.js,b/client.js&rev=r',
      { headers: { host: '127.0.0.1' } },
    ))
    expect(response.status).toBe(201)
    expect(response.headers.get('content-type')).toBe('text/javascript')
    expect(await response.text()).toBe('bundle')
  })

  it('returns no body for HEAD and 404 for an unclaimed asset', async () => {
    const webServer = server()
    webServer.register({
      kind: 'exact',
      path: '/plugins/a/client.js',
      handler: (_request: IncomingMessage, response: ServerResponse) => {
        response.writeHead(200)
        response.end(Buffer.from('ignored'))
      },
    })

    const head = await webServer.fetchAsset(new Request(
      'http://127.0.0.1/plugins/a/client.js',
      { method: 'HEAD' },
    ))
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')

    webServer.register({
      kind: 'exact',
      path: '/plugins/empty.js',
      handler: (_request, response) => { response.end() },
    })
    const empty = await webServer.fetchAsset(new Request('http://127.0.0.1/plugins/empty.js'))
    expect(empty.status).toBe(200)
    expect(await empty.text()).toBe('')

    const missing = await webServer.fetchAsset(new Request('http://127.0.0.1/plugins/missing.js'))
    expect(missing.status).toBe(404)
  })

  it('rejects when the registered route fails', async () => {
    const webServer = server()
    webServer.register({
      kind: 'exact',
      path: '/plugins/fail.js',
      handler: async () => { throw new Error('route failed') },
    })

    await expect(webServer.fetchAsset(new Request('http://127.0.0.1/plugins/fail.js')))
      .rejects.toThrow('route failed')
  })
})
