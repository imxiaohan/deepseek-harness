/**
 * The desktop host entry: a plain-Node process that boots the desktop's
 * profile through `runProfile` and serves the IPC carrier until teardown.
 * With the `desktop` profile it bridges the composition's `desktopRuntime`
 * lane (shared fetch handler, Gateway wire streams, boot payload, plugin
 * bundles) over the process channel; with the Web profile (milestone-1
 * development mode) it falls back to announcing the authenticated URL line.
 * It deliberately imports no Electron module: the Electron main process
 * spawns this entry through the same binary under `ELECTRON_RUN_AS_NODE=1`.
 * The vendored Loader uses its config-tree-anchored import fallback because
 * this runtime does not expose Node's internal ESM loader.
 * @module @deepseek-ai/dsh-desktop/host
 */

import { fileURLToPath } from 'node:url'
import {
  loadLayeredEnv,
  PROCESS_SHUTDOWN_TIMEOUT_MS,
  runProfile,
} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  parseDesktopIpcMessage,
  serveDesktopHost,
  type DesktopHostChannel,
  type DesktopHostRuntime,
  type DesktopIpcMessage,
} from '@deepseek-ai/dsh-host-desktop-electron'
import { desktopAppUrl, HOST_URL_PREFIX, type AuthenticatedUrlOwner } from './app-url.ts'
import { parseDesktopLaunchInvocation } from './launch-invocation.ts'

/** This dsh installation's package.json; `src/` and `lib/` both sit one level under `apps/desktop`. */
const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

/** The booted profile; the desktop bundle is the default, the Web profile stays available for development. */
const PROFILE = process.env.DSH_DESKTOP_PROFILE ?? 'desktop'
const invocation = parseDesktopLaunchInvocation()

let parentDisconnected = !process.connected
const queuedMessages: unknown[] = []
let receiveMessage: ((value: unknown) => void) | undefined
const queueMessage = (value: unknown): void => {
  if (receiveMessage === undefined) queuedMessages.push(value)
  else receiveMessage(value)
}
const lifecycle: { stop?: (code: 0 | 1) => Promise<void> } = {}
const parentDisconnect = (): void => {
  parentDisconnected = true
  void lifecycle.stop?.(1)
}
process.on('message', queueMessage)
process.on('disconnect', parentDisconnect)

const booted = await runProfile({
  environment: loadLayeredEnv('dsh'),
  profile: PROFILE,
  installAnchor: INSTALL_ANCHOR,
  // The packaged desktop app applies user-patch edits on restart: Electron's
  // Node cannot mount the vendored config-HMR service.
  patchReload: 'frozen',
  patchFiles: invocation.patchFiles,
  args: invocation.args,
})

const desktopRuntime = booted.ctx.get('desktopRuntime') as DesktopHostRuntime | undefined
let disposeBridge = async (): Promise<void> => {}
let stopping: Promise<void> | undefined
const stopHost = (code: 0 | 1): Promise<void> => {
  if (stopping !== undefined) return stopping
  process.off('message', queueMessage)
  process.off('disconnect', parentDisconnect)
  const timeout = setTimeout(() => { process.exit(code) }, PROCESS_SHUTDOWN_TIMEOUT_MS)
  stopping = disposeBridge()
    .then(() => booted.shutdown.shutdown(code))
    .then(() => {
      if (process.connected) process.disconnect()
    })
    .finally(() => { clearTimeout(timeout) })
  return stopping
}
lifecycle.stop = stopHost

if (parentDisconnected) {
  await stopHost(1)
} else if (desktopRuntime === undefined) {
  // Web-profile development mode (milestone 1): announce the authenticated
  // loopback URL the shell window loads instead of serving the carrier.
  const webServer = booted.ctx.get('webServer')
  const connection = booted.ctx.get('connection') as AuthenticatedUrlOwner | undefined
  if (webServer === undefined || connection === undefined) {
    throw new Error(`dsh desktop host: the ${PROFILE} composition exposes no webServer/connection service`)
  }
  console.log(`${HOST_URL_PREFIX}${desktopAppUrl(webServer.port, connection)}`)
} else {
  const listeners = new Set<(message: DesktopIpcMessage) => void>()
  const channel: DesktopHostChannel = {
    send: (message) => { process.send?.(message) },
    onMessage: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  disposeBridge = serveDesktopHost(channel, {
    fetch: request => desktopRuntime.fetch(request),
    openStream: (endpoint, payload, signal) => desktopRuntime.openStream(endpoint, payload, signal),
    failure: error => desktopRuntime.failure(error),
    bootPayload: () => desktopRuntime.bootPayload(),
  })
  console.log(`dsh desktop host: carrier ready (${PROFILE} profile)`)

  receiveMessage = (value) => {
    const message = parseDesktopIpcMessage(value)
    if (message === undefined) {
      console.error('dsh desktop host: main process sent an invalid carrier message')
      void stopHost(1)
      return
    }
    if (message.t === 'shutdown') {
      void stopHost(message.code)
      return
    }
    for (const listener of [...listeners]) listener(message)
  }
  for (const value of queuedMessages.splice(0)) receiveMessage(value)
}

if (desktopRuntime === undefined && !parentDisconnected) {
  receiveMessage = (value) => {
    const message = parseDesktopIpcMessage(value)
    if (message?.t === 'shutdown') void stopHost(message.code)
    else {
      console.error('dsh desktop host: main process sent an invalid carrier message')
      void stopHost(1)
    }
  }
  for (const value of queuedMessages.splice(0)) receiveMessage(value)
}
