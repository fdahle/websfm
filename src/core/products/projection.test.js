import { describe, it, expect } from 'vitest'
import {
  estimateUpFromViewingDirs, estimateUpFromCloud, buildLocalFrame, makeFrame,
  aerialUpRotation, rotateReconstruction,
} from './projection.js'

// A nadir camera at height `h` looking straight down: for a world-down viewing
// direction of [0,0,-1] (camera looks toward −Z, i.e. ground below), the world
// "up" is [0,0,1]. With x_cam = R·x_world + t and the optical axis = third row of
// R, a camera whose third row is [0,0,-1] looks down −Z.
function nadirCam(cx, cy, cz) {
  // R rows: x_cam→world-x, y_cam→world-(−y), z_cam(optical)→world −Z.
  const R = [[1, 0, 0], [0, -1, 0], [0, 0, -1]]
  // t = -R·C
  const t = [
    -(R[0][0] * cx + R[0][1] * cy + R[0][2] * cz),
    -(R[1][0] * cx + R[1][1] * cy + R[1][2] * cz),
    -(R[2][0] * cx + R[2][1] * cy + R[2][2] * cz),
  ]
  return { R, t }
}

const close = (a, b, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps)

describe('estimateUpFromViewingDirs', () => {
  it('recovers +Z up from a nadir flight strip looking down −Z', () => {
    const cams = [nadirCam(0, 0, 10), nadirCam(5, 0, 10), nadirCam(10, 2, 10)]
    const up = estimateUpFromViewingDirs(cams)
    close(up[0], 0); close(up[1], 0); close(up[2], 1)
  })

  it('returns null when viewing directions cancel (convergent rig)', () => {
    // Two cameras looking at each other along ±Z → mean viewing dir ≈ 0.
    const a = nadirCam(0, 0, 0)          // looks −Z
    const b = { R: [[1, 0, 0], [0, -1, 0], [0, 0, 1]], t: [0, 0, 0] } // looks +Z
    expect(estimateUpFromViewingDirs([a, b])).toBeNull()
  })
})

describe('estimateUpFromCloud', () => {
  it('finds the normal of a near-planar cloud (ground plane z≈0)', () => {
    const pts = []
    for (let i = 0; i < 40; i++) {
      pts.push({ x: Math.cos(i), y: Math.sin(i * 1.3), z: 0.001 * ((i % 5) - 2) })
    }
    const up = estimateUpFromCloud(pts, [0, 0, 1])
    close(Math.abs(up[2]), 1, 1e-3)
  })

  it('honours the sign hint', () => {
    const pts = []
    for (let i = 0; i < 40; i++) pts.push({ x: Math.cos(i), y: Math.sin(i), z: 0 })
    const up = estimateUpFromCloud(pts, [0, 0, -1])
    expect(up[2]).toBeLessThan(0)
  })
})

