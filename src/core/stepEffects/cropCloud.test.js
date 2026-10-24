import { describe, it, expect } from 'vitest'
import { cropCloudEffects } from './cropCloud.js'
import { CROP_CLOUD_DEFAULTS } from '../defaults.user.js'

describe('cropCloudEffects', () => {
  it('words the box and the live count', () => {
    const s = { ...CROP_CLOUD_DEFAULTS, minX: 0, maxX: 10, maxZ: 5 }
    const e = cropCloudEffects(s, { kept: 1200, total: 5000 })
    expect(e.box).toBe('X 0 – 10 · Y open · Z up to 5.')
    expect(e.keep).toBe('Keeps 1,200 of 5,000 points, inside the box.')
    expect(cropCloudEffects({ ...s, invert: true }, { kept: 1, total: 2, noun: 'vertices', mesh: true }).keep).toMatch(
      /outside the box; a triangle stays when all three corners do/,
    )
    expect(cropCloudEffects(s, { total: 3e7 }).keep).toMatch(/too many to count live/)
    expect(cropCloudEffects(s, { streamed: true }).keep).toMatch(/octree/)
  })
})
