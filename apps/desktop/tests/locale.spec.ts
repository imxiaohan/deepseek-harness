import { describe, expect, it } from 'vitest'
import { desktopNativeCopy } from '../src/locale.ts'

describe('desktop native locale copy', () => {
  it('resolves Chinese locales and formats native process details', () => {
    const copy = desktopNativeCopy('zh-CN')

    expect(copy.fatalStages['fatal.renderer.processExited']).toBe('renderer 进程已退出')
    expect(copy.rendererExitDetail('crashed', 7)).toBe('crashed；退出码 7')
    expect(copy.hostExitDetail(null)).toContain('退出码 null')
  })

  it('defaults unsupported locales to complete English copy', () => {
    const copy = desktopNativeCopy('fr-FR')

    expect(copy.fatalStages['fatal.host.startFailed']).toBe('host process failed to start')
    expect(copy.rendererExitDetail('crashed', 7)).toBe('crashed; exit code 7')
    expect(copy.hostExitDetail(1)).toContain('exit code 1')
  })
})
