/** IPC fields used to project the page theme onto Electron-native window chrome. */

/** One-way preload-to-main channel carrying the selected native theme source. */
export const DESKTOP_WINDOW_THEME_CHANNEL = 'dsh:desktop-window-theme'

/** Theme sources Electron can apply to operating-system window chrome. */
export type DesktopWindowThemeSource = 'light' | 'dark' | 'system'

/**
 * Validate a theme source received across the renderer IPC boundary.
 * @param value - Untrusted renderer payload.
 * @returns The accepted Electron theme source, or undefined.
 */
export function parseDesktopWindowThemeSource(value: unknown): DesktopWindowThemeSource | undefined {
  return value === 'light' || value === 'dark' || value === 'system' ? value : undefined
}
