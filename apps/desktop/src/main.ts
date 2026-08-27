/**
 * The dsh desktop shell, milestone 2: the Electron main process owns the
 * window and the IPC carrier. The booted profile tree lives in a host child
 * process (this entry's own binary under `ELECTRON_RUN_AS_NODE=1`, where
 * Node's internal ESM loader is intact); the main process relays the preload
 * transport onto the host's carrier lane, serves the application index and
 * plugin bundles over the privileged `dsh-desktop://` scheme, and synthesizes
 * the loopback authority the `/api` trust fence reads. Answerable-frame
 * notification replies are milestone 3.
 *
 * The shell owns Electron's quit ordering: `before-quit` defers the final
 * quit until the host child's profile tree has torn down.
 * @module @deepseek-ai/dsh-desktop/main
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Notification,
  protocol,
} from 'electron/main'
import { renderIndexInjections, type IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import {
  CARRIER_LOOPBACK_HOST,
  DESKTOP_FETCH_CHANNEL,
  DESKTOP_OPEN_STREAM_CHANNEL,
  DESKTOP_STREAM_CANCEL_CHANNEL,
  DESKTOP_STREAM_EVENT_CHANNEL,
  loopbackCarrierUrl,
  parseDesktopIpcMessage,
  type DesktopIpcMessage,
} from '@deepseek-ai/dsh-host-desktop-electron'

/** The privileged scheme the application index and plugin bundles serve over. */
const APP_SCHEME = 'dsh-desktop'

/** The host entry beside this file; both ship as sibling bundles under `lib/`. */
const HOST_ENTRY = fileURLToPath(new URL('./host.js', import.meta.url))

/** The preload beside this file; it installs the transport before any client plugin loads. */
const PRELOAD_ENTRY = fileURLToPath(new URL('./preload.js', import.meta.url))

/** The frontend dist this installation serves; an assembly fact, never user config. */
function resolveDistRoot(): string {
  const require = createRequire(import.meta.url)
  const manifest = require.resolve('@deepseek-ai/dsh-web-frontend/package.json')
  return join(dirname(manifest), 'dist')
}

protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

/** The window the shell keeps; recreated on macOS dock activation. */
let mainWindow: BrowserWindow | undefined

/** The host child running the profile tree, from spawn until its exit. */
let host: ChildProcess | undefined

/** Renderer fetch round trips awaiting their host answer. */
const pendingFetches = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>()

/** Plugin-bundle requests awaiting their host answer. */
const pendingBundles = new Map<string, (bytes: Uint8Array) => void>()

/** Plugin-bundle bytes answered by the host, keyed by package name. */
const bundleCache = new Map<string, Uint8Array>()

/** The rendered application index, set once the host's boot payload arrives. */
let indexHtml: string | undefined

/** The boot payload's arrival, gating the first scheme-loaded window. */
let bootResolve: (() => void) | undefined
const bootSettled = new Promise<void>((resolve) => { bootResolve = resolve })

/** Whether teardown already deferred one quit behind host disposal. */
let quitting = false

/** Report a fatal shell condition through every surface a packaged app has. */
function reportFatal(stage: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  const text = `dsh desktop: ${stage}: ${message}`
  console.error(text)
  if (Notification.isSupported()) new Notification({ title: 'DeepSeek Harness', body: text }).show()
  dialog.showErrorBox('DeepSeek Harness', text)
}

/** Rewrite one renderer URL onto the loopback authority the fence reads. */
function loopbackUrl(href: string): string {
  return loopbackCarrierUrl(href)
}

/** The main process's entrance gate: only this application's renderer may ride the carrier. */
function carrierSenderOk(sender: Electron.WebContents): boolean {
  return sender === mainWindow?.webContents
}

/** Node's fetch accepts Uint8Array bodies; the ArrayBufferLike generic mismatch is a typings artifact. */
function bodyOf(bytes: Uint8Array): BodyInit {
  return bytes as unknown as BodyInit
}

