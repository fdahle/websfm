import { describe, it, expect } from 'vitest'
import { distortPixel } from './distortion.js'

import { compareRobustCost, projectFull, projectFullXYZ, solveVerdict } from './baAcceptance.js'

const K = { fx: 1000, fy: 1000, cx: 500, cy: 400 }
const I = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
]
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
    const rms = (s) =>
      Math.sqrt(
        observations.reduce((acc, o) => {
          const q = projectFull(s.cams[0], K, s.points[o.ptIdx])
          return acc + (q.x - o.x) ** 2 + (q.y - o.y) ** 2
        }, 0) / observations.length,
      )
    expect(rms(after)).toBeGreaterThan(rms(before)) // the old guard would reject this
    expect(compareRobustCost({ before, after, observations }).improved).toBe(true)
  })

  it('judges a solve by the loss it descended', () => {
    // "before": every inlier 1 px off; "after": the inliers fit and the 5 outliers (40 px)
    // drifted 20 px further out. Huber charges each outlier 2δ per pixel of drift and
    // rejects it; the redescending losses charge less than the inliers gained.
    const before = state(points.map((p) => ({ ...p, x: p.x + 0.005 })))
    const after = state(points.map((p, i) => (i < 5 ? { ...p, x: p.x - 0.1 } : p)))
    const judge = (loss) => compareRobustCost({ before, after, observations, loss })
    expect(judge('huber').improved).toBe(false)
    expect(judge(undefined).improved).toBe(false)
    expect(judge('cauchy').improved).toBe(true)
    expect(judge('geman-mcclure').improved).toBe(true)
  })

  it('rejects a solve that genuinely worsens the fit', () => {
    const before = state(points)
    const after = state(points.map((p) => ({ ...p, x: p.x + 0.02 })))
    const r = compareRobustCost({ before, after, observations })
    expect(r.improved).toBe(false)
    expect(r.after).toBeGreaterThan(r.before)
  })
})

describe('solveVerdict', () => {
  const noisy = exact.map((o, i) => ({ ...o, x: o.x + (i % 2 ? 0.5 : -0.5) }))
  const observations = noisy.map((o, i) => (i < 5 ? { ...o, x: o.x + 40 } : o))
  const state = (pts) => ({ cams: [cam], Ks: [K], points: pts })
  const rms = (s) =>
    Math.sqrt(
      observations.reduce((acc, o) => {
        const q = projectFull(s.cams[0], K, s.points[o.ptIdx])
        return acc + (q.x - o.x) ** 2 + (q.y - o.y) ** 2
      }, 0) / observations.length,
    )

  it('keeps a solve whose robust cost fell though its plain RMS rose by under 0.01 px', () => {
    // The inliers move 0.5 px onto their observations, the 5 outlier points 0.1 px further
    // out: plain RMS up by about 0.001 px, the Huber cost down (outliers pay linearly).
    const before = state(points.map((p, i) => (i < 5 ? p : { ...p, x: p.x + 0.0025 })))
    const after = state(points.map((p, i) => (i < 5 ? { ...p, x: p.x - 0.0005 } : p)))
    const [rmsBefore, rmsAfter] = [rms(before), rms(after)]
    expect(rmsAfter).toBeGreaterThan(rmsBefore)
    expect(rmsAfter - rmsBefore).toBeLessThan(0.01)
    const robust = compareRobustCost({ before, after, observations })
    expect(robust.improved).toBe(true)
    expect(solveVerdict({ rmsBefore, rmsAfter, robust })).toBe('kept')
  })

  it('calls a no-op re-solve converged and rejects one that worsened both costs', () => {
    const worse = { improved: false }
    expect(solveVerdict({ rmsBefore: 1.2, rmsAfter: 1.205, robust: worse })).toBe('converged')
    expect(solveVerdict({ rmsBefore: 1.2, rmsAfter: 1.25, robust: worse })).toBe('rejected')
    expect(solveVerdict({ rmsBefore: 1.2, rmsAfter: 1.1 })).toBe('kept')
  })
})

describe('projectFullXYZ (fisheye)', () => {
  it('matches the pinhole projection pushed through distortPixel', () => {
    const cam = {
      R: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      t: [0, 0, 0],
    }
    const K = { fx: 320, fy: 320, cx: 500, cy: 400 }
    const lens = { fisheye: true, k1: 0.04, k2: -0.006, k3: 0.001, k4: -0.0002 }
    for (const [x, y, z] of [
      [0, 0, 5],
      [3, -2, 4],
      [-6, 5, 2],
      [1e-9, 0, 3],
    ]) {
      const q = projectFullXYZ(cam, { ...K, ...lens }, x, y, z)
      const p = distortPixel((K.fx * x) / z + K.cx, (K.fy * y) / z + K.cy, K, lens)
      expect(q.x).toBeCloseTo(p.x, 9)
      expect(q.y).toBeCloseTo(p.y, 9)
    }
  })
})
