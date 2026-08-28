/** Validated CLI-to-host launch values for the desktop profile process. */

const DESKTOP_INVOCATION_ENV = 'DSH_DESKTOP_INVOCATION'

interface DesktopLaunchInvocation {
  readonly patchFiles: string[]
  readonly args: string[]
}

/** Test whether a parsed JSON value is a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse the versioned invocation passed from `dsh desktop` to the host child.
 * @param source The serialized process-boundary value; absence means a direct Electron launch.
 * @returns Validated patch paths and profile arguments.
 */
export function parseDesktopLaunchInvocation(
  source = process.env[DESKTOP_INVOCATION_ENV],
): DesktopLaunchInvocation {
  if (source === undefined) return { patchFiles: [], args: [] }
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error) {
    throw new Error(`dsh desktop host: ${DESKTOP_INVOCATION_ENV} must be valid JSON`, { cause: error })
  }
  if (!isRecord(value)
    || value.version !== 0
    || !Array.isArray(value.patchFiles)
    || !value.patchFiles.every(item => typeof item === 'string')
    || !Array.isArray(value.args)
    || !value.args.every(item => typeof item === 'string')
    || Object.keys(value).some(key => !['version', 'patchFiles', 'args'].includes(key))) {
    throw new Error(`dsh desktop host: ${DESKTOP_INVOCATION_ENV} has invalid fields`)
  }
  return { patchFiles: value.patchFiles, args: value.args }
}
