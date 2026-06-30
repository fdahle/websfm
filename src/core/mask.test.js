import { describe, it, expect } from 'vitest'
import { maskLookupFromRgba, normalizeMaskPixels } from './mask.js'

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
