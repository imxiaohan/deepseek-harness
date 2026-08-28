import { createRequire } from 'node:module'
import { basename, dirname } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const spawnSync = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawnSync }))

import { runDesktop } from '../src/desktop.ts'

beforeEach(() => {
  spawnSync.mockReset()
})

describe('desktop launcher', () => {
  it('launches the installed Electron app with the profile invocation envelope', () => {
    spawnSync.mockReturnValue({ status: 0, signal: null })

    expect(runDesktop(['/tmp/one.yml'], ['--inspect-profile'])).toBe(0)

    const [command, args, options] = spawnSync.mock.calls[0] as [string, string[], {
      env: Record<string, string>
      stdio: string
    }]
    expect(basename(command).toLowerCase()).toContain('electron')
    const manifest = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-desktop/package.json')
    expect(args).toEqual([dirname(manifest)])
    expect(options.stdio).toBe('inherit')
    const envelope = options.env.DSH_DESKTOP_INVOCATION
    if (envelope === undefined) throw new Error('missing desktop invocation envelope')
    expect(JSON.parse(envelope)).toEqual({
      version: 0,
      patchFiles: ['/tmp/one.yml'],
      args: ['--inspect-profile'],
    })
  })

  it('returns Electron exit failures', () => {
    spawnSync.mockReturnValueOnce({ status: 7, signal: null })
    expect(runDesktop([], [])).toBe(7)

    spawnSync.mockReturnValueOnce({ status: null, signal: 'SIGTERM' })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(runDesktop([], [])).toBe(1)
    expect(console.error).toHaveBeenCalledWith('dsh desktop: Electron exited from signal SIGTERM')
  })

  it('fails loud when Electron cannot start', () => {
    spawnSync.mockReturnValue({ error: new Error('spawn failed'), status: null, signal: null })
    expect(() => runDesktop([], [])).toThrow('dsh desktop: failed to launch Electron')
  })
})
