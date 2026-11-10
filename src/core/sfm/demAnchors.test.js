import { describe, it, expect } from 'vitest'
import { demAnchors } from './demAnchors.js'
import { frameFromSimilarity } from '../products/georef.js'
import { SparsePoints } from './sparsePoints.js'

// A model 1:20 of the ground, turned 90° about its vertical and shifted: project =
// 20·R·model + t.
const sim = {
  scale: 20,
  R: [
    [0, -1, 0],
    [1, 0, 0],
    [0, 0, 1],
  ],
  t: [500000, 4000000, 100],
}
const frame = frameFromSimilarity(sim, 'EPSG:32633')

function cloud(project, views = 3) {
  const pos = new Float64Array(3 * project.length)
  project.forEach((p, i) => pos.set(frame.toSfm(p), 3 * i))
  return new SparsePoints({
    pos,
    viewUuids: ['a'],
    vcount: Uint32Array.from(project.map(() => views)),
    vcam: new Uint32Array(project.length * views),
    vkp: new Uint32Array(project.length * views),
  })
}

describe('demAnchors', () => {
  // Ground the reference puts at 100 m; the model's ground is tilted 1 m per 100 m east.
  const ground = []
  for (let x = 0; x < 200; x += 10)
    for (let y = 0; y < 200; y += 10) ground.push([500000 + x, 4000000 + y, 100 + x / 100])
  const sample = () => 100

  it("holds each point to the DEM's height along the vertical only", () => {
    const { anchors, stats } = demAnchors({ points: cloud(ground), frame, sample, sigma: 0.5 })
    expect(stats).toMatchObject({ candidates: 400, used: 400, rejected: 0 })
    const a = anchors[25]
    const p = ground[a.ptIdx]
    const target = frame.fromSfm(a.target)
    expect(target[0]).toBeCloseTo(p[0], 6)
    expect(target[1]).toBeCloseTo(p[1], 6)
    expect(target[2]).toBeCloseTo(100, 6)
    // Rank one along the model's vertical (its z, as R keeps z), weight 1/(σ/20)².
    const P = a.precision
    expect(P[2][2]).toBeCloseTo(1 / (0.5 / 20) ** 2, 3)
    for (const [r, c] of [
      [0, 0],
      [1, 1],
      [0, 1],
      [0, 2],
      [1, 2],
    ])
      expect(Math.abs(P[r][c])).toBeLessThan(1e-9)
  })

  // Heights in no common datum: the DEM 50 m off as a whole (a geoid height). Only the
  // shape is held: each target is the DEM plus the median difference, so the tilt is
  // pulled out and the block's height stays where the control put it.
  it('holds the shape only, the median offset taken out, when the datums differ', () => {
    const { anchors, stats } = demAnchors({
      points: cloud(ground),
      frame,
      sample: () => 50,
      sigma: 0.5,
      relative: true,
    })
    expect(stats.median).toBeCloseTo(51, 6)
    const zs = anchors.map((a) => frame.fromSfm(a.target)[2])
    expect(zs.every((z) => Math.abs(z - 101) < 1e-6)).toBe(true)
    // The absolute hold would pull every point 50 m down.
    const abs = demAnchors({ points: cloud(ground), frame, sample: () => 50, sigma: 0.5 })
    expect(frame.fromSfm(abs.anchors[0].target)[2]).toBeCloseTo(50, 6)
  })

  it('leaves out blunders, unstable ground, places off the DEM and weakly seen points', () => {
    const pts = ground.map((p, i) => (i % 50 === 7 ? [p[0], p[1], p[2] + 40] : p))
    const res = demAnchors({ points: cloud(pts), frame, sample, sigma: 0.5 })
    expect(res.stats.rejected).toBe(8)
    expect(res.anchors.every((a) => a.ptIdx % 50 !== 7)).toBe(true)
    // Stable ground only west of x 500100; the reference ends at y 4000150.
    const some = demAnchors({
      points: cloud(ground),
      frame,
      sample: (x, y) => (y < 4000150 ? 100 : NaN),
      include: (x) => x < 500100,
      sigma: 0.5,
    })
    expect(some.stats.candidates).toBe(10 * 15)
    expect(demAnchors({ points: cloud(ground, 2), frame, sample }).anchors).toEqual([])
  })

  it('spreads at most maxAnchors over the area', () => {
    const { anchors } = demAnchors({ points: cloud(ground), frame, sample, maxAnchors: 25 })
    expect(anchors.length).toBeLessThanOrEqual(25)
    expect(anchors.length).toBeGreaterThan(15)
    const xs = anchors.map((a) => ground[a.ptIdx][0] - 500000)
    expect(Math.min(...xs)).toBeLessThan(20)
    expect(Math.max(...xs)).toBeGreaterThan(150)
  })
})
