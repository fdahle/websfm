import { describe, it, expect } from 'vitest'
import {
  cameraCenter,
  projectPoint,
  projectWithDepth,
  triangulationAngle,
  medianTriangulationAngle,
  scaleK,
  rgbaToGray,
} from './geometry.js'

const I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
const K = { fx: 100, fy: 100, cx: 320, cy: 240 }

describe('cameraCenter', () => {
  it('is -t for identity rotation', () => {
    expect(cameraCenter({ R: I3, t: [1, 2, 3] })).toEqual([-1, -2, -3])
  })

  it('computes C = -Rᵀt for a 90° rotation about z', () => {
    // R rotates world→camera; row-major.
    const R = [[0, -1, 0], [1, 0, 0], [0, 0, 1]]
    const t = [1, 0, 0]
    // C = -Rᵀt: Rᵀ = [[0,1,0],[-1,0,0],[0,0,1]], Rᵀt = [0,-1,0], C = [0,1,0].
    const C = cameraCenter({ R, t })
    expect(C[0]).toBeCloseTo(0, 10)
    expect(C[1]).toBeCloseTo(1, 10)
    expect(C[2]).toBeCloseTo(0, 10)
  })
})

describe('projectPoint', () => {
  it('maps a point on the optical axis to the principal point', () => {
    const cam = { R: I3, t: [0, 0, 5], K }
    expect(projectPoint(cam, 0, 0, 0)).toEqual({ u: 320, v: 240 })
  })

  it('applies the pinhole scaling for an off-axis point', () => {
    const cam = { R: I3, t: [0, 0, 10], K }
    // world (1,0,0) → xc=1, zc=10 → u = 100*0.1 + 320 = 330
    expect(projectPoint(cam, 1, 0, 0)).toMatchObject({ u: 330, v: 240 })
  })

  it('returns null when the point lies on the camera plane (zc ≈ 0)', () => {
    const cam = { R: I3, t: [0, 0, 0], K }
    expect(projectPoint(cam, 0, 0, 0)).toBeNull()
  })

  it('still projects a point behind the camera (negative depth)', () => {
    const cam = { R: I3, t: [0, 0, -5], K }
    expect(projectPoint(cam, 0, 0, 0)).toEqual({ u: 320, v: 240 })
  })
})

describe('projectWithDepth', () => {
  it('returns the pixel and positive depth for a point in front', () => {
    const cam = { R: I3, t: [0, 0, 5], K }
    expect(projectWithDepth(cam, 0, 0, 0)).toEqual({ u: 320, v: 240, depth: 5 })
  })

  it('returns null for a point behind the camera', () => {
    const cam = { R: I3, t: [0, 0, -5], K }
    expect(projectWithDepth(cam, 0, 0, 0)).toBeNull()
  })
})

describe('triangulationAngle', () => {
  it('is 90° for perpendicular viewing rays', () => {
    // p at origin; ray to Ca is -x, ray to Cb is -y → perpendicular.
    const angle = triangulationAngle([1, 0, 0], [0, 1, 0], { x: 0, y: 0, z: 0 })
    expect(angle).toBeCloseTo(90, 6)
  })

  it('is ~0° for collinear camera centres', () => {
    const angle = triangulationAngle([1, 0, 0], [2, 0, 0], { x: 0, y: 0, z: 0 })
    expect(angle).toBeCloseTo(0, 6)
  })

  it('is 0 when a camera centre coincides with the point', () => {
    expect(triangulationAngle([0, 0, 0], [1, 0, 0], { x: 0, y: 0, z: 0 })).toBe(0)
  })
})

describe('medianTriangulationAngle', () => {
  const camA = { R: I3, t: [-1, 0, 0] } // centre [1,0,0]
  const camB = { R: I3, t: [0, -1, 0] } // centre [0,1,0]

  it('takes the median parallax over the points', () => {
    const pts = [{ x: 0, y: 0, z: 0 }]
    expect(medianTriangulationAngle(camA, camB, pts)).toBeCloseTo(90, 6)
  })

  it('returns 0 for an empty point set', () => {
    expect(medianTriangulationAngle(camA, camB, [])).toBe(0)
  })

  it('picks the upper-middle element for an even count', () => {
    // Two points with distinct angles; median index = len>>1 = 1 (the larger).
    const near = { x: 0.5, y: 0.5, z: 0 } // between the centres → wide angle
    const far = { x: 0, y: 0, z: 100 }    // far away → narrow angle
    const m = medianTriangulationAngle(camA, camB, [near, far])
    const a1 = triangulationAngle([1, 0, 0], [0, 1, 0], near)
    const a2 = triangulationAngle([1, 0, 0], [0, 1, 0], far)
    expect(m).toBeCloseTo(Math.max(a1, a2), 6)
  })
})

describe('scaleK', () => {
  it('scales every intrinsic component', () => {
    expect(scaleK({ fx: 100, fy: 200, cx: 320, cy: 240 }, 0.5))
      .toEqual({ fx: 50, fy: 100, cx: 160, cy: 120 })
  })
})

describe('rgbaToGray', () => {
  it('applies Rec. 601 luma weights', () => {
    const data = new Uint8Array([255, 255, 255, 255, 255, 0, 0, 255])
    const gray = rgbaToGray(data, 2, 1)
    expect(gray[0]).toBe(255)
    expect(gray[1]).toBe((255 * 0.299) | 0) // 76
  })

  it('produces a w*h Uint8Array', () => {
    const gray = rgbaToGray(new Uint8Array(3 * 4), 3, 1)
    expect(gray).toBeInstanceOf(Uint8Array)
    expect(gray).toHaveLength(3)
  })
})
