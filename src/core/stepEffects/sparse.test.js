import { describe, it, expect } from 'vitest'
import { sparseEffects } from './sparse.js'
import { RECONSTRUCT_DEFAULTS } from '../defaults.user.js'

const project = { linkedImages: 42, pairs: 300, sensors: 1, autoReason: null }

describe('sparseEffects', () => {
  it('names the images that can join and the registration gates', () => {
    const e = sparseEffects(RECONSTRUCT_DEFAULTS, project)
    expect(e.register).toMatch(/^42 images linked by 300 matched pairs can join the model/)
    expect(e.register).toContain(`at least ${RECONSTRUCT_DEFAULTS.minMatchesForRegistration} of its tie points`)
    expect(sparseEffects(RECONSTRUCT_DEFAULTS, {}).register).toMatch(/^Match features first/)
  })

  it('ties self-calibration to bundle adjustment', () => {
    expect(sparseEffects({ ...RECONSTRUCT_DEFAULTS, refineIntrinsics: 'f' }, project).calibration).toBe(
      'Solved for each sensor (1 sensor): the focal length.',
    )
    const off = sparseEffects({ ...RECONSTRUCT_DEFAULTS, baIterations: 0 }, project)
    expect(off.ba).toMatch(/^Off/)
    expect(off.calibration).toMatch(/^Not used/)
    expect(sparseEffects(RECONSTRUCT_DEFAULTS, { ...project, autoReason: 'EXIF only.' }).calibration).toMatch(
      /^This project \(1 sensor\): EXIF only\.$/,
    )
  })
})
