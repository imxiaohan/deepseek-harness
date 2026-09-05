/**
 * The dsh desktop shell, milestone 2: the Electron main process owns the
 * window and the IPC carrier. The booted profile tree lives in a host child
 * process (this entry's own binary under `ELECTRON_RUN_AS_NODE=1`); the main
 * process relays the preload transport onto the host's carrier lane, serves
 * the application index and plugin bundles over the privileged
 * `dsh-desktop://` scheme, and synthesizes the loopback authority used by
 * host routes. Answerable-frame notification replies are milestone 3.
 *
 * The shell owns Electron's quit ordering: `before-quit` defers the final
 * quit until the host child's profile tree has torn down.
 * @module @deepseek-ai/dsh-desktop/main
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, normalize, sep } from 'node:path'
import { inspect } from 'node:util'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  Notification,
  protocol,
  safeStorage,
  session,
} from 'electron/main'
import { PROCESS_SHUTDOWN_TIMEOUT_MS } from '@deepseek-ai/dsh-app-boot'
import {
  REMOTE_EVENT_STREAM_ENDPOINT,
  REMOTE_EVENT_STREAM_PAYLOAD,
  REMOTE_EVENT_RESULT_ENDPOINT,
} from '@deepseek-ai/dsh-api-gateway'
import { renderIndexInjections } from '@deepseek-ai/dsh-host-webserver'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import {
  CARRIER_LOOPBACK_HOST,
  DESKTOP_FETCH_CANCEL_CHANNEL,
  DESKTOP_FETCH_CHANNEL,
  DESKTOP_OPEN_STREAM_CHANNEL,
  DESKTOP_STREAM_CANCEL_CHANNEL,
  DESKTOP_STREAM_EVENT_CHANNEL,
  DesktopIpcId,
  loopbackCarrierUrl,
  parseDesktopIpcMessage,
  type DesktopFetchResponseMessage,
  type DesktopIpcMessage,
} from '@deepseek-ai/dsh-host-desktop-electron'
import { desktopNativeCopy, type DesktopFatalStage } from './locale.ts'
import { createCredentialStore, type CredentialStore } from './credential-store.ts'
import {
  DESKTOP_DEEP_LINK_SCHEME,
  extractDesktopDeepLinkArgv,
  parseDesktopDeepLink,
  type DesktopDeepLink,
} from './deep-link.ts'
import { PendingNotificationHub } from './pending-notifications.ts'
import {
  DESKTOP_WINDOW_THEME_CHANNEL,
  parseDesktopWindowThemeSource,
} from './window-theme.ts'

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

/** The OS-keychain credential store; created once the app data directory is known. */
let credentials: CredentialStore | undefined

/** The credential store, failing a native request that arrived before readiness. */
function credentialStore(): CredentialStore {
  if (credentials === undefined) {
    throw new Error('dsh desktop: the credential store is not ready yet; retry the operation')
  }
  return credentials
}

protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

/** The window the shell keeps; recreated on macOS dock activation. */
let mainWindow: BrowserWindow | undefined

/** The host child running the profile tree, from spawn until its exit. */
let host: ChildProcess | undefined

/** Streamed response-body frames the main process consumes one pull at a time. */
type FetchBodyMessage = Extract<DesktopIpcMessage, { t: 'fetch-chunk' | 'fetch-end' | 'fetch-error' }>

/** One host fetch and the main-process waiters attached to it. */
interface ActiveFetch {
  readonly rendererOwned: boolean
  readonly streamBody: boolean
  readonly signal: AbortSignal | undefined
  readonly abort: () => void
  headSettled: boolean
  responseStreams: boolean
  bodyPull: {
    resolve(value: FetchBodyMessage): void
    reject(error: Error): void
  } | undefined
  resolveHead(value: DesktopFetchResponseMessage): void
  reject(error: Error): void
}

/** Host fetches awaiting response metadata or one response-body pull. */
const fetches = new Map<DesktopIpcId, ActiveFetch>()

/** Renderer-owned Gateway streams accepted for the current document generation. */
const rendererStreams = new Set<DesktopIpcId>()

/** Grace beyond the host's own bounded profile disposal before forced termination. */
const HOST_SHUTDOWN_TIMEOUT_MS = PROCESS_SHUTDOWN_TIMEOUT_MS + 1_000

/** Forced child termination after an unanswered graceful shutdown request. */
let hostShutdownTimer: ReturnType<typeof setTimeout> | undefined

/** The rendered application index, set once the host's boot payload arrives. */
let indexHtml: string | undefined

