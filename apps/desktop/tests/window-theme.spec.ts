import { describe, expect, it } from 'vitest'
import { parseDesktopWindowThemeSource } from '../src/window-theme.ts'

describe('desktop window theme IPC', () => {
  it('accepts Electron theme sources and rejects other renderer values', () => {
    expect(parseDesktopWindowThemeSource('light')).toBe('light')
    expect(parseDesktopWindowThemeSource('dark')).toBe('dark')
    expect(parseDesktopWindowThemeSource('system')).toBe('system')
    expect(parseDesktopWindowThemeSource('sepia')).toBeUndefined()
    expect(parseDesktopWindowThemeSource({ source: 'dark' })).toBeUndefined()
  })
})
