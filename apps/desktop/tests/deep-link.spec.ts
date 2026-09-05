/**
 * Complete deep-link validation: accepted intents, malformed input,
 * unsupported operations, and cross-authority (including the internal
 * privileged scheme) refusals, plus argv extraction.
 */

import { describe, expect, it } from 'vitest'
import { extractDesktopDeepLinkArgv, parseDesktopDeepLink } from '../src/deep-link.ts'

describe('desktop deep-link validation', () => {
  it('accepts one open intent with an absolute POSIX path', () => {
    expect(parseDesktopDeepLink('dsh://open?path=%2FUsers%2Ftest%2Fproject')).toEqual({
      op: 'open',
      path: '/Users/test/project',
    })
  })

  it('accepts a Windows drive path with either separator', () => {
    expect(parseDesktopDeepLink('dsh://open?path=C%3A%5Cwork')).toEqual({ op: 'open', path: 'C:\\work' })
    expect(parseDesktopDeepLink('dsh://open?path=D%3A%2Fwork')).toEqual({ op: 'open', path: 'D:/work' })
  })

  it('accepts an empty-path parameter carrying only the slash', () => {
    expect(parseDesktopDeepLink('dsh://open?path=%2F')).toEqual({ op: 'open', path: '/' })
  })

  it.each([
    ['empty input', ''],
    ['not a URL', 'open the app'],
    ['wrong scheme', 'https://open?path=%2Ftmp'],
    ['internal privileged scheme is cross-authority', 'dsh-desktop://app/index.html'],
    ['internal scheme with an open op is still cross-authority', 'dsh-desktop://open?path=%2Ftmp'],
    ['no host', 'dsh:?path=%2Ftmp'],
    ['unknown operation', 'dsh://focus?path=%2Ftmp'],
    ['operation with credentials', 'dsh://user:pass@open?path=%2Ftmp'],
    ['fragment present', 'dsh://open?path=%2Ftmp#section'],
    ['path parameter missing', 'dsh://open'],
    ['relative path', 'dsh://open?path=relative%2Fdir'],
    ['empty path', 'dsh://open?path='],
    ['extra parameter', 'dsh://open?path=%2Ftmp&x=1'],
    ['repeated path parameter', 'dsh://open?path=%2Ftmp&path=%2Fopt'],
    ['non-path parameter only', 'dsh://open?url=%2Ftmp'],
    ['pathname carries segments', 'dsh://open/extra?path=%2Ftmp'],
    ['over-long link', `dsh://open?path=${'/'.repeat(4100)}`],
  ])('rejects %s', (_label, value) => {
    expect(parseDesktopDeepLink(value)).toBeUndefined()
  })

  it('extracts the link argument from an argv', () => {
    expect(extractDesktopDeepLinkArgv(['/path/to/app', '--flag', 'dsh://open?path=%2Ftmp']))
      .toBe('dsh://open?path=%2Ftmp')
    expect(extractDesktopDeepLinkArgv(['/path/to/app', '--flag'])).toBeUndefined()
    expect(extractDesktopDeepLinkArgv([])).toBeUndefined()
  })
})