/** The boot payload's arrival, gating the first scheme-loaded window. */
let bootResolve: (() => void) | undefined
const bootSettled = new Promise<void>((resolve) => { bootResolve = resolve })

/** Whether teardown already deferred one quit behind host disposal. */
let quitting = false

/** Nonzero exit requested by a fatal renderer condition during ordered teardown. */
let fatalExitCode: number | undefined

/** Protocol and authority of the document allowed to use the preload carrier. */
let rendererAuthority: { protocol: string; host: string } | undefined

/** Whether the current main-frame navigation has committed a trusted document. */
let rendererDocumentReady = false

/** Resolve the copy for Electron-native presentation. */
function nativeCopy(): ReturnType<typeof desktopNativeCopy> {
  return desktopNativeCopy(app.isReady() ? app.getLocale() : 'en')
}

/** Report a fatal shell condition through every surface a packaged app has. */
function reportFatal(stage: DesktopFatalStage, error?: unknown): void {
  const copy = nativeCopy()
  const detail = error === undefined
    ? undefined
    : typeof error === 'string'
      ? error
      : error instanceof Error ? error.message : inspect(error)
  const text = detail === undefined
    ? `${copy.fatalPrefix}: ${copy.fatalStages[stage]}`
    : `${copy.fatalPrefix}: ${copy.fatalStages[stage]}: ${detail}`
  console.error(text)
  if (Notification.isSupported()) new Notification({ title: copy.applicationTitle, body: text }).show()
  dialog.showErrorBox(copy.applicationTitle, text)
}

/** Tear down the host before exiting from a fatal renderer condition. */
function quitAfterFatal(): void {
  fatalExitCode = 1
  if (host === undefined) app.exit(1)
  else app.quit()
}

/** Rewrite one renderer URL onto the loopback authority the fence reads. */
function loopbackUrl(href: string): string {
  return loopbackCarrierUrl(href)
}

/** Test whether a URL belongs to the authority loaded into the application window. */
function trustedRendererUrl(href: string): boolean {
  if (rendererAuthority === undefined) return false
  try {
    const url = new URL(href)
    return url.protocol === rendererAuthority.protocol
      && url.host === rendererAuthority.host
      && url.username === ''
      && url.password === ''
  } catch {
    return false
  }
}

/** Test whether a URL belongs to the one privileged application authority. */
function trustedSchemeUrl(href: string): boolean {
  try {
    const url = new URL(href)
    return url.protocol === `${APP_SCHEME}:`
      && url.host === 'app'
      && url.username === ''
      && url.password === ''
  } catch {
    return false
  }
}

/** Admit host routes only when Chromium attributes them to the current main frame. */
function trustedSchemeInitiator(details: Electron.OnBeforeRequestListenerDetails): boolean {
  const window = mainWindow
  return !quitting
    && rendererDocumentReady
    && window !== undefined
    && !window.isDestroyed()
    && details.webContents === window.webContents
    && details.frame === window.webContents.mainFrame
    && trustedRendererUrl(details.frame.url)
}

/** The main process's entrance check for the current trusted main-frame document. */
function carrierSenderOk(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
  return !quitting
    && rendererDocumentReady
    && event.sender === mainWindow?.webContents
    && event.senderFrame !== null
    && event.senderFrame === event.sender.mainFrame
    && trustedRendererUrl(event.senderFrame.url)
}

/** Validate one renderer payload by restoring its protocol discriminator. */
function rendererMessage(
  type: 'fetch' | 'fetch-cancel' | 'open-stream' | 'stream-cancel',
  payload: unknown,
): DesktopIpcMessage | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const fields = payload as Record<string, unknown>
  if ('t' in fields) return undefined
  return parseDesktopIpcMessage({ ...fields, t: type })
}

/** Report compromised or malformed renderer traffic and start ordered teardown. */
function invalidRendererMessage(stage: DesktopFatalStage): void {
  if (quitting) return
  reportFatal(stage)
  quitAfterFatal()
}

/** Node's fetch accepts Uint8Array bodies; the ArrayBufferLike generic mismatch is a typings artifact. */
function bodyOf(bytes: Uint8Array): BodyInit {
  return bytes as unknown as BodyInit
}

