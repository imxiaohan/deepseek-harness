import { appendFileSync } from 'node:fs'

export const name = 'desktop-e2e-lifecycle'
export const inject = ['desktopRuntime']

function record(type, fields = {}) {
  const path = process.env.DSH_DESKTOP_E2E_EVENTS
  if (path === undefined) throw new Error('desktop e2e fixture has no event path')
  appendFileSync(path, `${JSON.stringify({ type, pid: process.pid, ...fields })}\n`)
}

export function apply(ctx) {
  const runtime = ctx.get('desktopRuntime')
  if (runtime === undefined) throw new Error('desktop e2e fixture has no desktopRuntime')
  ctx.effect(() => {
    const originalFetch = runtime.fetch
    const originalOpenStream = runtime.openStream
    runtime.fetch = function fixtureFetch(request) {
      const pathname = new URL(request.url).pathname
      if (pathname === '/api/__desktop_e2e_redirect') {
        return Promise.resolve(new Response(null, {
          status: 302,
          headers: { location: 'https://example.com/' },
        }))
      }
      if (pathname !== '/api/__desktop_e2e_hold') {
        return originalFetch.call(this, request)
      }
      record('fetch-start')
      return new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () => {
          record('fetch-abort')
          reject(request.signal.reason)
        }, { once: true })
      })
    }
    runtime.openStream = function fixtureOpenStream(endpoint, payload, signal) {
      if (endpoint !== '__desktop_e2e_hold') {
        return originalOpenStream.call(this, endpoint, payload, signal)
      }
      record('stream-start')
      return Promise.resolve({
        async *[Symbol.asyncIterator]() {
          await new Promise((resolve) => {
            signal.addEventListener('abort', resolve, { once: true })
          })
          record('stream-abort')
          signal.throwIfAborted()
        },
      })
    }
    record('fixture-ready')
    return () => {
      record('dispose-start')
      runtime.fetch = originalFetch
      runtime.openStream = originalOpenStream
      const blockMs = Number.parseInt(process.env.DSH_DESKTOP_E2E_BLOCK_DISPOSE_MS ?? '0', 10)
      if (blockMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, blockMs)
      record('dispose-end')
    }
  })
}
