/**
 * Complete validation of application deep links before anything they name
 * reaches a command or host API. The public scheme is `dsh://`; the internal
 * privileged `dsh-desktop://` authority is deliberately cross-authority and
 * rejected here, so a link can never smuggle renderer-navigation intents into
 * the dispatch path. Pure string validation only — no Electron import, so
 * tests drive it headlessly.
 * @module @deepseek-ai/dsh-desktop/deep-link
 */

/** The public scheme external applications link into. */
export const DESKTOP_DEEP_LINK_SCHEME = 'dsh'

/** One accepted deep-link intent, fully validated. */
export type DesktopDeepLink = {
  readonly op: 'open'
  /** Absolute directory path the `open` operation names. */
  readonly path: string
}

/** Longest accepted link; a longer one is malformed rather than truncatable. */
const MAX_LINK_LENGTH = 4096

/** Whether one path is absolute on this input's platform grammar. */
function isAbsolutePath(value: string): boolean {
  if (value.startsWith('/')) return true
  // Windows drive form, with either separator after the drive letter.
  return /^[a-zA-Z]:[\\/]/.test(value)
}

/**
 * Validate one external link completely.
 * @param value - the URL as the operating system delivered it.
 * @returns the accepted intent, or undefined for malformed, unsupported, or
 * cross-authority input — which must never reach a dispatch.
 */
export function parseDesktopDeepLink(value: string): DesktopDeepLink | undefined {
  if (value.length === 0 || value.length > MAX_LINK_LENGTH) return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== 'dsh:') return undefined
  // Credentials or a fragment never appear in a link this application issues;
  // their presence is a crafted input, not a variant.
  if (url.username !== '' || url.password !== '' || url.hash !== '') return undefined
  if (url.pathname !== '' && url.pathname !== '/') return undefined
  switch (url.host) {
    case 'open': {
      const path = url.searchParams.get('path')
      if (path === null || !isAbsolutePath(path)) return undefined
      // Exactly one parameter: a link with extra or repeated parameters is
      // malformed, not a best-effort interpretation.
      const keys = [...url.searchParams.keys()]
      if (keys.length !== 1 || keys[0] !== 'path') return undefined
      return { op: 'open', path }
    }
    default:
      return undefined
  }
}

/**
 * Extract the deep-link argument from one process argv.
 * @param argv - the argument vector of a cold or warm instance.
 * @returns the first `dsh://` argument, or undefined when none is present.
 */
export function extractDesktopDeepLinkArgv(argv: readonly string[]): string | undefined {
  return argv.find(argument => argument.startsWith(`${DESKTOP_DEEP_LINK_SCHEME}://`))
}
