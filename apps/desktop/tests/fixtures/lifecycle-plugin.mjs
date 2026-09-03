import { appendFileSync } from 'node:fs'
import { existsSync } from 'node:fs'

export const name = 'desktop-e2e-lifecycle'
export const inject = ['desktopRuntime']

function record(type, fields = {}) {
  const path = process.env.DSH_DESKTOP_E2E_EVENTS
  if (path === undefined) throw new Error('desktop e2e fixture has no event path')
  appendFileSync(path, `${JSON.stringify({ type, pid: process.pid, ...fields })}\n`)
}

/** Invoke one native directory pick through the desktopRuntime lane and record its outcome. */
function runNativePickProbe(ctx) {
  const runtime = ctx.get('desktopRuntime')
  if (runtime === undefined) throw new Error('desktop e2e fixture has no desktopRuntime')
  if (runtime.nativeRequest === undefined) {
    record('native-pick-unavailable')
    return
  }
  void runtime.nativeRequest('directory-pick', undefined, new AbortController().signal).then((path) => {
    record('native-pick-resolved', { path })
  }, (error) => {
    record('native-pick-rejected', { detail: String(error) })
  })
}

/** Store and resolve one credential through the composed provider and record the outcomes. */
function runCredentialProbe(ctx) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) throw new Error('desktop e2e fixture has no credentials service')
  void (async () => {
    await credentials.set('DSH_E2E_KEY', 'secret-1')
    const resolved = await credentials.resolve('DSH_E2E_KEY')
    record('credential-resolved', { detail: JSON.stringify(resolved) })
    const described = await credentials.describe('DSH_E2E_KEY')
    record('credential-described', { detail: JSON.stringify(described) })
  })().catch(error => {
    record('credential-rejected', { detail: String(error) })
  })
}

export function apply(ctx) {
  const runtime = ctx.get('desktopRuntime')
  if (runtime === undefined) throw new Error('desktop e2e fixture has no desktopRuntime')
  // The main-process `dialog` stub is installed by the test after launch;
  // a boot-time probe would race it (and open a real chooser in CI). Trigger
  // the pick when the test writes a marker into this fixture's root. Interval
  // polling keeps the fixture dependency-free and the ordering deterministic.
  const triggerPath = process.env.DSH_DESKTOP_E2E_PICK_TRIGGER
  if (triggerPath !== undefined) {
    const probe = () => {
      if (existsSync(triggerPath)) {
        clearInterval(timer)
        runNativePickProbe(ctx)
      }
    }
    const timer = setInterval(probe, 50)
    probe()
  }
  const credentialTriggerPath = process.env.DSH_DESKTOP_E2E_CREDENTIAL_TRIGGER
  if (credentialTriggerPath !== undefined) {
    const probe = () => {
      if (existsSync(credentialTriggerPath)) {
        clearInterval(timer)
        runCredentialProbe(ctx)
      }
    }
    const timer = setInterval(probe, 50)
    probe()
  }
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