/** Serve one scheme request: the rendered index, host routes, or dist assets. */
async function serveScheme(request: Request): Promise<Response> {
  const url = new URL(request.url)
  if (!trustedSchemeUrl(url.href)) return new Response('forbidden', { status: 403 })
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      await bootSettled
      if (indexHtml === undefined) return new Response('index not ready', { status: 503 })
      return new Response(indexHtml, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    }
    if (url.pathname.startsWith('/plugins/') || url.pathname.startsWith('/api/')) {
      return await hostFetch(request)
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

/** Dispatch one host-child protocol message. */
function handleHostMessage(message: DesktopIpcMessage): void {
  switch (message.t) {
    case 'boot-res': {
      const html = renderIndexInjections(
        readFileSync(join(resolveDistRoot(), 'index.html'), 'utf8'),
        message.injections,
      )
      indexHtml = html
      bootResolve?.()
      return
    }
    case 'fetch-res': {
      receiveFetchHead(message)
      return
    }
    case 'fetch-chunk':
    case 'fetch-end':
    case 'fetch-error': {
      receiveFetchBody(message)
      return
    }
    case 'stream-item':
    case 'stream-end':
    case 'stream-error': {
      if (mainEventsStream === message.id) {
        if (message.t === 'stream-item') pendingHub?.handleFrame(message.value)
        else {
          // The forwarded-event stream ended: collapse what it presented and
          // release ownership so a later boot can open a fresh generation.
          mainEventsStream = undefined
          pendingHub?.dispose()
        }
        return
      }
      if (!rendererStreams.has(message.id)) return
      if (message.t !== 'stream-item') rendererStreams.delete(message.id)
      const window = mainWindow
      if (window === undefined || window.isDestroyed() || window.webContents.isDestroyed()) return
      try {
        window.webContents.send(DESKTOP_STREAM_EVENT_CHANNEL, message)
      } catch (error) {
        if (quitting) return
        reportFatal('fatal.renderer.streamRelay', error)
        quitAfterFatal()
      }
      return
    }
    case 'native-request': {
      void answerNativeRequest(message).catch((cause: unknown) => {
        if (quitting) return
        reportFatal('fatal.host.nativeOp', cause)
        quitAfterFatal()
      })
      return
    }
    default:
      // Requests flow main→host only; an inbound request shape is a protocol
      // echo the main process ignores.
      return
  }
}

/**
 * Answer one native request: an operation's own failure (unavailable
 * encryption, an expired lease) answers as `native-error`, while a structural
 * failure of the dispatch or the answer channel is fatal (the carrier lane is
 * broken and the shell reports it through the fatal lane).
 */
async function answerNativeRequest(message: Extract<DesktopIpcMessage, { t: 'native-request' }>): Promise<void> {
  try {
    const value = await performNativeOp(message)
    await sendHostMessage({
      t: 'native-ok',
      id: message.id,
      op: message.op,
      ...value === undefined ? {} : { value },
      // The dispatch answers typed per-op values it cannot name generically;
      // the receiving side's parse re-validates the pair.
    } as Parameters<typeof sendHostMessage>[0])
  } catch (failure) {
    if (!(failure instanceof NativeOpFailure)) throw failure
    await sendHostMessage({ t: 'native-error', id: message.id, op: message.op, error: failure.message })
  }
}

/** Run one native operation's main-process half, mapping its failure text. */
async function performNativeOp(message: Extract<DesktopIpcMessage, { t: 'native-request' }>): Promise<unknown> {
  try {
    switch (message.op) {
      case 'directory-pick':
        return await pickNativeDirectory()
      case 'credential-has':
        return await credentialStore().has(message.args.ref)
      case 'credential-get':
        return await credentialStore().get(message.args.ref)
      case 'credential-set':
        return await credentialStore().set(message.args.ref, message.args.value)
      case 'credential-unset':
        return await credentialStore().unset(message.args.ref)
      case 'credential-record-status':
        return await credentialStore().recordStatus(message.args.key)
      case 'credential-record-read':
        return await credentialStore().readRecord(message.args.key)
      case 'credential-record-list':
        return await credentialStore().listRecords()
      case 'credential-record-lease':
        return await credentialStore().leaseRecord(message.args.key)
      case 'credential-record-commit':
        return await credentialStore().commitRecord(message.args.key, message.args.lease, message.args.record)
      case 'credential-record-abort':
        await credentialStore().abortLease(message.args.lease)
        return undefined
      case 'credential-record-delete':
        return await credentialStore().deleteRecord(message.args.key)
      default:
        // parseDesktopIpcMessage admits only the closed op vocabulary, so this
        // switch is exhaustive; the cast names that for the compiler without
        // re-narrowing the per-op message shape.
        return assertNeverOp(message)
    }
  } catch (failure) {
    // An operation's business failure answers the request; only a structural
    // failure of the answer channel itself is fatal (the catch in
    // answerNativeRequest's caller).
    throw new NativeOpFailure(failure instanceof Error ? failure.message : String(failure))
  }
}

/** Distinguish an operation failure's answer text from a broken dispatch. */
class NativeOpFailure extends Error {}

/** The closed-op exhaustiveness guard; the parser cannot produce its input. */
function assertNeverOp(op: never): never {
  throw new Error(`dsh desktop: unknown native op ${String(op)}`)
}

/** Show one native directory chooser and return the operator's pick. */
async function pickNativeDirectory(): Promise<string | null> {
  const window = mainWindow
  const options: Electron.OpenDialogOptions = {
    title: nativeCopy().directoryPickerTitle,
    properties: ['openDirectory', 'createDirectory'],
  }
  const result = window === undefined || window.isDestroyed() || window.webContents.isDestroyed()
    ? await dialog.showOpenDialog(options)
    : await dialog.showOpenDialog(window, options)
  return result.canceled ? null : result.filePaths[0] ?? null
}

/** Create the window over the privileged scheme (or a host-announced URL in Web-profile mode). */
function createWindow(url?: string): void {
  if (quitting) return
  const target = url ?? `${APP_SCHEME}://app/index.html`
  const targetUrl = new URL(target)
  const usesCarrier = targetUrl.protocol === `${APP_SCHEME}:`
  rendererAuthority = { protocol: targetUrl.protocol, host: targetUrl.host }
  rendererDocumentReady = false
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    title: nativeCopy().applicationTitle,
    webPreferences: usesCarrier ? {
      preload: PRELOAD_ENTRY,
      // The preload installs the carrier as a page global the connection
      // client reads by reference. Main-frame authority checks, not the
      // renderer world, control access to its IPC handlers.
      contextIsolation: false,
      sandbox: false,
    } : {},
  })
  const window = mainWindow
  window.on('closed', () => {
    cancelRendererOperations(new Error('desktop renderer window closed'))
    if (mainWindow === window) mainWindow = undefined
  })
  window.webContents.on('will-navigate', (event) => {
    if (!trustedRendererUrl(event.url)) event.preventDefault()
  })
  window.webContents.on('will-redirect', (event) => {
    if (!trustedRendererUrl(event.url)) event.preventDefault()
  })
  window.webContents.on('did-start-navigation', (event) => {
    if (event.isMainFrame && !event.isSameDocument) {
      rendererDocumentReady = false
      cancelRendererOperations(new Error('desktop renderer document changed'))
    }
  })
  window.webContents.on('did-frame-navigate', (_event, url, _status, _text, isMainFrame) => {
    if (isMainFrame) rendererDocumentReady = !quitting && trustedRendererUrl(url)
  })
  window.webContents.on('did-fail-provisional-load', (_event, _code, _description, _url, isMainFrame) => {
    if (isMainFrame) {
      rendererDocumentReady = !quitting && trustedRendererUrl(window.webContents.mainFrame.url)
    }
  })
  window.webContents.on('will-attach-webview', (event) => { event.preventDefault() })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('console-message', (details) => {
    if (details.level !== 'error') return
    console.error(`dsh desktop renderer: ${details.sourceId}:${String(details.lineNumber)}: ${details.message}`)
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    if (quitting) return
    cancelRendererOperations(new Error('desktop renderer process exited'))
    reportFatal(
      'fatal.renderer.processExited',
      nativeCopy().rendererExitDetail(details.reason, details.exitCode),
    )
    quitAfterFatal()
  })
  void window.loadURL(target).catch((error: unknown) => {
    if (quitting || window.isDestroyed()) return
    reportFatal('fatal.renderer.loadFailed', error)
    quitAfterFatal()
  })
}

