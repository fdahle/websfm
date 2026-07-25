import { describe, expect, it } from 'vitest'
import { bestPrototypeHit, estimateFrameBounds, makeFiducialPrototype } from './fiducialPrimitives.js'

describe('estimateFrameBounds', () => {
  it('measures a film rectangle', () => {
    const width = 100, height = 80, data = new Float32Array(width * height).fill(10)
    for (let y = 7; y <= 71; y++) for (let x = 9; x <= 90; x++) data[y * width + x] = 200
    const b = estimateFrameBounds({ data, width, height })
    expect([b.left, b.right, b.top, b.bottom]).toEqual([9, 90, 7, 71])
    expect(b.confidence).toBeGreaterThan(0.5)
  })

  it('reports ~zero confidence on a flat image', () => {
    const width = 100, height = 80
    const gray = { data: new Float32Array(width * height).fill(100), width, height }
    expect(estimateFrameBounds(gray).confidence).toBeLessThan(1e-6)
  })

  // Regression: the dynamic-range scan used to be `Math.max(...gray.data)`, which
  // throws RangeError past ~124k arguments. Scans reach this at 1536 px on the
  // long edge (FIDUCIAL_*_TUNING.maxDim), so every real image crashed the op.
  it('handles a full-size scan without blowing the argument limit', () => {
    const width = 1536, height = 1024
    const data = new Float32Array(width * height).fill(12)
    for (let y = 40; y < height - 40; y++) for (let x = 60; x < width - 60; x++) data[y * width + x] = 210
    expect(data.length).toBeGreaterThan(124_000) // past the spread/argument limit
    const b = estimateFrameBounds({ data, width, height })
    expect(b.left).toBe(60)
    expect(b.right).toBe(width - 61)
    expect(b.confidence).toBeGreaterThan(0.5)
  })
})

describe('bestPrototypeHit', () => {
  // Paint one unambiguous crosshair on a clean field.
  function scanWithMark(family = 'generic', variant = 1, size = 13) {
    const width = 121, height = 101
    const data = new Float32Array(width * height).fill(230)
    const p = makeFiducialPrototype(family, size, variant)
    const h = (p.size - 1) >> 1, cx = 60, cy = 50
    for (let y = 0; y < p.size; y++) for (let x = 0; x < p.size; x++) {
      data[(cy - h + y) * width + cx - h + x] = p.data[y * p.size + x] ? 230 : 20
    }
    return { gray: { data, width, height }, cx, cy }
  }

  it('locates the mark to sub-pixel accuracy', () => {
    const { gray, cx, cy } = scanWithMark()
    const hit = bestPrototypeHit(gray, cx, cy, 8, 'generic', {})
    expect(Math.hypot(hit.x - cx, hit.y - cy)).toBeLessThan(1)
    expect(hit.score).toBeGreaterThan(0.5)
  })

  // Regression: the runner-up must be a spatially DISTINCT peak. Adjacent
  // prototype sizes/variants all lock onto the same mark and score almost
  // identically, so without the distance guard a perfectly unambiguous mark
  // reports margin ≈ 0 and the caller rejects it as 'two-peaks'.
  it('measures the margin against a distinct peak, not a neighbour of itself', () => {
    const { gray, cx, cy } = scanWithMark()
    const hit = bestPrototypeHit(gray, cx, cy, 8, 'generic', {})
    expect(hit.margin).toBeGreaterThan(0.5)
  })

  it('honours polarity: a light-on-dark mark needs the inverted template', () => {
    const { gray, cx, cy } = scanWithMark()
    for (let i = 0; i < gray.data.length; i++) gray.data[i] = 255 - gray.data[i]
    const both = bestPrototypeHit(gray, cx, cy, 8, 'generic', {})
    expect(both.score).toBeGreaterThan(0.5)
    const darkOnly = bestPrototypeHit(gray, cx, cy, 8, 'generic', { polarity: 'dark' })
    expect(darkOnly.score).toBeLessThan(both.score)
  })

  it('returns null when no prototype fits inside the image', () => {
    const gray = { data: new Float32Array(16), width: 4, height: 4 }
    expect(bestPrototypeHit(gray, 2, 2, 1, 'generic', {})).toBe(null)
  })
})
