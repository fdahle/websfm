import { describe, it, expect } from 'vitest'
import { sparseEffects, sparseModeEffect } from './sparse.js'
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

  it('describes adding images to the model', () => {
    const add = { ...RECONSTRUCT_DEFAULTS, addToModel: true }
    const e = sparseEffects(add, { ...project, modelCameras: 412, newImages: 38 })
    expect(e.register).toMatch(/^38 new images can join the model's 412 cameras\./)
    expect(e.ba).toMatch(/model's cameras hold them in place/)
    expect(e.calibration).toMatch(/^Off while adding images/)
  })
})

describe('sparseModeEffect', () => {
  const p = { modelCameras: 412, newImages: 38 }
  it('says what Auto chose and why', () => {
    expect(sparseModeEffect({ addToModel: true, existingCameras: 'auto' }, { ...p, hasProducts: true })).toBe(
      '38 new images join the model; its 412 cameras stay where they are, so depth maps, clouds and rasters ' +
        'built from them stay current (Auto: something was built from them).',
    )
    expect(sparseModeEffect({ addToModel: true, existingCameras: 'auto' }, p)).toBe(
      '38 new images join the model, then Optimize cameras refines every camera with them ' +
        '(Auto: nothing was built from the model yet).',
    )
    expect(sparseModeEffect({ addToModel: true, existingCameras: 'refined' }, { ...p, hasProducts: true })).toMatch(
      /depth maps and the georeference are retired/,
    )
  })
  it('names a blocker, and what a rebuild replaces', () => {
    expect(sparseModeEffect({ addToModel: true }, { ...p, blocker: 'there is no sparse model yet' })).toBe(
      'Cannot add: there is no sparse model yet.',
    )
    expect(sparseModeEffect({ addToModel: false }, { ...p, hasProducts: true })).toMatch(
      /^A new model from every image replaces the one with 412 cameras; what was built from it is kept/,
    )
  })
})
