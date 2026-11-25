import { describe, expect, it } from 'vitest'
import { overlapGrid } from './coverage.js'

// A strip of three nadir photos 100 units above flat ground at z = 0, 40 units apart
// (60 % forward overlap): each 100 × 100 px frame at fx 100 covers ±50 units around its
// camera. Along x the ground is seen by 1, 2, 3, 2 and 1 photos:
//   [−50, −10) 1 · [−10, 30) 2 · [30, 50) 3 · [50, 90) 2 · [90, 130] 1
const nadir = (x, y = 0, H = 100) => {
  const R = [
    [1, 0, 0],
    [0, -1, 0],
    [0, 0, -1],
  ]
  const C = [x, y, H]
  return { R, t: R.map((r) => -(r[0] * C[0] + r[1] * C[1] + r[2] * C[2])), K: { fx: 100, fy: 100, cx: 50, cy: 50 } }
}
const ground = (x0, x1, y0, y1, z = () => 0) => {
  const p = []
  for (let x = x0; x <= x1; x += 2) for (let y = y0; y <= y1; y += 2) p.push([x, y, z(x, y)])
  return { length: p.length, x: (i) => p[i][0], y: (i) => p[i][1], z: (i) => p[i][2] }
}
const at = (g, x, y) => g.views[Math.floor((y - g.minY) / g.cellSize) * g.cols + Math.floor((x - g.minX) / g.cellSize)]

describe('overlapGrid', () => {
  const strip = [nadir(0), nadir(40), nadir(80)]

  it('counts the photos that see each patch of ground', () => {
    const g = overlapGrid(ground(-50, 130, -50, 50), strip)
    expect(at(g, -30, 0)).toBe(1)
    expect(at(g, 10, 0)).toBe(2)
    expect(at(g, 40, 0)).toBe(3)
    expect(at(g, 70, 0)).toBe(2)
    expect(at(g, 110, 0)).toBe(1)
    expect(g.maxViews).toBe(3)
  })

  it('reports the share of the seen ground each count covers', () => {
    const g = overlapGrid(ground(-50, 130, -50, 50), strip)
    // Along x: 80 of 180 units seen once (both ends), 80 twice, 20 three times (the 5 %
    // margin around the points adds cells no photo sees, which do not count).
    expect(g.shares.one).toBeCloseTo(80 / 180, 1)
    expect(g.shares.two).toBeCloseTo(80 / 180, 1)
    expect(g.shares.threePlus).toBeCloseTo(20 / 180, 1)
  })

  it('counts on the tie points’ surface, not a flat plane', () => {
    // A 40-unit hill under the middle photo: 60 units below the cameras, each frame
    // covers ±30 there, so the ground at x 34 (seen by all three on flat ground) is out
    // of the first photo's frame (it reaches 30) and of the third's (from 50).
    const hill = ground(-50, 130, -50, 50, (x) => (x > 20 && x < 60 ? 40 : 0))
    const g = overlapGrid(hill, strip)
    expect(at(g, 34, 0)).toBe(1)
    expect(at(overlapGrid(ground(-50, 130, -50, 50), strip), 34, 0)).toBe(3)
  })

  it('fills cells without tie points from their neighbours', () => {
    // No points in a band: the band still has a ground height, so it is still counted.
    const all = ground(-50, 130, -50, 50)
    const keep = []
    for (let i = 0; i < all.length; i++) if (all.x(i) < 0 || all.x(i) > 20) keep.push(i)
    const gap = { length: keep.length, x: (i) => all.x(keep[i]), y: (i) => all.y(keep[i]), z: (i) => all.z(keep[i]) }
    expect(at(overlapGrid(gap, strip), 10, 0)).toBe(2)
  })

  it('returns an empty grid without points or cameras', () => {
    expect(overlapGrid(ground(0, 0, 0, 0), []).cols).toBe(0)
    expect(overlapGrid({ length: 0, x: () => 0, y: () => 0, z: () => 0 }, strip).cols).toBe(0)
  })
})
