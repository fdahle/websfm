import { describe, it, expect } from 'vitest'
import { orthoStats, describeOrthoStats } from './orthoStats.js'
import { NO_LABEL } from '../products/ortho.js'

// RGBA plane from a grey-level function (alpha 255 where it returns a number).
function plane(w, h, grey) {
  const rgba = new Uint8ClampedArray(w * h * 4)
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const v = grey(c, r), o = 4 * (r * w + c)
    if (v == null) continue
    rgba[o] = rgba[o + 1] = rgba[o + 2] = v; rgba[o + 3] = 255
  }
  return rgba
}

describe('orthoStats', () => {
  it('reads a ramp of one grey level per cell as sharpness 1', () => {
    const s = orthoStats(plane(10, 6, (c) => 10 + c), 10, 6)
    expect(s.sharpness).toBeCloseTo(1, 6)
    expect(s.sharpnessCells).toBe(8 * 4)
    expect(s.labelled).toBe(0)
  })

  it('skips cells with an uncoloured neighbour', () => {
    const s = orthoStats(plane(5, 5, (c, r) => (c === 2 && r === 2 ? null : 100)), 5, 5)
    // every interior cell touches the hole (or is it)
    expect(s.sharpnessCells).toBe(0)
    expect(s.sharpness).toBeNull()
  })

  it('a flat colour step at a source boundary shows as a seam ratio', () => {
    const w = 8, h = 4
    // left half from image 0, right half from image 1, 20 grey levels brighter,
    // plus a gentle texture so the interior step is not zero
    const rgba = plane(w, h, (c, r) => 100 + ((c + r) % 2) * 2 + (c >= 4 ? 20 : 0))
    const labels = new Uint16Array(w * h).map((_, i) => (i % w >= 4 ? 1 : 0))
    const s = orthoStats(rgba, w, h, labels)
    expect(s.sources).toBe(2)
    expect(s.labelled).toBe(w * h)
    expect(s.seamPairs).toBe(h) // one vertical boundary, one pair per row
    expect(s.interiorStep).toBeCloseTo(2, 6)
    expect(s.seamStep).toBeGreaterThan(17)
    expect(s.seamRatio).toBeGreaterThan(8)
    expect(s.seamDensity).toBeCloseTo(h / (w * h), 9)
    expect(describeOrthoStats(s)).toMatch(/2 source image\(s\)/)
  })

  it('ignores unlabelled cells and counts salt-and-pepper switching as density', () => {
    const w = 6, h = 6
    const rgba = plane(w, h, () => 50)
    const labels = new Uint16Array(w * h).map((_, i) => ((i % w) + Math.floor(i / w)) % 2)
    labels[0] = NO_LABEL
    const s = orthoStats(rgba, w, h, labels)
    expect(s.labelled).toBe(w * h - 1)
    expect(s.seamStep).toBe(0)
    expect(s.interiorStep).toBeNull() // checkerboard: every pair is a seam
    expect(s.seamRatio).toBeNull()
    expect(s.seamDensity).toBeGreaterThan(1.5)
  })
})