/** Boot the profile in the host child and open the window once it is ready. */
function bootShell(): void {
  host = spawn(process.execPath, [HOST_ENTRY], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_DESKTOP_HOST_CHILD: '1' },
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
    if (message === undefined) {
      if (quitting) return
      reportFatal('fatal.host.invalidCarrierMessage')
      quitAfterFatal()
      return
    }
    handleHostMessage(message)
  })
  host.on('exit', (code) => {
    if (hostShutdownTimer !== undefined) clearTimeout(hostShutdownTimer)
    hostShutdownTimer = undefined
    host = undefined
    rejectFetches(new Error(`desktop host exited with code ${String(code ?? 'null')}`))
    rendererStreams.clear()
    if (quitting) {
      if (fatalExitCode === undefined) app.quit()
      else app.exit(fatalExitCode)
      return
    }
    reportFatal('fatal.host.processExited', nativeCopy().hostExitDetail(code))
    app.exit(1)
  })
  host.on('error', (error) => {
    rejectFetches(error)
    rendererStreams.clear()
    reportFatal('fatal.host.startFailed', error)
    app.exit(1)
  })
  void bootSettled.then(() => {
    if (mainWindow === undefined) createWindow()
    // The carrier is ready: drain anything the OS delivered during boot, then
    // take the cold-start link if this launch carried one.
    deepLinksDrained = true
    for (const link of pendingDeepLinks.splice(0)) {
      void dispatchDeepLink(link).catch((cause: unknown) => {
        if (quitting) return
        reportFatal('fatal.host.deepLink', cause)
        quitAfterFatal()
      })
    }
    const coldLink = extractDesktopDeepLinkArgv(process.argv)
    if (coldLink !== undefined) enqueueDeepLink(coldLink)
    openPendingNotifications()
  })
}

