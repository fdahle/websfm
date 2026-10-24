import { describe, it, expect } from 'vitest'
import { fiducialDetectEffects } from './fiducialDetect.js'
import { FIDUCIAL_SPOT_DEFAULTS } from '../defaults.user.js'

describe('fiducialDetectEffects', () => {
  it('words the search, matching and storage', () => {
    const e = fiducialDetectEffects(FIDUCIAL_SPOT_DEFAULTS, { images: 3 })
    expect(e.search).toMatch(/^3 images are searched at /)
    expect(fiducialDetectEffects(FIDUCIAL_SPOT_DEFAULTS).search).toMatch(/^No images/)
    expect(fiducialDetectEffects({ ...FIDUCIAL_SPOT_DEFAULTS, family: 'frame' }).match).toMatch(/^Not used/)
    expect(fiducialDetectEffects({ ...FIDUCIAL_SPOT_DEFAULTS, overwrite: true }).store).toMatch(
      /^Existing detections are replaced/,
    )
  })
})