/** Serve one scheme request: the rendered index, plugin bundles, or dist assets. */
async function serveScheme(request: Request): Promise<Response> {
  const url = new URL(request.url)
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      await bootSettled
      if (indexHtml === undefined) return new Response('index not ready', { status: 503 })
      return new Response(indexHtml, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    }
    if (url.pathname.startsWith('/plugins/')) {
      const segments = url.pathname.slice('/plugins/'.length).split('/')
      const pkg = decodeURIComponent(segments[0] ?? '')
      if (pkg === '') return new Response('not found', { status: 404 })
      const bytes = await pluginBundle(pkg)
      return new Response(bodyOf(bytes), {
        headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-cache' },
      })
    }
    return distAsset(url.pathname)
  } catch (error) {
    return new Response(error instanceof Error ? error.message : String(error), { status: 500 })
  }
}

/** Read one dist asset below the frontend dist root. */
function distAsset(pathname: string): Response {
  const clean = normalize(pathname).replaceAll(sep, '/')
  if (clean.startsWith('..')) return new Response('forbidden', { status: 403 })
  try {
    const bytes = readFileSync(join(resolveDistRoot(), clean))
    const type = contentTypeFor(clean)
    return new Response(bodyOf(bytes), { headers: type === undefined ? {} : { 'content-type': type } })
  } catch {
    return new Response('not found', { status: 404 })
  }
}

/** Content types the dist serving knows. */
function contentTypeFor(path: string): string | undefined {
  if (path.endsWith('.js') || path.endsWith('.mjs')) return 'text/javascript; charset=utf-8'
  if (path.endsWith('.css')) return 'text/css; charset=utf-8'
  if (path.endsWith('.html')) return 'text/html; charset=utf-8'
  if (path.endsWith('.svg')) return 'image/svg+xml'
  if (path.endsWith('.png')) return 'image/png'
  if (path.endsWith('.json')) return 'application/json; charset=utf-8'
  if (path.endsWith('.woff2')) return 'font/woff2'
  return undefined
}

/** Plugin-bundle bytes from the host, cached per package. */
async function pluginBundle(pkg: string): Promise<Uint8Array> {
  const cached = bundleCache.get(pkg)
  if (cached !== undefined) return cached
  const bytes = await new Promise<Uint8Array>((resolve, reject) => {
    const id = `bundle:${pkg}:${String(bundleCache.size)}`
    pendingBundles.set(id, resolve)
    host?.send({ t: 'bundle', id, package: pkg })
    setTimeout(() => {
      if (pendingBundles.delete(id)) reject(new Error(`plugin bundle ${pkg} timed out`))
    }, 10_000)
  })
  bundleCache.set(pkg, bytes)
  return bytes
}

/** Dispatch one host-child protocol message. */
function handleHostMessage(message: DesktopIpcMessage): void {
  switch (message.t) {
    case 'boot-res': {
      const html = renderIndexInjections(
        readFileSync(join(resolveDistRoot(), 'index.html'), 'utf8'),
        message.injections as IndexInjection[],
      )
      indexHtml = html
      bootResolve?.()
      return
    }
    case 'fetch-res': {
      pendingFetches.get(message.id)?.resolve(message)
      pendingFetches.delete(message.id)
      return
    }
    case 'bundle-res': {
      const settle = pendingBundles.get(message.id)
      pendingBundles.delete(message.id)
      settle?.(Uint8Array.from(atob(message.bytesBase64), char => char.charCodeAt(0)))
      return
    }
    case 'stream-item':
    case 'stream-end':
    case 'stream-error': {
      const event = message.t === 'stream-item'
        ? { kind: 'item', id: message.id, value: message.value }
        : message.t === 'stream-end'
          ? { kind: 'end', id: message.id }
          : { kind: 'error', id: message.id, error: message.error }
      mainWindow?.webContents.send(DESKTOP_STREAM_EVENT_CHANNEL, event)
      return
    }
    default:
      // Requests flow main→host only; an inbound request shape is a protocol
      // echo the main process ignores.
      return
  }
}