/** The notification answerer over the Gateway's forwarded-event stream. */
let pendingHub: PendingNotificationHub | undefined

/** The main-owned `$events` logical stream id, while the stream is open. */
let mainEventsStream: DesktopIpcId | undefined

/** Bring the application window forward. */
function focusApplicationWindow(): void {
  if (mainWindow === undefined && indexHtml !== undefined) createWindow()
  mainWindow?.focus()
}

/** Build the hub over Electron notifications and the carrier's answer RPC. */
function createPendingHub(): PendingNotificationHub {
  const copy = nativeCopy()
  return new PendingNotificationHub({
    notifier: {
      show: (spec, events) => {
        // Unsupported sessions degrade to no notifications rather than a
        // constructor failure; the window keeps answering everything.
        if (!Notification.isSupported()) {
          return { close: () => {} }
        }
        const notification = new Notification({
          title: spec.title,
          body: spec.body,
          actions: spec.actions.map(text => ({ type: 'button', text })),
        })
        notification.on('action', (_event, index) => { events.onAnswer(index) })
        notification.on('click', () => { events.onFocus() })
        notification.on('close', () => { events.onDismissed() })
        notification.show()
        return { close: () => { notification.close() } }
      },
    },
    poster: {
      post: async (result) => {
        const id = DesktopIpcId(`ntv-answer:${randomUUID()}`)
        const envelope = JSON.stringify({
          type: 'client-request',
          rpcId: `ntv-answer:${randomUUID()}`,
          method: REMOTE_EVENT_RESULT_ENDPOINT,
          // The Remote wire's one-envelope convention: the payload names its
          // single `args` field, which here carries the event result.
          payload: { args: result },
        })
        const response = await sendHostFetch(
          id,
          `http://${CARRIER_LOOPBACK_HOST}/api/${REMOTE_EVENT_RESULT_ENDPOINT}`,
          'POST',
          { 'content-type': 'application/json' },
          envelope,
        )
        return response.status
      },
    },
    logger: { warn: (text) => { console.warn(text) } },
    copy: {
      approvalTitle: copy.approvalTitle,
      allow: copy.allow,
      deny: copy.deny,
      questionTitle: copy.questionTitle,
    },
    focus: focusApplicationWindow,
  })
}

/** Open the forwarded-event stream this shell answers notifications from. */
function openPendingNotifications(): void {
  pendingHub ??= createPendingHub()
  void (async () => {
    const id = DesktopIpcId(`ntv-events:${randomUUID()}`)
    await sendHostMessage({
      t: 'open-stream',
      id,
      endpoint: REMOTE_EVENT_STREAM_ENDPOINT,
      payload: REMOTE_EVENT_STREAM_PAYLOAD,
    })
    mainEventsStream = id
  })().catch((cause: unknown) => {
    if (quitting) return
    reportFatal('fatal.host.eventStream', cause)
    quitAfterFatal()
  })
}

