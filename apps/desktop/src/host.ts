/**
 * The desktop host entry: a plain-Node process that boots the desktop's
 * profile through `runProfile` and announces the authenticated application
 * URL on stdout for the Electron shell. It deliberately imports no Electron
 * module: the Electron main process spawns this entry through the same
 * binary under `ELECTRON_RUN_AS_NODE=1`, where Node's internal module loader
 * — which the vendored Cordis Loader's plugin imports depend on — is intact.
 *
 * Milestone 1 boots the Web profile; the desktop bundle is milestone 2.
 * @module @deepseek-ai/dsh-desktop/host
 */

import { fileURLToPath } from 'node:url'
import { loadLayeredEnv, runProfile } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { desktopAppUrl, HOST_URL_PREFIX } from './app-url.ts'

/** This dsh installation's package.json; `src/` and `lib/` both sit one level under `apps/desktop`. */
const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

/** The booted profile; the Web profile is milestone 1's deliberate carrier. */
const PROFILE = process.env.DSH_DESKTOP_PROFILE ?? 'web'

const booted = await runProfile({
  environment: loadLayeredEnv('dsh'),
  profile: PROFILE,
  installAnchor: INSTALL_ANCHOR,
  // The packaged desktop app applies user-patch edits on restart: Electron's
  // Node cannot mount the vendored config-HMR service.
  patchReload: 'frozen',
  patchFiles: [],
  // The shell's window is the browser handoff; the Web runtime must not
  // spawn the system browser beside it.
  args: ['--no-open'],
})
const webServer = booted.ctx.get('webServer')
const connection = booted.ctx.get('connection')
if (webServer === undefined || connection === undefined) {
  throw new Error(`dsh desktop host: the ${PROFILE} composition exposes no webServer/connection service`)
}
console.log(`${HOST_URL_PREFIX}${desktopAppUrl(webServer.port, connection)}`)
