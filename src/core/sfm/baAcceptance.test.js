import { describe, it, expect } from 'vitest'

import { compareRobustCost, projectFull } from './baAcceptance.js'

const K = { fx: 1000, fy: 1000, cx: 500, cy: 400 }
const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
const cam = { R: I, t: [0, 0, 0] }

// A grid of points 5 units ahead, observed exactly by one camera.
const points = []
for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) points.push({ x: i / 5 - 1, y: j / 5 - 1, z: 5 })
const exact = points.map((p, ptIdx) => ({ camIdx: 0, ptIdx, ...projectFull(cam, K, p) }))

describe('projectFull', () => {
  it('matches the pinhole model when the radial terms are zero', () => {
    expect(projectFull(cam, K, { x: 1, y: -0.5, z: 5 })).toEqual({ x: 700, y: 300 })
  })
  it('applies radial distortion on normalised coordinates, as bundle.rs does', () => {
    const q = projectFull(cam, { ...K, k1: 0.1 }, { x: 1, y: 0, z: 5 }) // a = 0.2, r² = 0.04
    expect(q.x).toBeCloseTo(1000 * 0.2 * (1 + 0.1 * 0.04) + 500, 9)
  })
  it('returns null on the camera plane', () => {
    expect(projectFull(cam, K, { x: 1, y: 1, z: 0 })).toBeNull()
  })
})

describe('compareRobustCost', () => {
  // Observations: true positions + 0.5 px noise, plus 5 gross outliers (40 px off).
  const noisy = exact.map((o, i) => ({ ...o, x: o.x + (i % 2 ? 0.5 : -0.5) }))
  const observations = noisy.map((o, i) => (i < 5 ? { ...o, x: o.x + 40 } : o))
  const state = (pts) => ({ cams: [cam], Ks: [K], points: pts })

  it('accepts a robust solve that fixes the inliers even though plain RMS rises', () => {
    // "before": the points are 2 px off everywhere (inliers poorly fit).
    const before = state(points.map((p) => ({ ...p, x: p.x + 0.01 })))
    // "after": inliers fit exactly; the 5 outlier points drifted 2 px further out — a step
    // the Huber cost accepts (outliers pay only linearly) while plain RMS gets worse.
    const after = state(points.map((p, i) => (i < 5 ? { ...p, x: p.x - 0.01 } : p)))
    const rms = (s) => Math.sqrt(observations.reduce((acc, o) => {
      const q = projectFull(s.cams[0], K, s.points[o.ptIdx]); return acc + (q.x - o.x) ** 2 + (q.y - o.y) ** 2
    }, 0) / observations.length)
    expect(rms(after)).toBeGreaterThan(rms(before)) // the old guard would reject this
    expect(compareRobustCost({ before, after, observations }).improved).toBe(true)
  })

  it('rejects a solve that genuinely worsens the fit', () => {
    const before = state(points)
    const after = state(points.map((p) => ({ ...p, x: p.x + 0.02 })))
    const r = compareRobustCost({ before, after, observations })
    expect(r.improved).toBe(false)
    expect(r.after).toBeGreaterThan(r.before)
  })
})
