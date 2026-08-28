/** Launch the installed Electron desktop assembly from the sole public `dsh` bin. */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'

const DESKTOP_INVOCATION_ENV = 'DSH_DESKTOP_INVOCATION'
const DESKTOP_PACKAGE = '@deepseek-ai/dsh-desktop/package.json'

/** Resolve the desktop assembly installed with this CLI. */
function desktopManifest(): string {
  try {
    return createRequire(import.meta.url).resolve(DESKTOP_PACKAGE)
  } catch (error) {
    throw new Error('dsh desktop: the Electron application is not installed with this dsh CLI', { cause: error })
  }
}

/** Resolve the Electron binary installed for the desktop assembly. */
function electronExecutable(manifest: string): string {
  const require = createRequire(manifest)
  let executable: unknown
  try {
    executable = require('electron')
  } catch (error) {
    throw new Error('dsh desktop: Electron is not installed for the desktop application', { cause: error })
  }
  if (typeof executable !== 'string') {
    throw new Error('dsh desktop: the Electron package did not resolve to an executable')
  }
  return executable
}

/**
 * Launch Electron and remain attached until the application exits.
 * @param patchFiles Extra profile overlays from the `dsh desktop` invocation.
 * @param args Arguments passed to the profile inside the desktop host child.
 * @returns Electron's exit code, or 1 when a signal ended the process.
 */
export function runDesktop(patchFiles: readonly string[], args: readonly string[]): number {
  const manifest = desktopManifest()
  const result = spawnSync(electronExecutable(manifest), [dirname(manifest)], {
    env: {
      ...process.env,
      [DESKTOP_INVOCATION_ENV]: JSON.stringify({ version: 0, patchFiles, args }),
    },
    stdio: 'inherit',
  })
  if (result.error !== undefined) {
    throw new Error('dsh desktop: failed to launch Electron', { cause: result.error })
  }
  if (result.signal !== null) {
    console.error(`dsh desktop: Electron exited from signal ${result.signal}`)
    return 1
  }
  return result.status ?? 1
}
