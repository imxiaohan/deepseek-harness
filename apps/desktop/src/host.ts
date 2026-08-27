/**
 * The desktop host entry: a plain-Node process that boots the desktop's
 * profile through `runProfile` and serves the IPC carrier until teardown.
 * With the `desktop` profile it bridges the composition's `desktopRuntime`
 * lane (shared fetch handler, Gateway wire streams, boot payload, plugin
 * bundles) over the process channel; with the Web profile (milestone-1
 * development mode) it falls back to announcing the authenticated URL line.
 * It deliberately imports no Electron module: the Electron main process
 * spawns this entry through the same binary under `ELECTRON_RUN_AS_NODE=1`,
 * where Node's internal module loader — which the vendored Cordis Loader's
 * plugin imports depend on — is intact.
 * @module @deepseek-ai/dsh-desktop/host
 */

import { fileURLToPath } from 'node:url'
import {
  loadLayeredEnv,
  runProfile,
} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  parseDesktopIpcMessage,
  serveDesktopHost,
  type DesktopHostChannel,
  type DesktopHostRuntime,
} from '@deepseek-ai/dsh-host-desktop-electron'
import { desktopAppUrl, HOST_URL_PREFIX, type AuthenticatedUrlOwner } from './app-url.ts'

/** This dsh installation's package.json; `src/` and `lib/` both sit one level under `apps/desktop`. */
const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

/** The booted profile; the desktop bundle is the default, the Web profile stays available for development. */
const PROFILE = process.env.DSH_DESKTOP_PROFILE ?? 'desktop'

const booted = await runProfile({
  environment: loadLayeredEnv('dsh'),
  profile: PROFILE,
  installAnchor: INSTALL_ANCHOR,
  // The packaged desktop app applies user-patch edits on restart: Electron's
  // Node cannot mount the vendored config-HMR service.
  patchReload: 'frozen',
  patchFiles: [],
  args: [],
})

const desktopRuntime = booted.ctx.get('desktopRuntime') as DesktopHostRuntime & {
  handler(): { fetch(request: Request): Promise<Response> }
} | undefined

if (desktopRuntime === undefined) {
  // Web-profile development mode (milestone 1): announce the authenticated
  // loopback URL the shell window loads instead of serving the carrier.
  const webServer = booted.ctx.get('webServer')
  const connection = booted.ctx.get('connection') as AuthenticatedUrlOwner | undefined
  if (webServer === undefined || connection === undefined) {
    throw new Error(`dsh desktop host: the ${PROFILE} composition exposes no webServer/connection service`)
  }
  console.log(`${HOST_URL_PREFIX}${desktopAppUrl(webServer.port, connection)}`)
} else {
  const fetchLane = desktopRuntime.handler()
  const channel: DesktopHostChannel = {
    send: (message) => { process.send?.(message) },
    onMessage: (listener) => {
      const wrapped = (value: unknown): void => {
        const message = parseDesktopIpcMessage(value)
        if (message !== undefined) listener(message)
      }
      process.on('message', wrapped)
      return () => { process.off('message', wrapped) }
    },
  }
  serveDesktopHost(channel, {
    fetch: request => fetchLane.fetch(request),
    openStream: (endpoint, payload, signal) => desktopRuntime.openStream(endpoint, payload, signal),
    failure: error => desktopRuntime.failure(error),
    bootPayload: () => desktopRuntime.bootPayload() as { injections: readonly unknown[] },
    bundleBytes: pkg => desktopRuntime.bundleBytes(pkg),
  })
  console.log(`dsh desktop host: carrier ready (${PROFILE} profile)`)
}
