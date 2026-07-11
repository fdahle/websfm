import { describe, it, expect } from 'vitest'
import { maskLookupFromRgba, normalizeMaskPixels, paintBorderExclude, invertMaskPixels, anyExcluded } from './mask.js'

// Build a flat RGBA buffer (Uint8ClampedArray-like) of w*h pixels from a list
// of [r,g,b,a] tuples.
function rgba(pixels) {
  const d = new Uint8Array(pixels.length * 4)
  pixels.forEach((p, i) => { d[i * 4] = p[0]; d[i * 4 + 1] = p[1]; d[i * 4 + 2] = p[2]; d[i * 4 + 3] = p[3] })
  return d
}

describe('maskLookupFromRgba', () => {
  it('marks opaque pixels masked and transparent pixels kept', () => {
    const data = rgba([
      [255, 0, 0, 255], // opaque red → masked
      [0, 0, 0, 0],     // transparent → kept
      [255, 0, 0, 128], // alpha just over threshold → masked
      [10, 10, 10, 100], // alpha under threshold → kept
    ])
    expect(Array.from(maskLookupFromRgba(data, 4, 1))).toEqual([1, 0, 1, 0])
  })
})

describe('normalizeMaskPixels', () => {
  it('turns bright or opaque source pixels into opaque red, others transparent', () => {
    const data = rgba([
      [255, 255, 255, 255], // bright + opaque → excluded
      [0, 0, 0, 255],       // dark but opaque → excluded
      [0, 0, 0, 0],         // dark + transparent → kept
      [200, 200, 200, 0],   // bright but transparent → excluded (lum>127)
    ])
    normalizeMaskPixels(data)
    expect(Array.from(data)).toEqual([
      255, 0, 0, 255,
      255, 0, 0, 255,
      0, 0, 0, 0,
      255, 0, 0, 255,
    ])
  })

  it('is idempotent on an already-normalized mask', () => {
    const data = rgba([[255, 0, 0, 255], [0, 0, 0, 0]])
    normalizeMaskPixels(data)
    const once = Array.from(data)
    normalizeMaskPixels(data)
    expect(Array.from(data)).toEqual(once)
  })
})

describe('anyExcluded', () => {
  it('is false for an all-transparent (empty) mask', () => {
    expect(anyExcluded(rgba([[0, 0, 0, 0], [255, 0, 0, 0], [10, 10, 10, 100]]))).toBe(false)
  })
  it('is true when at least one pixel is opaque', () => {
    expect(anyExcluded(rgba([[0, 0, 0, 0], [255, 0, 0, 255]]))).toBe(true)
  })
})

describe('invertMaskPixels', () => {
  it('swaps excluded and kept pixels and returns the new excluded count', () => {
    const data = rgba([
      [255, 0, 0, 255], // excluded → kept
      [0, 0, 0, 0],     // kept → excluded
      [255, 0, 0, 128], // alpha just over threshold → kept
      [10, 10, 10, 100], // partial alpha under threshold (brush AA edge) → excluded
    ])
    const excluded = invertMaskPixels(data)
    expect(excluded).toBe(2)
    expect(Array.from(maskLookupFromRgba(data, 4, 1))).toEqual([0, 1, 0, 1])
  })

  it('double inversion restores the lookup (normalized input)', () => {
    const data = rgba([[255, 0, 0, 255], [0, 0, 0, 0], [255, 0, 0, 255]])
    const before = Array.from(maskLookupFromRgba(data, 3, 1))
    invertMaskPixels(data)
    invertMaskPixels(data)
    expect(Array.from(maskLookupFromRgba(data, 3, 1))).toEqual(before)
  })

  it('returns 0 when inverting a fully-excluded mask (caller can drop it)', () => {
    const data = rgba([[255, 0, 0, 255], [255, 0, 0, 255]])
    expect(invertMaskPixels(data)).toBe(0)
  })
})

describe('paintBorderExclude', () => {
  // Fill w*h pixels with a recognizable sentinel so "untouched" is checkable.
  const filled = (w, h) => {
    const d = new Uint8Array(w * h * 4)
    d.fill(9)
    return d
  }
  const pixel = (d, w, x, y) => Array.from(d.slice((y * w + x) * 4, (y * w + x) * 4 + 4))
  const RED = [255, 0, 0, 255]

  it('excludes the requested per-side margins and leaves the interior untouched', () => {
    const w = 5, h = 4
    const d = filled(w, h)
    paintBorderExclude(d, w, h, { top: 1, bottom: 1, left: 2, right: 1 })

    // Interior is x in [2,3], y in [1,2] → untouched sentinel.
    expect(pixel(d, w, 2, 1)).toEqual([9, 9, 9, 9])
    expect(pixel(d, w, 3, 2)).toEqual([9, 9, 9, 9])
    // Border samples on each side → red-exclude.
    expect(pixel(d, w, 0, 0)).toEqual(RED) // top-left corner
    expect(pixel(d, w, 2, 0)).toEqual(RED) // top band
    expect(pixel(d, w, 2, 3)).toEqual(RED) // bottom band
    expect(pixel(d, w, 1, 1)).toEqual(RED) // left band
    expect(pixel(d, w, 4, 1)).toEqual(RED) // right band
  })

  it('clamps margins to half each dimension (no wrap)', () => {
    const w = 4, h = 4
    const d = filled(w, h)
    // left/right each ≥ w/2 → clamped to 2, together covering the full width.
    paintBorderExclude(d, w, h, { left: 10, right: 10 })
    for (let i = 0; i < w * h; i++) {
      expect(Array.from(d.slice(i * 4, i * 4 + 4))).toEqual(RED)
    }
  })

  it('is a no-op with zero margins', () => {
    const w = 3, h = 3
    const d = filled(w, h)
    paintBorderExclude(d, w, h, {})
    expect(Array.from(d)).toEqual(Array.from(filled(w, h)))
  })
})
