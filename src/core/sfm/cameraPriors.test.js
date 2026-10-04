import { describe, expect, it } from 'vitest'
import { buildCameraPriors, orientationPriorInSfm, surveyFrameFor, gcpToSurveyFrame } from './cameraPriors.js'
import { ensureProjection } from '../crs.js'

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
    // Heights carry the curvature drop d²/(2R) about the frame centre (~0.3 mm here).
    priors.forEach((prior, i) => expect(prior.z).toBeCloseTo([100, 103][i], 2))
    expect(priors[0]).toMatchObject({ accuracyX: 5, accuracyY: 6, accuracyZ: 10 })
  })

  it('moves projected poses and GCPs into one shared survey frame (σ_h / k)', async () => {
    await ensureProjection('EPSG:3031')
    const pts = [[1e5, -1e6, 200], [1.03e5, -1.002e6, 260]]
    const frame = surveyFrameFor(pts, 'EPSG:3031')
    expect(frame.k).toBeGreaterThan(0.97)
    expect(frame.k).toBeLessThan(1)
    const priors = buildCameraPriors(pts.map(([x, y, z], i) => ({
      imageId: `image-${i + 1}`, x, y, z, accuracyX: 0.1, accuracyY: 0.1, accuracyZ: 0.2 })),
    images, 'EPSG:3031', { surveyFrame: frame })
    expect(priors[0].metricFrame).toBe('local-projected')
    expect(priors[0].accuracyX).toBeCloseTo(0.1 / frame.k, 9)
    expect(priors[0].accuracyZ).toBe(0.2)
    const g = gcpToSurveyFrame({ x: pts[0][0], y: pts[0][1], z: pts[0][2], accuracyX: 0.1, accuracyY: 0.1, accuracyZ: 0.2 }, frame)
    expect([g.x, g.y, g.z]).toEqual([priors[0].x, priors[0].y, priors[0].z])
    // Ground baseline = grid baseline / k (to first order).
    const ground = Math.hypot(priors[1].x - priors[0].x, priors[1].y - priors[0].y)
    expect(ground).toBeCloseTo(Math.hypot(3e3, 2e3) / frame.k, 0)
    expect(surveyFrameFor(pts, 'EPSG:4326')).toBeNull()
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
