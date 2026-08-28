import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { apply, inject, name } from '../src/invariant.ts'

describe('@deepseek-ai/dsh-host-desktop-electron/invariant', () => {
  it('registers the package-owned empty companion', async () => {
    let installed: InvariantInstaller | undefined
    const register = vi.fn((_packageName: string, installer: InvariantInstaller) => {
      installed = installer
      return vi.fn()
    })
    const ctx = new Context()
    ctx.provide('invariants', { register })

    const dispose = await apply(ctx)

    expect(name).toBe('desktop-electron-invariant')
    expect(inject).toEqual(['invariants'])
    expect(register).toHaveBeenCalledWith(
      '@deepseek-ai/dsh-host-desktop-electron',
      expect.any(Function),
    )
    await installed?.(ctx, (message) => { throw new Error(message) })
    dispose()
  })
})
