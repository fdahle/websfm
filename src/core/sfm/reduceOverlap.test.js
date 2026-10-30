import { describe, it, expect } from 'vitest'

import { overlapVisibility, chooseOverlapSubset } from './reduceOverlap.js'
import { SparsePoints } from './sparsePoints.js'

// A nadir block: 8 × 8 cameras 100 m up, 20 m apart, each seeing a 200 m square (an
// overlap of 90 %), over a flat field of points; each point's track names the two
// nearest cameras, as matching might.
const I = [
  [1, 0, 0],
  [0, -1, 0],
  [0, 0, -1],
]
function block() {
  const cameras = []
  for (let i = 0; i < 8; i++)
    for (let j = 0; j < 8; j++) {
      const C = [i * 20, j * 20, 100]
      // t = −R·C, looking straight down.
      const t = I.map((row) => -(row[0] * C[0] + row[1] * C[1] + row[2] * C[2]))
      cameras.push({ uuid: `c${i}-${j}`, R: I, t, K: { fx: 100, fy: 100, cx: 100, cy: 100 }, width: 200, height: 200 })
    }
  const pos = [],
    vcount = [],
    vcam = []
  for (let x = 0; x <= 140; x += 7)
    for (let y = 0; y <= 140; y += 7) {
      pos.push(x, y, 0)
      const near = cameras
        .map((c, k) => [
          Math.hypot(Number(c.uuid.split('-')[0].slice(1)) * 20 - x, Number(c.uuid.split('-')[1]) * 20 - y),
          k,
        ])
        .sort((a, b) => a[0] - b[0] || a[1] - b[1])
        .slice(0, 2)
      vcount.push(2)
      vcam.push(near[0][1], near[1][1])
    }
  const points = new SparsePoints({
    pos: Float64Array.from(pos),
    viewUuids: cameras.map((c) => c.uuid),
    vcount: Uint32Array.from(vcount),
    vcam: Uint32Array.from(vcam),
    vkp: new Uint32Array(vcam.length),
  })
  return { cameras, points }
}

describe('reduceOverlap', () => {
  it('sees each point from every camera whose frame holds it, not just its track', () => {
    const { cameras, points } = block()
    const vis = overlapVisibility(points, cameras)
    expect(vis.points).toBe(points.length)
    const counts = Array.from({ length: vis.points }, (_, p) => vis.pstart[p + 1] - vis.pstart[p])
    expect(Math.min(...counts)).toBeGreaterThan(2)
    expect(Math.max(...counts)).toBeGreaterThan(20)
  })

  it('keeps every point in min(coverage, its photos), with fewer photos, the same way each time', () => {
    const { cameras, points } = block()
    const vis = overlapVisibility(points, cameras)
    for (const coverage of [3, 6]) {
      const keep = chooseOverlapSubset(vis, cameras.length, { coverage })
      const kept = keep.reduce((a, b) => a + b, 0)
      expect(kept).toBeLessThan(cameras.length)
      expect(kept).toBeGreaterThan(0)
      for (let p = 0; p < vis.points; p++) {
        const all = vis.pstart[p + 1] - vis.pstart[p]
        let left = 0
        for (let k = vis.pstart[p]; k < vis.pstart[p + 1]; k++) left += keep[vis.pcam[k]]
        expect(left).toBeGreaterThanOrEqual(Math.min(coverage, all))
      }
      expect(chooseOverlapSubset(vis, cameras.length, { coverage })).toEqual(keep)
    }
    const k3 = chooseOverlapSubset(vis, cameras.length, { coverage: 3 }).reduce((a, b) => a + b, 0)
    const k6 = chooseOverlapSubset(vis, cameras.length, { coverage: 6 }).reduce((a, b) => a + b, 0)
    expect(k6).toBeGreaterThan(k3)
  })

  it('keeps a camera that is the only one to see a point', () => {
    const vis = { points: 2, pstart: Uint32Array.of(0, 1, 3), pcam: Uint32Array.of(0, 1, 2) }
    expect([...chooseOverlapSubset(vis, 3, { coverage: 1 })]).toEqual([1, 0, 1])
  })

  it('does not count a camera on the far side of the surface', () => {
    const { cameras, points } = block()
    // A camera under the field, looking up at it.
    const up = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]
    const C = [70, 70, -100]
    const t = up.map((row) => -(row[0] * C[0] + row[1] * C[1] + row[2] * C[2]))
    const below = { uuid: 'below', R: up, t, K: { fx: 100, fy: 100, cx: 100, cy: 100 }, width: 200, height: 200 }
    const vis = overlapVisibility(points, [...cameras, below])
    expect([...vis.pcam].includes(cameras.length)).toBe(false)
    expect(overlapVisibility(points, [...cameras, below], { maxAngle: 90 }).pcam.includes(cameras.length)).toBe(false)
  })
})
