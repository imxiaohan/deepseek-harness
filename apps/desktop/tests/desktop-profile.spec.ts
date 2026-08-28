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
    for (const id of ['desktop-electron', 'modules', 'connection', 'api-remotes']) {
      const entry = [...ctx!.loader.entries()].find(candidate => candidate.options.id === id)
      expect(entry?.fiber?.state, `entry ${id}`).toBe(FiberState.ACTIVE)
    }
  })

  it('satisfies the retained rows with the virtual webServer', () => {
    const webServer = ctx!.get('webServer') as {
      host: string
      port: number
      collectIndexInjections(): readonly unknown[]
    } | undefined
    expect(webServer).toBeDefined()
    // Host-side routes use loopback URL semantics. A port read is a carrier
    // mismatch, not a value (the HTTP WebServer would return a real port).
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
    const modules = ctx!.get('clientModules') as { graph(): unknown } | undefined
    expect(modules).toBeDefined()
    expect((boot as { value?: unknown }).value).toBe(modules!.graph())
    // The module registry's own rows (queue script, parser preloads) ride along.
    expect(injections.length).toBeGreaterThan(1)
  })

  it('composes the Web browser roster and phases except for transport-owned HMR', async () => {
    const webHome = await mkdtemp(join(tmpdir(), 'dsh-desktop-web-parity-'))
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = webHome
    let webCtx: Context | undefined
    try {
      webCtx = (await runProfile({
        environment: loadLayeredEnv('dsh'),
        profile: 'web',
        installAnchor: INSTALL_ANCHOR,
        patchReload: 'frozen',
        patchFiles: [],
        args: ['--no-open'],
      })).ctx
      const graphOf = (context: Context): {
        entries: readonly { id: string; inject?: readonly string[]; immediately?: boolean; external?: readonly string[] }[]
        batches: readonly { phase: string; entries: readonly string[] }[]
      } => (context.get('clientModules') as { graph(): ReturnType<typeof graphOf> }).graph()
      const normalize = (graph: ReturnType<typeof graphOf>): unknown => {
        const phases = new Map(graph.batches.flatMap(
          batch => batch.entries.map(id => [id, batch.phase] as const),
        ))
        return graph.entries
          .filter(entry => entry.id !== '@deepseek-ai/dsh-client-hmr')
          .map(({ id, inject, immediately, external }) => ({
            id,
            phase: phases.get(id),
            ...inject === undefined ? {} : { inject },
            ...immediately === undefined ? {} : { immediately },
            ...external === undefined ? {} : { external },
          }))
          .sort((left, right) => left.id.localeCompare(right.id))
      }
      expect(normalize(graphOf(ctx!))).toEqual(normalize(graphOf(webCtx)))
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      await webCtx?.fiber.dispose()
      await rm(webHome, { recursive: true, force: true })
    }
  }, 120_000)

  it('serves the advertised startup batch through the carrier lane', async () => {
    const runtime = ctx!.get('desktopRuntime') as {
      bootPayload(): { injections: readonly { kind: string; name?: string; value?: unknown }[] }
      fetch(request: Request): Promise<Response>
    } | undefined
    expect(runtime).toBeDefined()
    const boot = runtime!.bootPayload().injections.find(row => row.name === '__DSH_BOOT__')
    const graph = boot?.value as { batches?: readonly { url?: unknown }[] } | undefined
    const url = graph?.batches?.[0]?.url
    expect(typeof url).toBe('string')
    const response = await runtime!.fetch(new Request(`http://127.0.0.1${url as string}`))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0)
  })

  it('dispatches the Session export download route through the carrier lane', async () => {
    const runtime = ctx!.get('desktopRuntime') as {
      fetch(request: Request): Promise<Response>
    } | undefined
    expect(runtime).toBeDefined()

    const response = await runtime!.fetch(new Request(
      'http://127.0.0.1/api/session.export',
      { method: 'HEAD' },
    ))
    expect(response.status).toBe(400)
    expect(await response.text()).toBe('')
  })

  it('mounts the standard preset through the Electron module-loader fallback', async () => {
    const loader = ctx!.get('loader') as { internal: unknown } | undefined
    const agents = ctx!.get('agents') as {
      create(options: {
        sessionId: string
        meta: { cwd: string }
        setup(agentCtx: Context): Promise<void>
      }): Promise<{ dispose(): Promise<void> }>
    } | undefined
    const presets = ctx!.get('agentPresets') as {
      mount(agentCtx: Context, id: string): Promise<unknown>
    } | undefined
    expect(loader).toBeDefined()
    expect(agents).toBeDefined()
    expect(presets).toBeDefined()
    const internal = loader!.internal
    loader!.internal = undefined
    let handle: { dispose(): Promise<void> } | undefined
    try {
      handle = await agents!.create({
        sessionId: 'desktop-electron-preset-fallback',
        meta: { cwd: process.cwd() },
        setup: async (agentCtx) => { await presets!.mount(agentCtx, 'standard') },
      })
    } finally {
      loader!.internal = internal
    }
    await handle?.dispose()
  })
})
