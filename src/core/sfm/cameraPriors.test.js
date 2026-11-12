import { describe, expect, it } from 'vitest'
import {
  buildCameraPriors,
  orientationPriorInSfm,
  surveyFrameFor,
  gcpToSurveyFrame,
  surveyGradePositions,
} from './cameraPriors.js'
import { ensureProjection } from '../crs.js'
import { estimatedPose } from './cameraEstimated.js'

const images = [
  { id: 'image-1', uuid: 'uuid-1' },
  { id: 'image-2', uuid: 'uuid-2' },
]

describe('buildCameraPriors', () => {
  it('passes enabled metric 3D EXIF poses and their per-axis accuracies', () => {
    expect(
      buildCameraPriors(
        [
          {
            imageId: 'image-1',
            x: 10,
            y: 20,
            z: 30,
            accuracyX: 1,
            accuracyY: 2,
            accuracyZ: 4,
            source: 'exif',
            enabled: true,
            omega: 1,
            phi: 2,
            kappa: 3,
            accuracyOmega: 0.1,
            accuracyPhi: 0.2,
            accuracyKappa: 0.3,
          },
        ],
        images,
        'EPSG:3857',
      ),
    ).toEqual([
      {
        uuid: 'uuid-1',
        x: 10,
        y: 20,
        z: 30,
        accuracyX: 1,
        accuracyY: 2,
        accuracyZ: 4,
        source: 'exif',
        omega: 1,
        phi: 2,
        kappa: 3,
        accuracyOmega: 0.1,
        accuracyPhi: 0.2,
        accuracyKappa: 0.3,
      },
    ])
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
    const priors = buildCameraPriors(
      [
        { imageId: 'image-1', x: 4, y: 52, z: 100, accuracyX: 5, accuracyY: 6, accuracyZ: 10 },
        { imageId: 'image-2', x: 4.001, y: 52.001, z: 103, accuracyX: 5, accuracyY: 6, accuracyZ: 10 },
      ],
      images,
      'EPSG:4326',
    )

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
    const pts = [
      [1e5, -1e6, 200],
      [1.03e5, -1.002e6, 260],
    ]
    const frame = surveyFrameFor(pts, 'EPSG:3031')
    expect(frame.k).toBeGreaterThan(0.97)
    expect(frame.k).toBeLessThan(1)
    const priors = buildCameraPriors(
      pts.map(([x, y, z], i) => ({
        imageId: `image-${i + 1}`,
        x,
        y,
        z,
        accuracyX: 0.1,
        accuracyY: 0.1,
        accuracyZ: 0.2,
      })),
      images,
      'EPSG:3031',
      { surveyFrame: frame },
    )
    expect(priors[0].metricFrame).toBe('local-projected')
    expect(priors[0].accuracyX).toBeCloseTo(0.1 / frame.k, 9)
    expect(priors[0].accuracyZ).toBe(0.2)
    const g = gcpToSurveyFrame(
      { x: pts[0][0], y: pts[0][1], z: pts[0][2], accuracyX: 0.1, accuracyY: 0.1, accuracyZ: 0.2 },
      frame,
    )
    expect([g.x, g.y, g.z]).toEqual([priors[0].x, priors[0].y, priors[0].z])
    // Ground baseline = grid baseline / k (to first order).
    const ground = Math.hypot(priors[1].x - priors[0].x, priors[1].y - priors[0].y)
    expect(ground).toBeCloseTo(Math.hypot(3e3, 2e3) / frame.k, 0)
    expect(surveyFrameFor(pts, 'EPSG:4326')).toBeNull()
  })

  it('uses canonical metre altitude and accuracies for geographic EXIF poses', () => {
    const [prior] = buildCameraPriors(
      [
        {
          imageId: 'image-1',
          x: 4,
          y: 52,
          z: 999,
          altitudeMeters: 120,
          accuracyX: 99,
          accuracyY: 99,
          accuracyZ: 99,
          accuracyMetersX: 0.03,
          accuracyMetersY: 0.04,
          accuracyMetersZ: 0.08,
          source: 'exif',
        },
      ],
      images,
      'EPSG:4326',
    )
    expect(prior).toMatchObject({
      z: 120,
      accuracyX: 0.03,
      accuracyY: 0.04,
      accuracyZ: 0.08,
      metricFrame: 'local-geographic',
    })
  })
})

