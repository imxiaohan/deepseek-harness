/** Registration/capability behavior of the Electron-native backend (the seam's cordis half). */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ElectronDirectoryPicker from '../src/index.ts'

describe('ElectronDirectoryPicker', () => {
  it('registers ctx.directoryPicker with a stable native capability and leaves with its fiber', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(ElectronDirectoryPicker)
    await fiber.await()
    const picker = ctx.get('directoryPicker')
    expect(picker).toBeInstanceOf(ElectronDirectoryPicker)
    const capability = picker!.capability()
    expect(capability.kind).toBe('native')
    expect(picker!.capability()).toBe(capability)
    await fiber.dispose()
    expect(ctx.get('directoryPicker')).toBeUndefined()
  })

  it('routes a pick through the desktopRuntime lane and returns its answer', async () => {
    const ctx = new Context()
    const nativeRequest = vi.fn(async (): Promise<string | null> => '/chosen')
    ctx.provide('desktopRuntime', {
      nativeRequest: async (op: string, _args: undefined, _signal: AbortSignal) => {
        expect(op).toBe('directory-pick')
        return nativeRequest()
      },
    })
    const fiber = ctx.plugin(ElectronDirectoryPicker)
    await fiber.await()
    const picker = ctx.get('directoryPicker')!
    const capability = picker.capability()
    expect(capability.kind).toBe('native')
    if (capability.kind === 'native') {
      await expect(capability.pick(new AbortController().signal)).resolves.toBe('/chosen')
    }
    expect(nativeRequest).toHaveBeenCalledOnce()
    await fiber.dispose()
  })

  it('fails loudly when the composition exposes no desktopRuntime lane', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(ElectronDirectoryPicker)
    await fiber.await()
    const picker = ctx.get('directoryPicker')!
    const capability = picker.capability()
    await expect((async () => {
      if (capability.kind === 'native') await capability.pick(new AbortController().signal)
    })()).rejects.toThrow('no desktopRuntime lane')
    await fiber.dispose()
  })
})