describe('buildLocalFrame', () => {
  it('fromSfm/toSfm are exact inverses', () => {
    const frame = buildLocalFrame([nadirCam(0, 0, 10), nadirCam(4, 1, 10)], [
      { x: 0, y: 0, z: 0 }, { x: 1, y: 2, z: 0.5 }, { x: -1, y: 1, z: -0.2 },
    ])
    const p = [3.5, -2.1, 0.9]
    const round = frame.toSfm(frame.fromSfm(p))
    close(round[0], p[0]); close(round[1], p[1]); close(round[2], p[2])
  })

  it('maps the estimated up direction to +local-Z (height)', () => {
    const frame = buildLocalFrame([nadirCam(0, 0, 10), nadirCam(5, 0, 10)], [
      { x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, { x: 0, y: 2, z: 0 },
    ])
    // A point directly "up" from the origin (world +Z) should get a positive,
    // dominant local-Z and near-zero local-XY.
    const local = frame.fromSfm([frame.origin[0], frame.origin[1], frame.origin[2] + 3])
    close(local[0], 0); close(local[1], 0); close(local[2], 3)
  })

  it('produces a right-handed orthonormal basis', () => {
    const { east, north, up } = buildLocalFrame([nadirCam(1, 1, 8)], [
      { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }, { x: 2, y: 0, z: 0 },
    ])
    const d = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    close(d(east, north), 0); close(d(east, up), 0); close(d(north, up), 0)
    close(d(east, east), 1); close(d(up, up), 1)
    // east × north = up
    const cx = [east[1] * north[2] - east[2] * north[1],
      east[2] * north[0] - east[0] * north[2],
      east[0] * north[1] - east[1] * north[0]]
    close(cx[0], up[0]); close(cx[1], up[1]); close(cx[2], up[2])
  })
})

// Camera centre C = -Rᵀt from a { R, t } pose.
function centre({ R, t }) {
  return [
    -(R[0][0] * t[0] + R[1][0] * t[1] + R[2][0] * t[2]),
    -(R[0][1] * t[0] + R[1][1] * t[1] + R[2][1] * t[2]),
    -(R[0][2] * t[0] + R[1][2] * t[1] + R[2][2] * t[2]),
  ]
}

describe('aerial Z-up orientation', () => {
  // A "flipped" aerial reconstruction: cameras BELOW the ground (negative Z),
  // looking UP (+Z) — the classic SfM gauge/flip ambiguity. Identity R looks +Z.
  function upsideDownCam(cx, cy, cz) {
    const R = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
    return { R, t: [-cx, -cy, -cz] } // t = -R·C, R = I
  }

  it('lifts cameras above the ground for a flipped aerial block', () => {
    const cams = new Map([
      ['a', upsideDownCam(0, 0, -10)],
      ['b', upsideDownCam(5, 0, -10)],
      ['c', upsideDownCam(2, 4, -10)],
    ])
    const pts = [
      { x: 0, y: 0, z: 0, color: [1, 2, 3], views: new Map([['a', 7]]) },
      { x: 4, y: 1, z: 0 }, { x: 1, y: 3, z: 0 },
    ]
    // Before: cameras sit below the points (z = -10 < 0).
    for (const c of cams.values()) expect(centre(c)[2]).toBeLessThan(0)

    const R = aerialUpRotation(cams)
    expect(R).not.toBeNull()
    const out = rotateReconstruction(cams, pts, R)

    // After: every camera is above the mean ground height.
    const groundZ = out.points.reduce((s, p) => s + p.z, 0) / out.points.length
    for (const c of out.cameras.values()) expect(centre(c)[2]).toBeGreaterThan(groundZ)
  })

  it('preserves intrinsics, colour and view-tracks', () => {
    const cams = new Map([['a', { R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 10], K: { fx: 900 } }]])
    const pts = [{ x: 1, y: 2, z: 3, color: [10, 20, 30], views: new Map([['a', 5]]) }]
    const R = [[0, -1, 0], [1, 0, 0], [0, 0, 1]] // 90° about Z
    const out = rotateReconstruction(cams, pts, R)
    expect(out.cameras.get('a').K).toEqual({ fx: 900 })
    expect(out.points[0].color).toEqual([10, 20, 30])
    expect(out.points[0].views.get('a')).toBe(5)
    // p'=R·p: (1,2,3) → (-2,1,3)
    expect([out.points[0].x, out.points[0].y, out.points[0].z]).toEqual([-2, 1, 3])
  })

  it('can rotate an owned result without allocating a second point array', () => {
    const cams = new Map([['a', { R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 0], K: {} }]])
    const pts = [{ x: 1, y: 2, z: 3 }]
    const out = rotateReconstruction(cams, pts, [[0, -1, 0], [1, 0, 0], [0, 0, 1]], { inPlace: true })
    expect(out.points).toBe(pts)
    expect(pts[0]).toEqual({ x: -2, y: 1, z: 3 })
  })

  it('returns null for a convergent rig (no coherent up)', () => {
    const cams = new Map([
      ['a', { R: [[1, 0, 0], [0, -1, 0], [0, 0, -1]], t: [0, 0, 0] }], // looks −Z
      ['b', { R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 0] }],   // looks +Z
    ])
    expect(aerialUpRotation(cams)).toBeNull()
  })
})

describe('makeFrame', () => {
  it('is a plain translation+rotation for an axis-aligned basis', () => {
    const frame = makeFrame({
      origin: [10, 20, 30], east: [1, 0, 0], north: [0, 1, 0], up: [0, 0, 1],
    })
    expect(frame.fromSfm([12, 23, 35])).toEqual([2, 3, 5])
    expect(frame.toSfm([2, 3, 5])).toEqual([12, 23, 35])
  })
})
