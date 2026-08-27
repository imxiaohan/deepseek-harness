/**
 * Desktop shell URL assembly: the canonical loopback base of the booted Web
 * composition plus the process-token URL the window loads. Mirrors the Web
 * runtime's `localWebUrl` (`dsh-web-app`) so both surfaces announce the same
 * authority.
 * @module @deepseek-ai/dsh-desktop/app-url
 */

/** The loopback host every dsh web composition serves on. */
const LOOPBACK_HOST = '127.0.0.1'

/** One stdout line prefix the desktop host announces its application URL with. */
export const HOST_URL_PREFIX = 'dsh desktop host: '

/** The connection face the desktop shell reads; the service owns token minting. */
export interface AuthenticatedUrlOwner {
  /** Add this process's launch token to the clean application URL. */
  authenticatedUrl(baseUrl: string): string
}

/**
 * Resolve the authenticated application URL the desktop window loads.
 * @param port - the booted Web composition's listening port.
 * @param connection - the booted connection service owning the launch token.
 * @returns the loopback URL carrying the process token.
 */
export function desktopAppUrl(port: number, connection: AuthenticatedUrlOwner): string {
  return connection.authenticatedUrl(`http://${LOOPBACK_HOST}:${String(port)}`)
}
