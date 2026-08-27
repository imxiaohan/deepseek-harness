/**
 * REAL-composition boot of the `desktop` profile: the Loader boots the full
 * tree from the profile's patch layers and the test asserts the surface's
 * defining facts — the HTTP carrier rows are absent, the retained rows'
 * `webServer` injection resolves to the desktop virtual service (whose port
 * read fails loud), and the `desktopRuntime` lane answers the carrier's boot
 * payload and plugin-bundle bytes.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FiberState } from '@deepseek-ai/cordis'
import { loadLayeredEnv, runProfile } from '@deepseek-ai/dsh-app-boot'
import type { Context } from '@deepseek-ai/cordis'

const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

let home: string | undefined
let ctx: Context | undefined

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-desktop-profile-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const booted = await runProfile({
      environment: loadLayeredEnv('dsh'),
      profile: 'desktop',
      installAnchor: INSTALL_ANCHOR,
      patchReload: 'frozen',
      patchFiles: [],
      args: [],
    })
    ctx = booted.ctx
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
}, 120_000)

afterAll(async () => {
  await ctx?.fiber.dispose()
  if (home !== undefined) await rm(home, { recursive: true, force: true })
})

describe('the desktop profile composition', () => {
  it('boots the tree to an active root over the desktop rows', () => {
    expect(ctx).toBeDefined()
    expect(ctx!.fiber.state).toBe(FiberState.ACTIVE)
    // The desktop row's own services are live: the carrier lane and the
    // Gateway it opens streams through.
    expect(ctx!.get('desktopRuntime')).toBeDefined()
    expect(ctx!.get('typertGateway')).toBeDefined()
    // The web-runtime service exists only behind the dropped web-runtime row;
    // its absence is the HTTP-carrier-row absence made observable.
    expect(ctx!.get('webRuntime')).toBeUndefined()
  })

  it('satisfies the retained rows with the virtual webServer', () => {
    const webServer = ctx!.get('webServer') as {
      host: string
      port: number
      collectIndexInjections(): readonly unknown[]
    } | undefined
    expect(webServer).toBeDefined()
    // The carrier's synthesized loopback authority, and the zero-port
    // surface: a port read is a carrier mismatch, not a value (the HTTP
    // WebServer would return a real port here).
    expect(webServer!.host).toBe('127.0.0.1')
    expect(() => webServer!.port).toThrow(/no port/)
    expect(Array.isArray(webServer!.collectIndexInjections())).toBe(true)
  })

  it('answers the carrier boot payload with a complete __DSH_BOOT__ graph', () => {
    const runtime = ctx!.get('desktopRuntime') as {
      bootPayload(): { injections: readonly { kind: string; name?: string }[] }
    } | undefined
    expect(runtime).toBeDefined()
    const { injections } = runtime!.bootPayload()
    const boot = injections.find(row => row.name === '__DSH_BOOT__')
    expect(boot).toBeDefined()
    // The module registry's own rows (queue script, parser preloads) ride along.
    expect(injections.length).toBeGreaterThan(1)
  })

  it('serves one roster plugin bundle through the carrier lane', () => {
    const runtime = ctx!.get('desktopRuntime') as {
      bundleBytes(pkg: string): Uint8Array
    } | undefined
    expect(runtime).toBeDefined()
    const bytes = runtime!.bundleBytes('@deepseek-ai/dsh-client-ui-theme')
    expect(bytes.length).toBeGreaterThan(0)
  })
})