if (!app.requestSingleInstanceLock()) {
  console.error('dsh desktop: another instance is already running; close it before launching again')
  app.exit(1)
} else {
  // Dev builds share one Electron binary; registering the public scheme there
  // would claim every unpackaged dev app's links. Packaged builds own it.
  if (app.isPackaged) app.setAsDefaultProtocolClient(DESKTOP_DEEP_LINK_SCHEME)

  process.once('SIGINT', () => { app.quit() })
  process.once('SIGTERM', () => { app.quit() })

  // macOS delivers links before readiness; queue them for the drain below.
  app.on('open-url', (event, url) => {
    event.preventDefault()
    enqueueDeepLink(url)
  })

  app.on('second-instance', (_event, argv) => {
    const url = extractDesktopDeepLinkArgv(argv)
    if (url !== undefined) enqueueDeepLink(url)
    mainWindow?.focus()
  })

  app.on('activate', () => {
    if (!quitting && mainWindow === undefined && indexHtml !== undefined) createWindow()
  })

  app.on('window-all-closed', () => { app.quit() })

  app.on('before-quit', (event) => {
    if (!quitting) {
      quitting = true
      rendererDocumentReady = false
      cancelRendererOperations(new Error('desktop shell is shutting down'))
    }
    if (host === undefined) return
    event.preventDefault()
    if (hostShutdownTimer !== undefined) return
    requestHostShutdown(fatalExitCode === undefined ? 0 : 1)
  })

  void app.whenReady().then(() => {
    credentials = createCredentialStore({
      filename: join(app.getPath('userData'), 'credentials.json'),
      crypto: safeStorage,
    })
    session.defaultSession.webRequest.onBeforeRequest({
      urls: [`${APP_SCHEME}://app/api/*`, `${APP_SCHEME}://app/plugins/*`],
    }, (details, callback) => {
      callback({ cancel: !trustedSchemeInitiator(details) })
    })
    protocol.handle(APP_SCHEME, request => serveScheme(request))
    ipcMain.on(DESKTOP_WINDOW_THEME_CHANNEL, (event, payload) => {
      if (!carrierSenderOk(event)) return
      const source = parseDesktopWindowThemeSource(payload)
      if (source === undefined) {
        invalidRendererMessage('fatal.renderer.invalidWindowTheme')
        return
      }
      nativeTheme.themeSource = source
    })
    ipcMain.handle(DESKTOP_FETCH_CHANNEL, (event, payload) => {
      if (!carrierSenderOk(event)) throw new Error('dsh desktop: carrier rejected a foreign sender')
      const message = rendererMessage('fetch', payload)
      if (message?.t !== 'fetch') {
        invalidRendererMessage('fatal.renderer.invalidFetch')
        throw new Error('dsh desktop: invalid renderer fetch message')
      }
      return carrierFetch(message)
    })
    ipcMain.on(DESKTOP_FETCH_CANCEL_CHANNEL, (event, payload) => {
      if (!carrierSenderOk(event)) return
      const message = rendererMessage('fetch-cancel', payload)
      if (message?.t !== 'fetch-cancel') {
        invalidRendererMessage('fatal.renderer.invalidFetchCancellation')
        return
      }
      if (fetches.get(message.id)?.rendererOwned === true) {
        cancelFetch(message.id, new Error('desktop fetch cancelled'))
      }
    })
    ipcMain.handle(DESKTOP_OPEN_STREAM_CHANNEL, async (event, payload) => {
      if (!carrierSenderOk(event)) throw new Error('dsh desktop: carrier rejected a foreign sender')
      const message = rendererMessage('open-stream', payload)
      if (message?.t !== 'open-stream') {
        invalidRendererMessage('fatal.renderer.invalidStreamOpen')
        throw new Error('dsh desktop: invalid renderer stream-open message')
      }
      if (rendererStreams.has(message.id)) {
        invalidRendererMessage('fatal.renderer.invalidStreamOpen')
        throw new Error('dsh desktop: renderer reused a stream correlation id')
      }
      rendererStreams.add(message.id)
      try {
        await sendHostMessage(message)
      } catch (error) {
        rendererStreams.delete(message.id)
        throw error
      }
      return 'ok'
    })
    ipcMain.on(DESKTOP_STREAM_CANCEL_CHANNEL, (event, payload) => {
      if (!carrierSenderOk(event)) return
      const message = rendererMessage('stream-cancel', payload)
      if (message?.t !== 'stream-cancel') {
        invalidRendererMessage('fatal.renderer.invalidStreamCancellation')
        return
      }
      if (!rendererStreams.delete(message.id)) return
      void sendHostMessage(message).catch(() => {})
    })
    bootShell()
  })
}

/** Relay one renderer fetch onto the host child with the loopback authority. */
async function carrierFetch(message: Extract<DesktopIpcMessage, { t: 'fetch' }>): Promise<unknown> {
  return sendHostFetch(message.id, message.url, message.method, message.headers, message.body, {
    rendererOwned: true,
  })
}

/** Dispatch one custom-scheme plugin or API request through the host carrier. */
async function hostFetch(request: Request): Promise<Response> {
  const requestBody = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text()
  const id = DesktopIpcId(`fetch:${String(fetches.size)}:${randomUUID()}`)
  const message = await sendHostFetch(
    id,
    request.url,
    request.method,
    Object.fromEntries(request.headers.entries()),
    requestBody,
    { signal: request.signal, streamBody: true },
  )
  const responseBody: BodyInit | null = message.bodyStream === true
    ? bodyOfStream(streamHostFetch(id))
    : decodeResponseBody(message)
  return new Response(responseBody, {
    status: message.status,
    statusText: message.statusText,
    headers: message.headers,
  })
}

