import { describe, it, expect } from 'vitest'
import { estimatedIntrinsics, estimatedCenter, estimatedPose } from './cameraEstimated.js'
import { orientationPriorInSfm } from './cameraPriors.js'

const mulM3 = (A, B) => A.map((row) => B[0].map((_, c) => row.reduce((s, v, k) => s + v * B[k][c], 0)))

const I3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
]

describe('estimatedIntrinsics', () => {
  it('pulls focal / principal point out of K', () => {
    const cam = { K: { fx: 1000, fy: 1010, cx: 320, cy: 240 } }
    expect(estimatedIntrinsics(cam)).toEqual({
      focal: 1000,
      focalY: 1010,
      cx: 320,
      cy: 240,
    })
  })

  it('returns null when the camera has no K', () => {
    expect(estimatedIntrinsics({})).toBeNull()
    expect(estimatedIntrinsics(null)).toBeNull()
  })
})

describe('estimatedCenter', () => {
  it('is -t for identity rotation', () => {
    expect(estimatedCenter({ R: I3, t: [1, 2, 3] })).toEqual([-1, -2, -3])
  })

  it('computes C = -Rᵀt', () => {
    const R = [
      [0, -1, 0],
      [1, 0, 0],
      [0, 0, 1],
    ]
    const C = estimatedCenter({ R, t: [1, 0, 0] })
    expect(C[0]).toBeCloseTo(0, 10)
    expect(C[1]).toBeCloseTo(1, 10)
    expect(C[2]).toBeCloseTo(0, 10)
  })

  it('returns null without R or t', () => {
    expect(estimatedCenter({ R: I3 })).toBeNull()
    expect(estimatedCenter(null)).toBeNull()
  })
})

describe('estimatedPose', () => {
  it('turns the solver camera into photogrammetric angles', () => {
    // Identity: the solver camera looks along +z, so a photo camera looking up.
    const p = estimatedPose({ R: I3, t: [0, 0, 0] })
    expect(p.omega).toBeCloseTo(180, 10)
    expect(p.phi).toBeCloseTo(0, 10)
    expect(p.kappa).toBeCloseTo(0, 10)
  })

  it('gives back the pose a pose import would have constrained the camera to', () => {
    const a = (30 * Math.PI) / 180
    // A similarity model → CRS with a rotation about a tilted axis.
    const fitR = mulM3(
      [
        [Math.cos(a), -Math.sin(a), 0],
        [Math.sin(a), Math.cos(a), 0],
        [0, 0, 1],
      ],
      [
        [1, 0, 0],
        [0, Math.cos(0.2), -Math.sin(0.2)],
        [0, Math.sin(0.2), Math.cos(0.2)],
      ],
    )
    const sim = { scale: 2.5, R: fitR, t: [500000, 6000000, 100] }
    const pose = { omega: 4, phi: -7, kappa: 123 }
    const R = orientationPriorInSfm(pose, fitR).targetR
    const C = [500120, 6000340, 450]
    // The model-frame centre the similarity maps onto C, and t = −R·C.
    const d = C.map((v, i) => (v - sim.t[i]) / sim.scale)
    const Cm = [0, 1, 2].map((j) => fitR[0][j] * d[0] + fitR[1][j] * d[1] + fitR[2][j] * d[2])
    const t = R.map((row) => -(row[0] * Cm[0] + row[1] * Cm[1] + row[2] * Cm[2]))

    const out = estimatedPose({ R, t }, sim)
    expect(out.x).toBeCloseTo(C[0], 6)
    expect(out.y).toBeCloseTo(C[1], 6)
    expect(out.z).toBeCloseTo(C[2], 6)
    expect(out.omega).toBeCloseTo(4, 9)
    expect(out.phi).toBeCloseTo(-7, 9)
    expect(out.kappa).toBeCloseTo(123, 9)
  })

  it('returns null without a pose', () => {
    expect(estimatedPose({})).toBeNull()
    expect(estimatedPose(null)).toBeNull()
  })
})
