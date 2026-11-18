import { describe, it, expect } from 'vitest'
import { isNewerVersion, otherVersions, pinnedUrl, pinnedVersionOf } from './appVersion.js'

describe('appVersion', () => {
  it('reads the pinned version from the base URL, and only from /v/<version>/', () => {
    expect(pinnedVersionOf('/v/0.9.0/')).toBe('0.9.0')
    expect(pinnedVersionOf('/v/1.0.0-beta.2/')).toBe('1.0.0-beta.2')
    expect(pinnedVersionOf('/')).toBeNull()
    expect(pinnedVersionOf('/websfm/')).toBeNull()
    expect(pinnedVersionOf('/v/latest/')).toBeNull()
    expect(pinnedVersionOf(undefined)).toBeNull()
    expect(pinnedVersionOf(pinnedUrl('0.9.0'))).toBe('0.9.0')
  })

  it('compares versions by number, and never throws on junk', () => {
    expect(isNewerVersion('0.10.0', '0.9.0')).toBe(true)
    expect(isNewerVersion('0.9.0', '0.10.0')).toBe(false)
    expect(isNewerVersion('0.9.0', '0.9.0')).toBe(false)
    expect(isNewerVersion('junk', '0.9.0')).toBe(false)
  })

  it('offers the other pinned versions, or nothing where the site has none', () => {
    expect(otherVersions({ versions: ['0.10.0', '0.9.0', 'x/y', 3] }, '0.9.0')).toEqual(['0.10.0'])
    expect(otherVersions({ versions: [] }, '0.9.0')).toEqual([])
    expect(otherVersions(null, '0.9.0')).toBeNull()
    expect(otherVersions({ error: 'nope' }, '0.9.0')).toBeNull()
  })
})
