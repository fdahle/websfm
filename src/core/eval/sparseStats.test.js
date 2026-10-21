import { describe, it, expect } from 'vitest'
import { sparseResidualStats, sparseModelStats, sparseCoverage } from './sparseStats.js'
import { reprojectionStats, trackLengthHistogram } from './reconStats.js'
import { perImageResiduals } from './imageStats.js'
import { coverageGrid } from './coverage.js'
import { cameraCenter } from '../sfm/geometry.js'
import { SparsePoints } from '../sfm/sparsePoints.js'

// Deterministic pseudo-random model: cameras looking down +z at a point slab, with
// noisy observations, an observation of an image outside the model, a point behind
// a camera and a point without viewsPx — every branch the reference functions skip.
function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}
function model() {
  const rand = rng(7)
  const cameras = new Map()
  for (let c = 0; c < 6; c++) {
    cameras.set(`cam${c}`, {
      R: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      t: [-c * 0.5, 0.2 * c, 5],
      K: { fx: 800, fy: 800, cx: 320, cy: 240 },
    })
  }
  cameras.set('lonely', {
    R: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    t: [0, 0, 5],
    K: { fx: 800, fy: 800, cx: 320, cy: 240 },
  })
  const points = []
  for (let i = 0; i < 400; i++) {
    const x = rand() * 4 - 2,
      y = rand() * 3 - 1.5,
      z = rand() * 2 - 1
    const views = new Map(),
      viewsPx = new Map()
    for (let c = 0; c < 6; c++) {
      if (rand() < 0.4) continue
      views.set(`cam${c}`, i)
      viewsPx.set(`cam${c}`, [320 + rand() * 200, 240 + rand() * 200])
    }
    if (i % 50 === 0) {
      views.set('not-loaded', 0)
      viewsPx.set('not-loaded', [1, 2])
    }
    points.push({ x, y, z: i === 3 ? -50 : z, views, viewsPx: i === 5 ? undefined : viewsPx })
  }
  return { cameras, points: SparsePoints.fromRecords(points) }
}

describe('sparseResidualStats', () => {
  it('matches reprojectionStats and perImageResiduals exactly', () => {
    const { cameras, points } = model()
    const { reproj, perImage } = sparseResidualStats(cameras, points)
    expect(reproj.n).toBeGreaterThan(500) // not vacuous
    expect(reproj).toEqual(reprojectionStats(cameras, points))
    expect(perImage).toEqual(perImageResiduals(cameras, points))
    expect(perImage.find((r) => r.uuid === 'lonely')).toEqual({
      uuid: 'lonely',
      nObs: 0,
      rmsPx: null,
      medianPx: null,
      maxPx: null,
    })
  })

  it('handles an empty model', () => {
    const cameras = new Map([
      [
        'a',
        {
          R: [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
          ],
          t: [0, 0, 0],
          K: { fx: 1, fy: 1, cx: 0, cy: 0 },
        },
      ],
    ])
    const empty = SparsePoints.empty()
    expect(sparseResidualStats(cameras, empty)).toEqual({
      reproj: reprojectionStats(cameras, empty),
      perImage: perImageResiduals(cameras, empty),
    })
  })
})

describe('sparseCoverage', () => {
  it('equals coverageGrid over the points and camera centres', () => {
    const { cameras, points } = model()
    const cams = [...cameras.values()]
      .map(cameraCenter)
      .filter(Boolean)
      .map((c) => ({ x: c[0], y: c[1] }))
    expect(sparseCoverage(cameras, points)).toEqual(coverageGrid(points, cams, { targetCells: 64 }))
  })
})

describe('sparseModelStats', () => {
  it('computes once per model identity and lazily per field', () => {
    const { cameras, points } = model()
    const a = sparseModelStats(cameras, points)
    expect(sparseModelStats(cameras, points)).toBe(a)
    const reproj = a.reproj
    expect(a.reproj).toBe(reproj)
    expect(a.perImage).toBe(a.perImage)
    expect(a.histogram).toEqual(trackLengthHistogram(points))
  })

  it('a different cameras Map or point list is a different model', () => {
    const { cameras, points } = model()
    const a = sparseModelStats(cameras, points)
    expect(sparseModelStats(new Map(cameras), points)).not.toBe(a)
    expect(sparseModelStats(cameras, points.withPositions(points.pos.slice()))).not.toBe(a)
    // Grow the same instance by one point (clouds are immutable by contract; this
    // forces it to exercise the guard).
    Object.assign(points, SparsePoints.concat([points, SparsePoints.fromRecords([{ x: 0, y: 0, z: 0 }])]))
    expect(points.length).toBe(401)
    expect(sparseModelStats(cameras, points)).not.toBe(a) // count guard
  })
})
