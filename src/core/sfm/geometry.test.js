import { describe, it, expect } from 'vitest'
import {
  cameraCenter,
  projectPoint,
  projectWithDepth,
  triangulationAngle,
  medianTriangulationAngle,
  scaleK,
  rgbaToGray,
  estimateUpFromCameras,
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

describe('estimateUpFromCameras', () => {
  it('returns null with fewer than 2 cameras', () => {
    expect(estimateUpFromCameras([])).toBeNull()
    expect(estimateUpFromCameras([{ R: I3 }])).toBeNull()
  })

  it('recovers world +Y up for upright cameras (identity R)', () => {
    // Identity R: image-y (down) = world +Y, so estimated up = world -Y.
    const up = estimateUpFromCameras([{ R: I3 }, { R: I3 }])
    expect(up[0]).toBeCloseTo(0, 10)
    expect(up[1]).toBeCloseTo(-1, 10)
    expect(up[2]).toBeCloseTo(0, 10)
  })

  it('recovers up for a Z-up rig looking along +Y (image-down = world -Z)', () => {
    // Camera looks +Y (world), x-right = +X, image-y (down) = world -Z.
    // world→cam rows: x_cam=+X, y_cam=-Z, z_cam(view)=+Y.
    const R = [[1, 0, 0], [0, 0, -1], [0, 1, 0]]
    const up = estimateUpFromCameras([{ R }, { R }])
    // up = -(row 1) = -(0,0,-1) = (0,0,1) → world +Z.
    expect(up[0]).toBeCloseTo(0, 10)
    expect(up[1]).toBeCloseTo(0, 10)
    expect(up[2]).toBeCloseTo(1, 10)
  })

  it('averages a small roll away and returns a unit vector', () => {
    // Two cameras rolled ±θ about the view axis average back to straight up.
    const th = 0.2
    const c = Math.cos(th), s = Math.sin(th)
    const Rp = [[c, -s, 0], [s, c, 0], [0, 0, 1]]
    const Rm = [[c, s, 0], [-s, c, 0], [0, 0, 1]]
    const up = estimateUpFromCameras([{ R: Rp }, { R: Rm }])
    expect(Math.hypot(up[0], up[1], up[2])).toBeCloseTo(1, 10)
    expect(up[0]).toBeCloseTo(0, 10)  // rolls cancel
    expect(up[1]).toBeCloseTo(-1, 10)
  })

  it('accepts a Map of cameras', () => {
    const m = new Map([['a', { R: I3 }], ['b', { R: I3 }]])
    expect(estimateUpFromCameras(m)).not.toBeNull()
  })

  // A nadir camera at (cx,cy,cz) looking down world −Z. Its image-up axis is
  // horizontal (+Y here), so the image-axis mean alone would return a sideways up.
  const nadirCam = (cx, cy, cz) => {
    const R = [[1, 0, 0], [0, -1, 0], [0, 0, -1]]
    return { R, t: [-cx, cy, cz] } // t = -R·C
  }

  it('prefers the viewing-direction up for a nadir aerial block', () => {
    const cams = []
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) cams.push(nadirCam(i * 20, j * 20, 500))
    }
    const up = estimateUpFromCameras(cams)
    expect(up[0]).toBeCloseTo(0, 6)
    expect(up[1]).toBeCloseTo(0, 6)
    expect(up[2]).toBeCloseTo(1, 6) // world +Z, not the sideways image axis
  })

  it('keeps the image-up axis for a horizontal terrestrial strip', () => {
    // Cameras walking along +X at constant height, all looking at a wall (+Y).
    // world→cam rows: x_cam=+X, y_cam(down)=-Z, z_cam(view)=+Y.
    const R = [[1, 0, 0], [0, 0, -1], [0, 1, 0]]
    const cams = []
    for (let i = 0; i < 6; i++) cams.push({ R, t: [-i * 2, 0, 0] })
    const up = estimateUpFromCameras(cams)
    expect(up[2]).toBeCloseTo(1, 6) // +Z from the image axes; view-dir up would be -Y
  })

  it('ignores the baseline when the centres are a tight cluster', () => {
    const cams = [{ R: I3, t: [0, 0, 0] }, { R: I3, t: [0, 0, 0] }]
    const up = estimateUpFromCameras(cams)
    expect(up[1]).toBeCloseTo(-1, 6)
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