/** Create the window over the privileged scheme (or a host-announced URL in Web-profile mode). */
function createWindow(url?: string): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'DeepSeek Harness',
    webPreferences: {
      preload: PRELOAD_ENTRY,
      // The preload installs the carrier as a page global the connection
      // client reads by reference; the shell loads only first-party content
      // over the privileged scheme, and the carrier's trust line is the
      // sender gate below, not the renderer world boundary.
      contextIsolation: false,
      sandbox: false,
    },
  })
  mainWindow.on('closed', () => { mainWindow = undefined })
  void mainWindow.loadURL(url ?? `${APP_SCHEME}://app/index.html`)
}

/** Boot the profile in the host child and open the window once it is ready. */
function bootShell(): void {
  host = spawn(process.execPath, [HOST_ENTRY], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
  })
  let announced = ''
  host.stdout?.setEncoding('utf8')
  host.stdout?.on('data', (chunk: string) => {
    process.stdout.write(chunk)
    if (mainWindow !== undefined) return
    announced += chunk
    // Milestone-1 Web-profile mode announces an authenticated loopback URL
    // and loads it directly; the desktop carrier resolves through the boot
    // payload and serves the scheme instead.
    const line = announced.split('\n').find(candidate => candidate.startsWith('dsh desktop host: http'))
    if (line !== undefined) createWindow(line.slice('dsh desktop host: '.length).trim())
  })
  host.on('message', (value: unknown) => {
    const message = parseDesktopIpcMessage(value)
    if (message !== undefined) handleHostMessage(message)
  })
  host.on('exit', (code) => {
    host = undefined
    if (quitting) {
      app.quit()
      return
    }
    reportFatal('host process exited', new Error(`exit code ${String(code ?? 'null')}; see the console output above`))
    app.exit(1)
  })
  host.on('error', (error) => {
    reportFatal('host process failed to start', error)
    app.exit(1)
  })
  void bootSettled.then(() => {
    if (mainWindow === undefined) createWindow()
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => { mainWindow?.focus() })

  app.on('activate', () => {
    if (mainWindow === undefined && (indexHtml !== undefined || host !== undefined)) createWindow()
  })

  app.on('window-all-closed', () => { app.quit() })

  app.on('before-quit', (event) => {
    if (quitting || host === undefined) return
    quitting = true
    event.preventDefault()
    host.kill('SIGTERM')
  })

  void app.whenReady().then(() => {
    protocol.handle(APP_SCHEME, request => serveScheme(request))
    ipcMain.handle(DESKTOP_FETCH_CHANNEL, (event, payload) => {
      if (!carrierSenderOk(event.sender)) throw new Error('dsh desktop: carrier rejected a foreign sender')
      return carrierFetch(payload)
    })
    ipcMain.handle(DESKTOP_OPEN_STREAM_CHANNEL, (event, payload) => {
      if (!carrierSenderOk(event.sender)) throw new Error('dsh desktop: carrier rejected a foreign sender')
      const request = payload as { id: string; endpoint: string; payload: unknown }
      host?.send({ t: 'open-stream', id: request.id, endpoint: request.endpoint, payload: request.payload })
      return 'ok'
    })
    ipcMain.on(DESKTOP_STREAM_CANCEL_CHANNEL, (event, payload) => {
      if (!carrierSenderOk(event.sender)) return
      const request = payload as { id: string }
      host?.send({ t: 'stream-cancel', id: request.id })
    })
    bootShell()
  })
}

/** Relay one renderer fetch onto the host child with the loopback authority. */
async function carrierFetch(payload: unknown): Promise<unknown> {
  const request = payload as {
    url: string
    method: string
    headers: Record<string, string>
    body?: string
  }
  const id = `fetch:${String(pendingFetches.size)}:${randomUUID()}`
  return new Promise<unknown>((resolve, reject) => {
    pendingFetches.set(id, { resolve, reject })
    host?.send({
      t: 'fetch',
      id,
      url: loopbackUrl(request.url),
      method: request.method,
      // The Host/Origin fence reads the Host header: the synthesized loopback
      // authority IS the desktop carrier's loopback-equivalence decision.
      headers: { ...request.headers, host: CARRIER_LOOPBACK_HOST },
      ...request.body === undefined ? {} : { body: request.body },
    })
  })
}