/** Node's fetch accepts byte streams; the shared DOM generic does not expose that union. */
function bodyOfStream(stream: ReadableStream<Uint8Array>): BodyInit {
  return stream
}

/** Decode one complete unary response body. */
function decodeResponseBody(message: DesktopFetchResponseMessage): BodyInit | null {
  return message.bodyBase64 === undefined
    ? message.body
    : bodyOf(Uint8Array.from(atob(message.bodyBase64), char => char.charCodeAt(0)))
}

/** Build a response stream whose pull requests exactly one host-process chunk. */
function streamHostFetch(id: DesktopIpcId): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const message = await pullHostFetch(id)
        if (message.t === 'fetch-chunk') {
          controller.enqueue(Uint8Array.from(atob(message.bodyBase64), char => char.charCodeAt(0)))
        } else if (message.t === 'fetch-end') {
          controller.close()
        } else {
          controller.error(new Error(`desktop host response stream failed: ${message.error}`))
        }
      } catch (error) {
        cancelFetch(id, error instanceof Error ? error : new Error(String(error)))
        controller.error(error)
      }
    },
    cancel(reason) {
      cancelFetch(id, reason instanceof Error
        ? reason
        : new Error('desktop host response stream cancelled', { cause: reason }))
    },
  })
}

/** Send one fetch request to the host child and await its response envelope. */
function sendHostFetch(
  id: DesktopIpcId,
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
  options: {
    readonly signal?: AbortSignal
    readonly streamBody?: boolean
    readonly rendererOwned?: boolean
  } = {},
): Promise<DesktopFetchResponseMessage> {
  const { signal } = options
  signal?.throwIfAborted()
  return new Promise<DesktopFetchResponseMessage>((resolve, reject) => {
    if (fetches.has(id)) {
      reject(new Error(`desktop fetch reused correlation id ${id}`))
      return
    }
    const abort = (): void => {
      cancelFetch(id, signal?.reason instanceof Error
        ? signal.reason
        : new Error('desktop fetch aborted', { cause: signal?.reason }))
    }
    const operation: ActiveFetch = {
      rendererOwned: options.rendererOwned === true,
      streamBody: options.streamBody === true,
      signal,
      abort,
      headSettled: false,
      responseStreams: false,
      bodyPull: undefined,
      resolveHead: (response: DesktopFetchResponseMessage): void => {
        if (operation.headSettled) return
        operation.headSettled = true
        operation.responseStreams = response.bodyStream === true
        resolve(response)
        if (!operation.responseStreams) releaseFetch(id, operation)
      },
      reject: (error: Error): void => {
        if (!operation.headSettled) {
          operation.headSettled = true
          reject(error)
        }
        operation.bodyPull?.reject(error)
        operation.bodyPull = undefined
        releaseFetch(id, operation)
      },
    }
    fetches.set(id, operation)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted === true) {
      abort()
      return
    }
    void sendHostMessage({
      t: 'fetch',
      id,
      url: loopbackUrl(url),
      method,
      // Host routes receive the same loopback authority they see on the Web
      // transport. Electron main-frame admission is the desktop authorization.
      headers: { ...headers, host: CARRIER_LOOPBACK_HOST },
      ...body === undefined ? {} : { body },
      ...options.streamBody === true ? { streamBody: true } : {},
    }).catch((error: unknown) => {
      operation.reject(error instanceof Error ? error : new Error(String(error)))
    })
  })
}

/** Resolve one response head from the host child. */
function receiveFetchHead(message: DesktopFetchResponseMessage): void {
  const operation = fetches.get(message.id)
  if (operation === undefined) return
  if (operation.headSettled || message.bodyStream === true && !operation.streamBody) {
    operation.reject(new Error('desktop host sent an unexpected fetch response head'))
    return
  }
  operation.resolveHead(message)
}

/** Resolve one pull of a streamed response body. */
function receiveFetchBody(message: FetchBodyMessage): void {
  const operation = fetches.get(message.id)
  if (operation === undefined) return
  const pull = operation.bodyPull
  if (pull === undefined) {
    operation.reject(new Error('desktop host sent an unrequested fetch body frame'))
    return
  }
  operation.bodyPull = undefined
  if (message.t !== 'fetch-chunk') releaseFetch(message.id, operation)
  pull.resolve(message)
}

