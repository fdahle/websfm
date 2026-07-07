import { describe, it, expect } from 'vitest'
import {
  estimatedIntrinsics,
  estimatedCenter,
  estimatedAngles,
} from './cameraEstimated.js'

const I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]

describe('estimatedIntrinsics', () => {
  it('pulls focal / principal point out of K', () => {
    const cam = { K: { fx: 1000, fy: 1010, cx: 320, cy: 240 } }
    expect(estimatedIntrinsics(cam)).toEqual({
      focal: 1000, focalY: 1010, cx: 320, cy: 240,
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
    const R = [[0, -1, 0], [1, 0, 0], [0, 0, 1]]
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

describe('estimatedAngles', () => {
  it('is all-zero for the identity rotation', () => {
    const { omega, phi, kappa } = estimatedAngles({ R: I3 })
    expect(omega).toBeCloseTo(0, 10)
    expect(phi).toBeCloseTo(0, 10)
    expect(kappa).toBeCloseTo(0, 10)
  })

  it('recovers a pure kappa (yaw) rotation about z', () => {
    // Rz(κ) with κ=90°: [[0,-1,0],[1,0,0],[0,0,1]] → kappa = -atan2(-R01,R00) → 90.
    const R = [[0, -1, 0], [1, 0, 0], [0, 0, 1]]
    const { omega, phi, kappa } = estimatedAngles({ R })
    expect(omega).toBeCloseTo(0, 6)
    expect(phi).toBeCloseTo(0, 6)
    expect(kappa).toBeCloseTo(90, 6)
  })

  it('returns null without a rotation matrix', () => {
    expect(estimatedAngles({})).toBeNull()
    expect(estimatedAngles(null)).toBeNull()
  })
})