describe('orientationPriorInSfm', () => {
  it('converts nadir OPK into the solver camera basis and preserves axis weights', () => {
    const prior = orientationPriorInSfm(
      {
        omega: 0,
        phi: 0,
        kappa: 0,
        accuracyOmega: 1,
        accuracyPhi: 2,
        accuracyKappa: 4,
      },
      [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
    )
    expect(prior.targetR).toEqual([
      [1, 0, 0],
      [0, -1, 0],
      [0, 0, -1],
    ])
    const rad = Math.PI / 180
    expect(prior.orientationPrecision[0][0]).toBeCloseTo(1 / rad ** 2, 6)
    expect(prior.orientationPrecision[1][1]).toBeCloseTo(1 / (2 * rad) ** 2, 6)
    expect(prior.orientationPrecision[2][2]).toBeCloseTo(1 / (4 * rad) ** 2, 6)
    expect(prior.orientationPrecision[0][1]).toBeCloseTo(0, 12)
  })

  const I = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]
  const mul = (A, B) => A.map((r) => B[0].map((_, j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]))
  const T = (A) => A[0].map((_, j) => A.map((r) => r[j]))
  // The rotation vector of a small rotation matrix.
  const logSmall = (R) => [(R[2][1] - R[1][2]) / 2, (R[0][2] - R[2][0]) / 2, (R[1][0] - R[0][1]) / 2]

  it('gives back the rotation of a camera whose pose the export wrote', () => {
    // Any solver camera: its exported omega/phi/kappa must constrain it to itself.
    const c = Math.cos(0.4),
      s = Math.sin(0.4)
    const Rz = [
      [c, -s, 0],
      [s, c, 0],
      [0, 0, 1],
    ]
    const Rx = [
      [1, 0, 0],
      [0, Math.cos(2.9), -Math.sin(2.9)],
      [0, Math.sin(2.9), Math.cos(2.9)],
    ]
    const R = mul(Rx, Rz)
    const pose = estimatedPose({ R, t: [1, 2, 3] })
    const prior = orientationPriorInSfm(pose, I)
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(prior.targetR[i][j]).toBeCloseTo(R[i][j], 12)
  })

  it('weights each angle along the rotation that angle makes', () => {
    // A step in one angle moves the solver rotation by δ; δᵀ·P·δ must be that angle's
    // weight, and the cross terms between angles zero.
    const pose = { omega: 12, phi: -25, kappa: 140, accuracyOmega: 1, accuracyPhi: 2, accuracyKappa: 4 }
    const { targetR, orientationPrecision: P } = orientationPriorInSfm(pose, I)
    const h = 1e-6
    const deltas = ['omega', 'phi', 'kappa'].map((k) => {
      const moved = orientationPriorInSfm({ ...pose, [k]: pose[k] + (h * 180) / Math.PI }, I).targetR
      return logSmall(mul(moved, T(targetR))).map((v) => v / h)
    })
    const rad = Math.PI / 180
    const w = [1, 2, 4].map((sd) => 1 / (sd * rad) ** 2)
    const q = (a, b) => a.reduce((sum, ai, i) => sum + ai * P[i].reduce((t, pij, j) => t + pij * b[j], 0), 0)
    for (let i = 0; i < 3; i++) {
      expect(q(deltas[i], deltas[i]) / w[i]).toBeCloseTo(1, 4)
      for (let j = i + 1; j < 3; j++) expect(Math.abs(q(deltas[i], deltas[j])) / w[0]).toBeLessThan(1e-4)
    }
  })

  it('skips incomplete and gimbal-locked orientations', () => {
    expect(orientationPriorInSfm({ omega: 0, phi: null, kappa: 0 }, I)).toBeNull()
    expect(orientationPriorInSfm({ omega: 0, phi: 90, kappa: 0 }, I)).toBeNull()
  })
})

describe('surveyGradePositions', () => {
  const at = (sx, sy, sz) => ({ accuracyX: sx, accuracyY: sy, accuracyZ: sz })
  it('holds a block whose RTK positions are within the limit on every axis', () => {
    expect(surveyGradePositions([at(0.02, 0.02, 0.04), at(0.03, 0.03, 0.05), at(0.02, 0.02, 0.03)], 0.1)).toEqual({
      held: true,
      surveyGrade: 3,
      total: 3,
    })
  })
  it('does not hold it with consumer GNSS or with no accuracies (the 5 m default)', () => {
    expect(surveyGradePositions([at(3, 3, 6), at(3, 3, 6), at(3, 3, 6)], 0.1).held).toBe(false)
    expect(surveyGradePositions([{}, {}, {}], 0.1).held).toBe(false)
  })
  it('needs every axis: a precise plan position with a loose height is not survey grade', () => {
    expect(surveyGradePositions([at(0.02, 0.02, 2), at(0.02, 0.02, 2), at(0.02, 0.02, 2)], 0.1).surveyGrade).toBe(0)
  })
  it('needs half the priors and the minimum count', () => {
    const rtk = at(0.02, 0.02, 0.04)
    const gps = at(3, 3, 6)
    expect(surveyGradePositions([rtk, rtk, rtk, gps, gps], 0.1).held).toBe(true)
    expect(surveyGradePositions([rtk, rtk, rtk, gps, gps, gps, gps], 0.1).held).toBe(false)
    expect(surveyGradePositions([rtk, rtk], 0.1, 3).held).toBe(false)
    expect(surveyGradePositions([], 0.1).held).toBe(false)
  })
})
