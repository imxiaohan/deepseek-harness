import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { once } from 'node:events'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { DESKTOP_FETCH_CHANNEL } from '@deepseek-ai/dsh-host-desktop-electron'

const DESKTOP_DIR = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const LIFECYCLE_PLUGIN = fileURLToPath(new URL('./fixtures/lifecycle-plugin.mjs', import.meta.url))
const LISTEN_GUARD = pathToFileURL(fileURLToPath(new URL('./fixtures/forbid-listen.mjs', import.meta.url))).href
const electronExecutable = createRequire(new URL('../package.json', import.meta.url))('electron') as string

interface FixtureEvent {
  readonly detail?: string
  readonly type: string
  readonly pid: number
}

interface RunningDesktop {
  readonly app: ElectronApplication
  readonly env: Record<string, string>
  readonly eventsPath: string
  readonly page: Page
  readonly root: string
  readonly userData: string
  readonly output: { stderr: string; stdout: string }
}

const running = new Set<RunningDesktop>()

afterEach(async () => {
  for (const fixture of [...running]) {
    running.delete(fixture)
    await fixture.app.close().catch(() => {})
    await rm(fixture.root, { recursive: true, force: true })
  }
})

/** Launch the built app with an isolated profile and a socket-listen guard in its host child. */
async function launchDesktop(options: { readonly blockDisposeMs?: number } = {}): Promise<RunningDesktop> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-electron-'))
  const home = join(root, 'home')
  const userData = join(root, 'electron')
  const eventsPath = join(root, 'events.jsonl')
  const overlay = join(root, 'desktop-e2e.patch.yml')
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(userData, { recursive: true }),
    writeFile(eventsPath, ''),
    writeFile(overlay, [
      '- insert:',
      '    - id: desktop-e2e-lifecycle',
      `      name: ${JSON.stringify(LIFECYCLE_PLUGIN)}`,
      '',
    ].join('\n')),
  ])
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  const env: Record<string, string> = {
    ...inheritedEnv,
    DSH_DESKTOP_E2E_BLOCK_DISPOSE_MS: String(options.blockDisposeMs ?? 0),
    DSH_DESKTOP_E2E_EVENTS: eventsPath,
    DSH_DESKTOP_E2E_FORBID_LISTEN: '1',
    DSH_DESKTOP_INVOCATION: JSON.stringify({ version: 0, patchFiles: [overlay], args: [] }),
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    NODE_OPTIONS: `--import=${LISTEN_GUARD}`,
  }
  const app = await electron.launch({
    executablePath: electronExecutable,
    args: ['--lang=en-US', `--user-data-dir=${userData}`, DESKTOP_DIR],
    env,
  })
  const output = { stderr: '', stdout: '' }
  app.process().stderr?.on('data', (chunk: Buffer | string) => { output.stderr += chunk.toString() })
  app.process().stdout?.on('data', (chunk: Buffer | string) => { output.stdout += chunk.toString() })
  const page = await app.firstWindow()
  await page.waitForLoadState('load')
  await page.waitForFunction(() => (
    globalThis as typeof globalThis & { __DSH_TRANSPORT__?: { ownsHost?: unknown } }
  ).__DSH_TRANSPORT__?.ownsHost === true)
  const fixture = { app, env, eventsPath, page, root, userData, output }
  running.add(fixture)
  await waitForEvent(fixture, 'fixture-ready')
  return fixture
}

/** Read complete lifecycle records written synchronously by the host fixture. */
async function fixtureEvents(fixture: RunningDesktop): Promise<FixtureEvent[]> {
  const text = await readFile(fixture.eventsPath, 'utf8')
  return text.trim() === ''
    ? []
    : text.trim().split('\n').map(line => JSON.parse(line) as FixtureEvent)
}

/** Wait until the host fixture has emitted an event the requested number of times. */
async function waitForEvent(fixture: RunningDesktop, type: string, count = 1): Promise<void> {
  await expect.poll(async () => (
    await fixtureEvents(fixture)
  ).filter(event => event.type === type).length, { timeout: 30_000 }).toBe(count)
}

/** Resolve one process's independent exit code and signal outcomes. */
async function processExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode }
  }
  const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null]
  return { code, signal }
}

/** Test whether a recorded child pid still names a live process. */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

/** Suppress blocking native failure UI while retaining stderr diagnostics and exit behavior. */
async function suppressFatalUi(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog, Notification }) => {
    dialog.showErrorBox = () => {}
    Notification.isSupported = () => false
  })
}