/** Ask the host child for one response-body chunk. */
function pullHostFetch(id: DesktopIpcId): Promise<FetchBodyMessage> {
  return new Promise<FetchBodyMessage>((resolve, reject) => {
    const operation = fetches.get(id)
    if (operation === undefined || !operation.responseStreams) {
      reject(new Error('desktop fetch response stream is unavailable'))
      return
    }
    if (operation.bodyPull !== undefined) {
      reject(new Error('desktop fetch response already has an active pull'))
      return
    }
    operation.bodyPull = { resolve, reject }
    void sendHostMessage({ t: 'fetch-pull', id }).catch((error: unknown) => {
      operation.reject(error instanceof Error ? error : new Error(String(error)))
    })
  })
}

/** Cancel one fetch operation and release every main-process waiter. */
function cancelFetch(id: DesktopIpcId, error: Error): void {
  const operation = fetches.get(id)
  if (operation === undefined) return
  operation.reject(error)
  void sendHostMessage({ t: 'fetch-cancel', id }).catch(() => {})
}

/** Remove one fetch operation and its request-signal listener. */
function releaseFetch(
  id: DesktopIpcId,
  operation: ActiveFetch,
): void {
  if (fetches.get(id) !== operation) return
  fetches.delete(id)
  operation.signal?.removeEventListener('abort', operation.abort)
}

/** Cancel the requests and streams owned by the renderer's outgoing document. */
function cancelRendererOperations(error: Error): void {
  for (const [id, operation] of [...fetches]) {
    if (operation.rendererOwned) cancelFetch(id, error)
  }
  for (const id of [...rendererStreams]) {
    rendererStreams.delete(id)
    void sendHostMessage({ t: 'stream-cancel', id }).catch(() => {})
  }
}

/** Send one validated protocol message while the host IPC channel is live. */
function sendHostMessage(message: DesktopIpcMessage): Promise<void> {
  const child = host
  if (child === undefined || !child.connected) {
    return Promise.reject(new Error('dsh desktop: host process IPC channel is unavailable'))
  }
  return new Promise<void>((resolve, reject) => {
    try {
      child.send(message, (error) => {
        if (error === null) resolve()
        else reject(error)
      })
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

/** Reject every fetch round trip whose host response can no longer arrive. */
function rejectFetches(error: Error): void {
  for (const operation of [...fetches.values()]) operation.reject(error)
}

/** Ask the host to dispose its profile, then force termination after the grace period. */
function requestHostShutdown(code: 0 | 1): void {
  const child = host
  if (child === undefined) return
  hostShutdownTimer = setTimeout(() => {
    if (host === child) child.kill('SIGKILL')
  }, HOST_SHUTDOWN_TIMEOUT_MS)
  void sendHostMessage({ t: 'shutdown', code }).catch(() => {
    if (host === child) child.kill('SIGKILL')
  })
}

/** Deep links accepted before the carrier is ready, drained once it is. */
const pendingDeepLinks: DesktopDeepLink[] = []
let deepLinksDrained = false

/**
 * Route one delivered link: complete validation happens here — malformed,
 * unsupported, and cross-authority input is refused before any command or
 * host API sees it — and the accepted intent queues until the carrier is up.
 */
function enqueueDeepLink(url: string): void {
  const link = parseDesktopDeepLink(url)
  if (link === undefined) {
    console.warn(`dsh desktop: ignored a malformed or cross-authority deep link: ${url.slice(0, 200)}`)
    return
  }
  if (deepLinksDrained) {
    void dispatchDeepLink(link).catch((cause: unknown) => {
      if (quitting) return
      reportFatal('fatal.host.deepLink', cause)
      quitAfterFatal()
    })
    return
  }
  pendingDeepLinks.push(link)
}

/** Focus the window and route the accepted operation through the existing application API. */
async function dispatchDeepLink(link: DesktopDeepLink): Promise<void> {
  if (mainWindow === undefined && indexHtml !== undefined) createWindow()
  mainWindow?.focus()
  const id = DesktopIpcId(`deep-link:${randomUUID()}`)
  const envelope = JSON.stringify({
    type: 'client-request',
    rpcId: `deep-link:${randomUUID()}`,
    method: 'workspace/create',
    // The Remote wire's one-envelope convention: the payload names its
    // arguments under exactly one `args` field (the same shape the
    // forwarded-event stream opens with).
    payload: { args: { request: { path: link.path } } },
  })
  const response: DesktopFetchResponseMessage = await sendHostFetch(
    id,
    `http://${CARRIER_LOOPBACK_HOST}/api/workspace/create`,
    'POST',
    { 'content-type': 'application/json' },
    envelope,
  )
  // A refused operation (a path that no longer exists, a locked registry) is
  // a diagnostic, not a shell failure; the window is already in front.
  if (response.status !== 200) {
    console.error(`dsh desktop: deep link dispatch answered ${String(response.status)}`)
  }
}
