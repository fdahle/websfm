import { describe, it, expect } from 'vitest'

import { isImageEnabled, disabledUuids } from './imageEnabled.js'

describe('imageEnabled', () => {
  it('counts an image without the flag as enabled, and lists the disabled', () => {
    const images = [{ uuid: 'a' }, { uuid: 'b', enabled: false }, { uuid: 'c', enabled: true }]
    expect(images.map(isImageEnabled)).toEqual([true, false, true])
    expect([...disabledUuids(images)]).toEqual(['b'])
    expect(disabledUuids(null).size).toBe(0)
  })
})
