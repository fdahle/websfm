import { describe, it, expect } from 'vitest'
import { screenSelectMask, pointInPolygon, bandedPolygonTest, maskIndices } from './screenSelect.js'

// Orthographic-ish identity camera: clip = (x, y, z, 1), so NDC = buffer x/y.
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

function cloud(xyz) {
  const pos = new Float32Array(xyz.length * 3)
  xyz.forEach((p, i) => pos.set(p, i * 3))
  return pos
}

const PTS = cloud([[0, 0, 0], [0.5, 0.5, 0], [-0.5, 0.5, 0], [0.9, -0.9, 0], [2, 2, 0]])
const N = 5
const sel = (r) => Array.from(r.mask)

describe('pointInPolygon', () => {
  it('handles a concave polygon (even-odd)', () => {
    // U shape: the notch at (0, 0.5) is outside.
    const u = [-1, -1, 1, -1, 1, 1, 0.5, 1, 0.5, 0, -0.5, 0, -0.5, 1, -1, 1]
    expect(pointInPolygon(0, -0.5, u)).toBe(true)
    expect(pointInPolygon(0, 0.5, u)).toBe(false)
    expect(pointInPolygon(0.75, 0.5, u)).toBe(true)
  })
})

describe('bandedPolygonTest', () => {
  // Deterministic LCG so a failure reproduces.
  function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) }

  it('agrees exactly with the full even-odd walk, self-intersecting lassos included', () => {
    const r = rng(7)
    for (let trial = 0; trial < 40; trial++) {
      const n = 3 + Math.floor(r() * 60)
      // Quantised coordinates force shared vertex heights, horizontal edges and
      // query points exactly on band boundaries — the cases a banding bug hits.
      const q = () => Math.round((r() * 2 - 1) * 16) / 16
      const poly = Array.from({ length: n * 2 }, q)
      const test = bandedPolygonTest(poly)
      for (let k = 0; k < 400; k++) {
        const x = k % 2 ? q() : r() * 2.2 - 1.1
        const y = k % 3 ? q() : r() * 2.2 - 1.1
        expect(test(x, y)).toBe(pointInPolygon(x, y, poly))
      }
      for (let v = 0; v < n; v++) {
        expect(test(poly[v * 2], poly[v * 2 + 1])).toBe(pointInPolygon(poly[v * 2], poly[v * 2 + 1], poly))
      }
    }
  })
})

describe('screenSelectMask', () => {
  it('selects inside a rectangle regardless of corner order', () => {
    const r = screenSelectMask(PTS, N, { matrix: IDENTITY, shape: { kind: 'rect', x0: 1, y0: 1, x1: -0.1, y1: -0.1 } })
    expect(sel(r)).toEqual([1, 1, 0, 0, 0])
    expect(r.selected).toBe(2)
  })

  it('selects inside a lasso polygon', () => {
    const tri = { kind: 'lasso', points: [-1, 0.2, 0, 1, 0, 0.2] }
    expect(sel(screenSelectMask(PTS, N, { matrix: IDENTITY, shape: tri }))).toEqual([0, 0, 1, 0, 0])
  })

  it('adds and subtracts against a base mask, keeping the popcount exact', () => {
    const base = new Uint8Array([1, 0, 0, 0, 0])
    const add = screenSelectMask(PTS, N, { matrix: IDENTITY, shape: { kind: 'rect', x0: 0.8, y0: -1, x1: 1, y1: -0.8 }, base, op: 'add' })
    expect(sel(add)).toEqual([1, 0, 0, 1, 0])
    expect(add.selected).toBe(2)
    const sub = screenSelectMask(PTS, N, { matrix: IDENTITY, shape: { kind: 'rect', x0: -0.1, y0: -0.1, x1: 0.1, y1: 0.1 }, base: add.mask, op: 'subtract' })
    expect(sel(sub)).toEqual([0, 0, 0, 1, 0])
    expect(sub.selected).toBe(1)
    expect(Array.from(base)).toEqual([1, 0, 0, 0, 0]) // base is never mutated
  })

  it('never selects points behind the camera (w ≤ 0)', () => {
    // w = -z: the point at z = +1 is behind, z = -1 in front.
    const persp = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -1, 0, 0, 0, 0]
    const pos = cloud([[0, 0, -1], [0, 0, 1]])
    const r = screenSelectMask(pos, 2, { matrix: persp, shape: { kind: 'rect', x0: -1, y0: -1, x1: 1, y1: 1 } })
    expect(sel(r)).toEqual([1, 0])
  })

  it('never selects points the near/far planes clip away (|z_clip| > w)', () => {
    // clip z = buffer z, w = 1: only −1 ≤ z ≤ 1 is drawn.
    const pos = cloud([[0, 0, -2], [0, 0, 0], [0, 0, 2]])
    const r = screenSelectMask(pos, 3, { matrix: IDENTITY, shape: { kind: 'rect', x0: -1, y0: -1, x1: 1, y1: 1 } })
    expect(sel(r)).toEqual([0, 1, 0])
  })

  it('applies the column-major model translation', () => {
    // Translate +1 in x: the buffer origin point lands at NDC x = 1.
    const m = IDENTITY.slice(); m[12] = 1
    const r = screenSelectMask(cloud([[0, 0, 0], [-1, 0, 0]]), 2, { matrix: m, shape: { kind: 'rect', x0: 0.9, y0: -0.1, x1: 1.1, y1: 0.1 } })
    expect(sel(r)).toEqual([1, 0])
  })

  it('restricts candidates to drawn indices (hidden points are unselectable)', () => {
    const r = screenSelectMask(PTS, N, { matrix: IDENTITY, shape: { kind: 'rect', x0: -1, y0: -1, x1: 1, y1: 1 }, indices: new Uint32Array([1, 3]) })
    expect(sel(r)).toEqual([0, 1, 0, 1, 0])
  })

  it('a degenerate shape (a click) yields an empty replace selection', () => {
    const r = screenSelectMask(PTS, N, { matrix: IDENTITY, shape: { kind: 'rect', x0: 0, y0: 0, x1: 0, y1: 0 } })
    expect(r.selected).toBe(0)
  })

  it('maskIndices lists the set entries', () => {
    expect(Array.from(maskIndices(new Uint8Array([0, 1, 0, 1, 1]), 3))).toEqual([1, 3, 4])
  })
})
