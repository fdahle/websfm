import { describe, it, expect } from 'vitest'

import { SIFT_DESC_NORM, rootSiftInPlace, siftDescNorm, toMatchSpace } from './siftDescriptors.js'

// A classic SIFT row as the crate emits it: non-negative, L2-normalised.
function siftRow(seed, dim = 128) {
  const r = new Float32Array(dim)
  let s = seed
  for (let j = 0; j < dim; j++) { s = (s * 1103515245 + 12345) >>> 0; r[j] = (s % 1000) / 1000 }
  const n = Math.hypot(...r)
  for (let j = 0; j < dim; j++) r[j] /= n
  return r
}

describe('rootSiftInPlace', () => {
  it('is sqrt of the L1-normalised row, and comes out unit-L2', () => {
    const row = siftRow(3)
    const l1 = row.reduce((a, b) => a + b, 0)
    const expected = Array.from(row, (v) => Math.sqrt(v / l1))
    const out = rootSiftInPlace(row.slice())
    out.forEach((v, j) => expect(v).toBeCloseTo(expected[j], 6))
    expect(Math.hypot(...out)).toBeCloseTo(1, 5)
  })

  it('converts every row of a buffer independently and leaves a zero row zero', () => {
    const buf = new Float32Array(3 * 128)
    buf.set(siftRow(1), 0)
    buf.set(siftRow(2), 256)
    rootSiftInPlace(buf)
    expect(Math.hypot(...buf.subarray(0, 128))).toBeCloseTo(1, 5)
    expect(buf.subarray(128, 256).every((v) => v === 0)).toBe(true)
    expect(Math.hypot(...buf.subarray(256))).toBeCloseTo(1, 5)
  })
})

describe('siftDescNorm', () => {
  it('trusts an explicit stamp', () => {
    expect(siftDescNorm({ detector: 'sift', descNorm: 'root' })).toBe(SIFT_DESC_NORM.ROOT)
    expect(siftDescNorm({ detector: 'sift', descNorm: 'l2' })).toBe(SIFT_DESC_NORM.L2)
  })

  it('reads an unstamped websfm detection as legacy L2 and a COLMAP import as RootSIFT', () => {
    expect(siftDescNorm({ detector: 'sift' })).toBe('l2')
    expect(siftDescNorm({ detector: 'sift', detectSettings: { maxDim: 2400 } })).toBe('l2')
    expect(siftDescNorm({ detector: 'sift', detectSettings: { source: 'colmap' } })).toBe('root')
    expect(siftDescNorm({})).toBe('l2') // absent detector ⇒ SIFT, the historical default
  })

  it('is null for every non-SIFT detector', () => {
    expect(siftDescNorm({ detector: 'superpoint' })).toBeNull()
    expect(siftDescNorm({ detector: 'aliked', detectSettings: { source: 'colmap' } })).toBeNull()
  })
})

describe('toMatchSpace', () => {
  it('converts a legacy L2 buffer into a NEW array, never touching the original', () => {
    const live = siftRow(5)
    const before = live.slice()
    const out = toMatchSpace(live, { detector: 'sift' })
    expect(out).not.toBe(live)
    expect(Array.from(live)).toEqual(Array.from(before))
    expect(Array.from(out)).toEqual(Array.from(rootSiftInPlace(before.slice())))
  })

  it('a converted legacy image and a fresh RootSIFT detection land in the same space', () => {
    const crateOutput = siftRow(9)
    const fresh = rootSiftInPlace(crateOutput.slice()) // what detect.js stores now
    const legacy = toMatchSpace(crateOutput, { detector: 'sift' }) // what it stored before
    expect(Array.from(legacy)).toEqual(Array.from(fresh))
  })

  it('passes RootSIFT, SuperPoint and missing buffers through untouched', () => {
    const d = siftRow(7)
    expect(toMatchSpace(d, { detector: 'sift', descNorm: 'root' })).toBe(d)
    expect(toMatchSpace(d, { detector: 'superpoint' })).toBe(d)
    expect(toMatchSpace(null, { detector: 'sift' })).toBeNull()
  })
})