/** Re-deliver navigation completion after shutdown, then probe the authoritative IPC check. */
async function installShutdownFetchProbe(fixture: RunningDesktop): Promise<void> {
  await fixture.app.evaluate(({ app, BrowserWindow }, eventsPath) => {
    app.once('before-quit', () => {
      const webContents = BrowserWindow.getAllWindows()[0]?.webContents
      const fs = process.getBuiltinModule('node:fs')
      if (webContents === undefined || fs === undefined) return
      const record = (type: string, detail?: string): void => {
        fs.appendFileSync(eventsPath, `${JSON.stringify({ type, pid: process.pid, detail })}\n`)
      }
      const currentUrl = webContents.getURL()
      webContents.emit(
        'did-frame-navigate', {}, currentUrl, 200, 'OK', true, 0, 0,
      )
      webContents.emit(
        'did-fail-provisional-load', {}, -3, 'aborted', currentUrl, true,
      )
      void webContents.executeJavaScript(`
        globalThis.__DSH_TRANSPORT__.fetch(
          new URL('/api/__desktop_e2e_hold', location.href),
          { method: 'POST', body: '{}' },
        ).then(
          () => ({ accepted: true }),
          error => ({ accepted: false, detail: String(error) }),
        )
      `).then((result: unknown) => {
        if (typeof result === 'object' && result !== null && 'accepted' in result) {
          const value = result as { accepted: unknown; detail?: unknown }
          if (value.accepted === true) record('shutdown-fetch-accepted')
          else record('shutdown-fetch-rejected', typeof value.detail === 'string' ? value.detail : undefined)
          return
        }
        record('shutdown-fetch-invalid-result')
      }, (error: unknown) => {
        record(
          'shutdown-fetch-evaluation-failed',
          error instanceof Error ? error.message : typeof error === 'string' ? error : undefined,
        )
      })
    })
  }, fixture.eventsPath)
}

/** Start one held fetch and stream from the current renderer document. */
async function startHeldOperations(page: Page, addUnloadFetch = false): Promise<void> {
  await page.evaluate((onUnload) => {
    const transport = (
      globalThis as typeof globalThis & {
        __DSH_TRANSPORT__: {
          fetch(input: URL, init: RequestInit): Promise<Response>
          openStream(endpoint: string, payload: unknown, signal: AbortSignal): AsyncIterable<unknown>
        }
      }
    ).__DSH_TRANSPORT__
    const fetchController = new AbortController()
    const streamController = new AbortController()
    void transport.fetch(new URL('/api/__desktop_e2e_hold', location.href), {
      method: 'POST', body: '{}', signal: fetchController.signal,
    }).catch(() => {})
    const iterator = transport.openStream(
      '__desktop_e2e_hold', {}, streamController.signal,
    )[Symbol.asyncIterator]()
    void iterator.next().catch(() => {})
    if (onUnload) {
      addEventListener('unload', () => {
        void transport.fetch(new URL('/api/__desktop_e2e_hold', location.href), {
          method: 'POST', body: '{}',
        }).catch(() => {})
      }, { once: true })
    }
  }, addUnloadFetch)
}

