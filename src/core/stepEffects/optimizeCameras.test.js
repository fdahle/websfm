import { describe, it, expect } from 'vitest'
import { optimizeCamerasEffects } from './optimizeCameras.js'

describe('optimizeCamerasEffects', () => {
  it('words what is refined', () => {
    expect(optimizeCamerasEffects({ refine: 'f' }, { cameras: 12, points: 3000, gcps: 1 }).refine).toMatch(
      /^Bundle adjustment of 12 cameras and 3,000 points, the focal length free .* held to 1 control point/,
    )
    expect(optimizeCamerasEffects({ refine: 'f,cxcy' }).refine).toMatch(/focal length and principal point free/)
  })
})
