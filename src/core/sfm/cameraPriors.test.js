import { describe, expect, it } from 'vitest'
import { buildCameraPriors, orientationPriorInSfm } from './cameraPriors.js'

const images = [{ id: 'image-1', uuid: 'uuid-1' }, { id: 'image-2', uuid: 'uuid-2' }]

describe('buildCameraPriors', () => {
  it('passes enabled metric 3D EXIF poses and their per-axis accuracies', () => {
    expect(buildCameraPriors([{
      imageId: 'image-1', x: 10, y: 20, z: 30,
      accuracyX: 1, accuracyY: 2, accuracyZ: 4, source: 'exif', enabled: true,
      omega: 1, phi: 2, kappa: 3,
      accuracyOmega: 0.1, accuracyPhi: 0.2, accuracyKappa: 0.3,
    }], images, 'EPSG:3857')).toEqual([{
      uuid: 'uuid-1', x: 10, y: 20, z: 30,
      accuracyX: 1, accuracyY: 2, accuracyZ: 4, source: 'exif',
      omega: 1, phi: 2, kappa: 3,
      accuracyOmega: 0.1, accuracyPhi: 0.2, accuracyKappa: 0.3,
    }])
  })

  it('keeps XY-only, disabled, and unmatched positions out of BA', () => {
    const poses = [
      { imageId: 'image-1', x: 1, y: 2, z: null, enabled: true },
      { imageId: 'image-2', x: 1, y: 2, z: 3, enabled: false },
      { imageId: 'missing', x: 1, y: 2, z: 3, enabled: true },
    ]
    expect(buildCameraPriors(poses, images, 'EPSG:3857')).toEqual([])
  })

  it('converts EPSG:4326 poses into a survey-centred metric frame', () => {
    const priors = buildCameraPriors([
      { imageId: 'image-1', x: 4, y: 52, z: 100, accuracyX: 5, accuracyY: 6, accuracyZ: 10 },
      { imageId: 'image-2', x: 4.001, y: 52.001, z: 103, accuracyX: 5, accuracyY: 6, accuracyZ: 10 },
    ], images, 'EPSG:4326')

    expect(priors).toHaveLength(2)
    expect(priors[0].metricFrame).toBe('local-geographic')
    expect(priors[1].x - priors[0].x).toBeCloseTo(68.68, 1)
    expect(priors[1].y - priors[0].y).toBeCloseTo(111.27, 1)
    expect(priors.map((prior) => prior.z)).toEqual([100, 103])
    expect(priors[0]).toMatchObject({ accuracyX: 5, accuracyY: 6, accuracyZ: 10 })
  })

  it('uses canonical metre altitude and accuracies for geographic EXIF poses', () => {
    const [prior] = buildCameraPriors([{
      imageId: 'image-1', x: 4, y: 52, z: 999,
      altitudeMeters: 120, accuracyX: 99, accuracyY: 99, accuracyZ: 99,
      accuracyMetersX: 0.03, accuracyMetersY: 0.04, accuracyMetersZ: 0.08,
      source: 'exif',
    }], images, 'EPSG:4326')
    expect(prior).toMatchObject({
      z: 120, accuracyX: 0.03, accuracyY: 0.04, accuracyZ: 0.08,
      metricFrame: 'local-geographic',
    })
  })
})

describe('orientationPriorInSfm', () => {
  it('converts nadir OPK into the solver camera basis and preserves axis weights', () => {
    const prior = orientationPriorInSfm({
      omega: 0, phi: 0, kappa: 0,
      accuracyOmega: 1, accuracyPhi: 2, accuracyKappa: 4,
    }, [[1,0,0],[0,1,0],[0,0,1]])
    expect(prior.targetR).toEqual([[1,0,0],[0,-1,0],[0,0,-1]])
    const rad = Math.PI / 180
    expect(prior.orientationPrecision[0][0]).toBeCloseTo(1 / rad ** 2, 6)
    expect(prior.orientationPrecision[1][1]).toBeCloseTo(1 / (2 * rad) ** 2, 6)
    expect(prior.orientationPrecision[2][2]).toBeCloseTo(1 / (4 * rad) ** 2, 6)
    expect(prior.orientationPrecision[0][1]).toBeCloseTo(0, 12)
  })

  it('skips incomplete and gimbal-locked orientations', () => {
    const I = [[1,0,0],[0,1,0],[0,0,1]]
    expect(orientationPriorInSfm({ omega: 0, phi: null, kappa: 0 }, I)).toBeNull()
    expect(orientationPriorInSfm({ omega: 0, phi: 90, kappa: 0 }, I)).toBeNull()
  })
})
