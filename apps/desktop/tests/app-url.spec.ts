/** Desktop shell URL assembly over the booted composition's services. */

import { describe, expect, it } from 'vitest'
import { desktopAppUrl, type AuthenticatedUrlOwner } from '../src/app-url.ts'

describe('desktopAppUrl', () => {
  it('composes the canonical loopback base and delegates token minting', () => {
    const owner: AuthenticatedUrlOwner = { authenticatedUrl: base => `${base}?token=t` }
    expect(desktopAppUrl(3080, owner)).toBe('http://127.0.0.1:3080?token=t')
  })

  it('uses the booted port verbatim, including OS-assigned ports', () => {
    const owner: AuthenticatedUrlOwner = { authenticatedUrl: base => base }
    expect(desktopAppUrl(0, owner)).toBe('http://127.0.0.1:0')
    expect(desktopAppUrl(51831, owner)).toBe('http://127.0.0.1:51831')
  })
})