describe('the built Electron desktop application', () => {
  it('projects page theme changes onto native window chrome', async () => {
    const { app, page } = await launchDesktop()
    const nativeThemeSource = async (): Promise<string> => app.evaluate(
      ({ nativeTheme }) => nativeTheme.themeSource,
    )

    await expect.poll(nativeThemeSource, { timeout: 10_000 }).toBe('system')
    const welcome = page.getByRole('dialog', { name: 'Internal Testing Notice' })
    await welcome.waitFor({ timeout: 15_000 })
    await welcome.getByRole('button', { name: 'Continue', exact: true }).click()
    await welcome.waitFor({ state: 'detached', timeout: 15_000 })
    const configureLater = page.getByRole('button', { name: 'Configure later', exact: true })
    await configureLater.waitFor({ timeout: 15_000 })
    await configureLater.click()
    await configureLater.waitFor({ state: 'detached', timeout: 15_000 })
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.getByRole('button', { name: 'Dark', exact: true }).click()
    await expect.poll(nativeThemeSource, { timeout: 5_000 }).toBe('dark')
    await dialog.getByRole('button', { name: 'System', exact: true }).click()
    await expect.poll(nativeThemeSource, { timeout: 5_000 }).toBe('system')
  })

  it('enforces authority, survives reload, rejects a second instance, and quits cleanly', async () => {
    const fixture = await launchDesktop()
    const { app, page } = fixture
    expect(page.url()).toBe('dsh-desktop://app/index.html')

    const carrierStatus = await page.evaluate(async () => {
      const transport = (
        globalThis as typeof globalThis & {
          __DSH_TRANSPORT__: { fetch(input: URL, init: RequestInit): Promise<Response> }
        }
      ).__DSH_TRANSPORT__
      const response = await transport.fetch(new URL('/api/session.export', location.href), { method: 'HEAD' })
      return response.status
    })
    expect(carrierStatus).toBe(400)

    const schemeStatus = await page.evaluate(async () => (
      await fetch('/api/session.export', { method: 'HEAD' })
    ).status)
    expect(schemeStatus).toBe(400)

    const subframeDenied = await page.evaluate(async () => {
      const frame = document.createElement('iframe')
      frame.src = '/index.html'
      document.body.append(frame)
      await new Promise<void>((resolve, reject) => {
        frame.addEventListener('load', () => { resolve() }, { once: true })
        frame.addEventListener('error', () => { reject(new Error('subframe index failed')) }, { once: true })
      })
      try {
        await frame.contentWindow!.fetch('/api/session.export', { method: 'HEAD' })
        return false
      } catch {
        return true
      } finally {
        frame.remove()
      }
    })
    expect(subframeDenied).toBe(true)

    const foreignSenderError = await app.evaluate(async ({ BrowserWindow }, channel) => {
      const foreign = new BrowserWindow({
        show: false,
        webPreferences: { contextIsolation: false, nodeIntegration: true, sandbox: false },
      })
      try {
        await foreign.loadURL('data:text/html,<title>foreign</title>')
        return await foreign.webContents.executeJavaScript(`
          require('electron').ipcRenderer.invoke(${JSON.stringify(channel)}, {
            id: 'foreign', url: 'dsh-desktop://app/api/session.export', method: 'HEAD', headers: {}
          }).then(() => 'accepted', error => String(error && error.message || error))
        `) as string
      } finally {
        foreign.destroy()
      }
    }, DESKTOP_FETCH_CHANNEL)
    expect(foreignSenderError).toContain('carrier rejected a foreign sender')

    const originalUrl = page.url()
    const deniedNavigation = await app.evaluate(({ BrowserWindow }, target) => new Promise<string>((resolve, reject) => {
      const webContents = BrowserWindow.getAllWindows()[0]?.webContents
      if (webContents === undefined) throw new Error('desktop e2e window is missing')
      webContents.once('will-navigate', (_event, url) => { resolve(url) })
      void webContents.executeJavaScript(`location.href = ${JSON.stringify(target)}`).catch(reject)
    }), 'dsh-desktop://foreign/index.html')
    expect(deniedNavigation).toBe('dsh-desktop://foreign/index.html')
    expect(page.url()).toBe(originalUrl)
    expect(await page.evaluate(() => open('dsh-desktop://app/index.html') === null)).toBe(true)
    const redirectUrl = await app.evaluate(({ BrowserWindow }, target) => new Promise<string>((resolve, reject) => {
      const webContents = BrowserWindow.getAllWindows()[0]?.webContents
      if (webContents === undefined) throw new Error('desktop e2e window is missing')
      let started = false
      const onStart = (event: Electron.Event<{
        isMainFrame: boolean
        url: string
      }>) => {
        if (event.isMainFrame && new URL(event.url).pathname === target) started = true
      }
      const onStop = () => {
        if (!started) return
        webContents.removeListener('did-start-navigation', onStart)
        webContents.removeListener('did-stop-loading', onStop)
        resolve(webContents.getURL())
      }
      webContents.on('did-start-navigation', onStart)
      webContents.on('did-stop-loading', onStop)
      void webContents.executeJavaScript(`location.href = ${JSON.stringify(target)}`).catch(reject)
    }), '/api/__desktop_e2e_redirect')
    expect(redirectUrl).not.toBe('https://example.com/')
    await page.goto(originalUrl, { waitUntil: 'load' })
    await page.waitForFunction(() => (
      globalThis as typeof globalThis & { __DSH_TRANSPORT__?: { ownsHost?: unknown } }
    ).__DSH_TRANSPORT__?.ownsHost === true)

    await startHeldOperations(page, true)
    await Promise.all([
      waitForEvent(fixture, 'fetch-start'),
      waitForEvent(fixture, 'stream-start'),
    ])
    await page.reload({ waitUntil: 'load' })
    await page.waitForFunction(() => (
      globalThis as typeof globalThis & { __DSH_TRANSPORT__?: { ownsHost?: unknown } }
    ).__DSH_TRANSPORT__?.ownsHost === true)
    await Promise.all([
      waitForEvent(fixture, 'fetch-abort'),
      waitForEvent(fixture, 'stream-abort'),
    ])
    expect((await fixtureEvents(fixture)).filter(event => event.type === 'fetch-start')).toHaveLength(1)

    const second = spawn(electronExecutable, [`--user-data-dir=${fixture.userData}`, DESKTOP_DIR], {
      env: fixture.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let secondError = ''
    second.stderr?.on('data', (chunk: Buffer | string) => { secondError += chunk.toString() })
    const secondExit = await processExit(second)
    expect(secondExit).toEqual({ code: 1, signal: null })
    expect(secondError).toContain('another instance is already running')
    expect(app.process().exitCode).toBeNull()

    const hostPid = (await fixtureEvents(fixture)).find(event => event.type === 'fixture-ready')!.pid
    const applicationProcess = app.process()
    running.delete(fixture)
    await app.close()
    expect(await processExit(applicationProcess)).toEqual({ code: 0, signal: null })
    await waitForEvent(fixture, 'dispose-end')
    expect(processIsAlive(hostPid)).toBe(false)
    await rm(fixture.root, { recursive: true, force: true })
  })

  it('treats malformed trusted-renderer IPC as fatal and drains the host', async () => {
    const fixture = await launchDesktop()
    await suppressFatalUi(fixture.app)
    const hostPid = (await fixtureEvents(fixture)).find(event => event.type === 'fixture-ready')!.pid
    const applicationProcess = fixture.app.process()
    void fixture.page.evaluate(async () => {
      const transport = (
        globalThis as typeof globalThis & {
          __DSH_TRANSPORT__: { fetch(input: unknown, init: RequestInit): Promise<Response> }
        }
      ).__DSH_TRANSPORT__
      await transport.fetch({ href: 7 }, { method: 'GET' })
    }).catch(() => {})
    expect(await processExit(applicationProcess)).toEqual({ code: 1, signal: null })
    running.delete(fixture)
    await waitForEvent(fixture, 'dispose-end')
    expect(fixture.output.stderr).toContain('renderer sent an invalid fetch message')
    expect(processIsAlive(hostPid)).toBe(false)
    await rm(fixture.root, { recursive: true, force: true })
  })

  it('cancels active work and drains the host after renderer failure', async () => {
    const fixture = await launchDesktop()
    await suppressFatalUi(fixture.app)
    await startHeldOperations(fixture.page)
    await Promise.all([
      waitForEvent(fixture, 'fetch-start'),
      waitForEvent(fixture, 'stream-start'),
    ])
    const hostPid = (await fixtureEvents(fixture)).find(event => event.type === 'fixture-ready')!.pid
    const applicationProcess = fixture.app.process()
    const cdp = await fixture.page.context().newCDPSession(fixture.page)
    void cdp.send('Page.crash').catch(() => {})
    expect(await processExit(applicationProcess)).toEqual({ code: 1, signal: null })
    running.delete(fixture)
    await Promise.all([
      waitForEvent(fixture, 'fetch-abort'),
      waitForEvent(fixture, 'stream-abort'),
      waitForEvent(fixture, 'dispose-end'),
    ])
    expect(fixture.output.stderr).toContain('renderer process exited')
    expect(fixture.output.stderr).toMatch(/renderer process exited: crashed; exit code \d+/)
    expect(processIsAlive(hostPid)).toBe(false)
    await rm(fixture.root, { recursive: true, force: true })
  })

  it.skipIf(process.platform === 'win32')('drains the host when the shell receives SIGTERM', async () => {
    const fixture = await launchDesktop()
    const hostPid = (await fixtureEvents(fixture)).find(event => event.type === 'fixture-ready')!.pid
    const applicationProcess = fixture.app.process()
    applicationProcess.kill('SIGTERM')
    const exit = await processExit(applicationProcess)
    expect(exit).toEqual({ code: 0, signal: null })
    running.delete(fixture)
    await waitForEvent(fixture, 'dispose-end')
    expect(processIsAlive(hostPid)).toBe(false)
    await rm(fixture.root, { recursive: true, force: true })
  })

  it('revokes renderer admission and force-terminates a host blocked in disposal', async () => {
    const fixture = await launchDesktop({ blockDisposeMs: 60_000 })
    await installShutdownFetchProbe(fixture)
    const hostPid = (await fixtureEvents(fixture)).find(event => event.type === 'fixture-ready')!.pid
    const applicationProcess = fixture.app.process()
    const startedAt = performance.now()
    const close = fixture.app.close()

    await waitForEvent(fixture, 'shutdown-fetch-rejected')
    await close

    expect(performance.now() - startedAt).toBeLessThan(20_000)
    expect(await processExit(applicationProcess)).toEqual({ code: 0, signal: null })
    running.delete(fixture)
    await waitForEvent(fixture, 'dispose-start')
    const events = await fixtureEvents(fixture)
    expect(events.find(event => event.type === 'shutdown-fetch-rejected')?.detail)
      .toContain('carrier rejected a foreign sender')
    expect(events.some(event => event.type === 'shutdown-fetch-accepted')).toBe(false)
    expect(events.some(event => event.type === 'fetch-start')).toBe(false)
    expect(events.some(event => event.type === 'dispose-end')).toBe(false)
    expect(processIsAlive(hostPid)).toBe(false)
    await rm(fixture.root, { recursive: true, force: true })
  })
})
