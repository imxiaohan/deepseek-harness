/**
 * The dsh desktop shell, milestone 1: the Electron main process owns the
 * window, tray-level lifetime, and quit ordering, while the booted profile
 * tree lives in a host child process — this entry's own binary running under
 * `ELECTRON_RUN_AS_NODE=1`, because the vendored Cordis Loader's plugin
 * imports depend on Node's internal ESM loader, which the Electron main
 * process does not provide. The IPC carrier, the custom scheme, and the
 * zero-port surface are milestone 2; answerable-frame notification replies
 * are milestone 3.
 *
 * The shell owns Electron's quit ordering: `before-quit` defers the final
 * quit until the host child's profile tree has torn down.
 * @module @deepseek-ai/dsh-desktop/main
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, Notification } from 'electron'
import { HOST_URL_PREFIX } from './app-url.ts'

/** The host entry beside this file; both ship as sibling bundles under `lib/`. */
const HOST_ENTRY = fileURLToPath(new URL('./host.js', import.meta.url))

/** The window the shell keeps; recreated on macOS dock activation. */
let mainWindow: BrowserWindow | undefined

/** The host child running the profile tree, from spawn until its exit. */
let host: ChildProcess | undefined

/** The host-announced application URL; the activation path recreates windows from it. */
let appUrl: string | undefined

/** Whether teardown already deferred one quit behind host disposal. */
let quitting = false

/** Report a fatal shell condition through every surface a packaged app has. */
function reportFatal(stage: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  const text = `dsh desktop: ${stage}: ${message}`
  console.error(text)
  // A packaged app has no console: the notification validates milestone 1's
  // system-notification emission on a real user-visible path.
  if (Notification.isSupported()) new Notification({ title: 'DeepSeek Harness', body: text }).show()
  dialog.showErrorBox('DeepSeek Harness', text)
}

/** Create the window over the host-announced application URL. */
function createWindow(url: string): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'DeepSeek Harness',
  })
  mainWindow.on('closed', () => { mainWindow = undefined })
  void mainWindow.loadURL(url)
}

/** Boot the profile in the host child and open the window once it announces its URL. */
function bootShell(): void {
  host = spawn(process.execPath, [HOST_ENTRY], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  let announced = ''
  host.stdout?.setEncoding('utf8')
  host.stdout?.on('data', (chunk: string) => {
    // The host's output (boot diagnostics, the URL line) stays visible in
    // terminal and packaged-app logs; the shell only parses on top.
    process.stdout.write(chunk)
    if (appUrl !== undefined) return
    announced += chunk
    const line = announced.split('\n').find(candidate => candidate.startsWith(HOST_URL_PREFIX))
    if (line === undefined) return
    appUrl = line.slice(HOST_URL_PREFIX.length).trim()
    createWindow(appUrl)
  })
  host.on('exit', (code) => {
    host = undefined
    if (quitting) {
      app.quit()
      return
    }
    // The host exits before announcing (boot failure) or mid-session: either
    // way the window has nothing left to serve.
    reportFatal('host process exited', new Error(`exit code ${String(code ?? 'null')}; see the console output above`))
    app.exit(1)
  })
  host.on('error', (error) => {
    reportFatal('host process failed to start', error)
    app.exit(1)
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => { mainWindow?.focus() })

  app.on('activate', () => {
    // macOS recreates the window on dock activation; the host keeps running.
    if (mainWindow === undefined && appUrl !== undefined) createWindow(appUrl)
  })

  app.on('window-all-closed', () => { app.quit() })

  app.on('before-quit', (event) => {
    if (quitting || host === undefined) return
    quitting = true
    event.preventDefault()
    // The shell owns quit ordering: SIGTERM runs the profile tree's bounded
    // shutdown inside the host child; its exit event takes the real quit.
    host.kill('SIGTERM')
  })

  void app.whenReady().then(() => { bootShell() })
}
