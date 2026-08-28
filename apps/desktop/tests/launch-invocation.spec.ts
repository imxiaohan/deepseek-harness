import { describe, expect, it } from 'vitest'
import { parseDesktopLaunchInvocation } from '../src/launch-invocation.ts'

describe('desktop launch invocation', () => {
  it('defaults direct Electron launches and parses CLI values', () => {
    expect(parseDesktopLaunchInvocation(undefined)).toEqual({ patchFiles: [], args: [] })
    expect(parseDesktopLaunchInvocation(JSON.stringify({
      version: 0,
      patchFiles: ['/tmp/desktop.yml'],
      args: ['--inspect-profile'],
    }))).toEqual({ patchFiles: ['/tmp/desktop.yml'], args: ['--inspect-profile'] })
  })

  it.each([
    ['not-json', 'valid JSON'],
    ['null', 'invalid fields'],
    ['{}', 'invalid fields'],
    ['{"version":1,"patchFiles":[],"args":[]}', 'invalid fields'],
    ['{"version":0,"patchFiles":[1],"args":[]}', 'invalid fields'],
    ['{"version":0,"patchFiles":[],"args":[1]}', 'invalid fields'],
    ['{"version":0,"patchFiles":[],"args":[],"extra":true}', 'invalid fields'],
  ])('rejects %s', (source, message) => {
    expect(() => parseDesktopLaunchInvocation(source)).toThrow(message)
  })
})
