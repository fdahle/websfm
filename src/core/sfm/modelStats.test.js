import { describe, it, expect } from 'vitest'
import { modelResiduals, numStats } from './modelStats.js'
import { projectPoint } from './geometry.js'

const I3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
]
const K = { fx: 1000, fy: 1000, cx: 500, cy: 400 }

// A minimal track store: points with their views (image index, keypoint index).
function model(cams, points) {
  const uuids = cams.map((_, i) => `c${i}`)
  const kps = cams.map(() => [])
  const views = points.map((X) =>
    cams.map((cam, img) => {
      const p = projectPoint(cam, ...X)
      kps[img].push(p.u, p.v)
      return [img, kps[img].length / 2 - 1]
    }),
  )
  return {
    tracks: {
      forEachPoint: (f) => points.forEach((_, i) => f(i)),
      forEachView: (p, f) => views[p].forEach(([img, k]) => f(img, k)),
      x: (p) => points[p][0],
      y: (p) => points[p][1],
      z: (p) => points[p][2],
    },
    cameras: new Map(cams.map((c, i) => [uuids[i], c])),
    ids: { uuid: (i) => uuids[i] },
    images: kps.map((xy) => ({ kp: { xy: Float64Array.from(xy), n: xy.length / 2 } })),
  }
}

describe('modelResiduals', () => {
  const points = [
    [0.3, 0.2, 5],
    [-1.1, 0.9, 6],
    [0.8, -1.3, 4.5],
  ]
  it("is zero for keypoints where the cameras put the points, a rolling shutter's included", () => {
    const rs = { v: [12, -4, 1], h: 800, tau: 0.03 }
    const m = model(
      [
        { R: I3, t: [0, 0, 0], K },
        { R: I3, t: [-1, 0, 0], K, rs },
      ],
      points,
    )
    expect(numStats(modelResiduals(m)).max).toBeLessThan(1e-3)
    // Read as a global shutter, the same keypoints miss by pixels.
    m.cameras.set('c1', { R: I3, t: [-1, 0, 0], K })
    expect(numStats(modelResiduals(m)).max).toBeGreaterThan(1)
  })
})
