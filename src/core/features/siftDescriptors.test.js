import { describe, it, expect } from 'vitest'

import {
  SIFT_DESC_NORM,
  SIFT_U8_SCALE,
  descriptorsAsFloat,
  rootSiftInPlace,
  siftDescNorm,
  toMatchSpace,
  rootSiftToU8,
} from './siftDescriptors.js'

// A classic SIFT row as the crate emits it: non-negative, L2-normalised.
function siftRow(seed, dim = 128) {
  const r = new Float32Array(dim)
  let s = seed
  for (let j = 0; j < dim; j++) {
    s = (s * 1103515245 + 12345) >>> 0
    r[j] = (s % 1000) / 1000
  }
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

describe('rootSiftToU8', () => {
  it('gives Math.min(255, Math.round(v × 512)) for every value, a negative one 0', () => {
    const vals = [0, -0, NaN, 1, 0.75, -0.25, 0.5 / 512, 1.5 / 512, 254.5 / 512, 255.5 / 512, 1e-9, 2]
    let s = 3
    for (let i = 0; i < 20000; i++) vals.push((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 2 ** 32)
    for (const T of [Float32Array, Float64Array]) {
      const d = T.from(vals)
      const want = new Uint8Array(d.length)
      for (let k = 0; k < d.length; k++) want[k] = Math.max(0, Math.min(255, Math.round(d[k] * 512)))
      expect(Array.from(rootSiftToU8(d))).toEqual(Array.from(want))
    }
  })

  it('passes bytes through: they are this encoding already', () => {
    const u8 = Uint8Array.from([0, 17, 255])
    expect(rootSiftToU8(u8)).toBe(u8)
  })

  it('is COLMAP’s scale: 512', () => {
    expect(SIFT_U8_SCALE).toBe(512)
    expect(Array.from(rootSiftToU8(Float32Array.from([1 / 512, 0.25, 0.5])))).toEqual([1, 128, 255])
  })
})

describe('stored bytes', () => {
  // RootSIFT rows as detection stores them.
  const stored = (seeds) => {
    const f = new Float32Array(seeds.length * 128)
    seeds.forEach((s, i) => f.set(rootSiftInPlace(siftRow(s)), i * 128))
    return { f, u8: rootSiftToU8(f) }
  }

  it('widen back within half a step of the float they were made from', () => {
    const { f, u8 } = stored([1, 2, 3, 4])
    const w = descriptorsAsFloat(u8)
    expect(w).toBeInstanceOf(Float32Array)
    for (let k = 0; k < f.length; k++) {
      expect(w[k]).toBe(u8[k] / 512)
      expect(Math.abs(w[k] - f[k])).toBeLessThanOrEqual(0.5 / 512 + 1e-9)
    }
    // Each row stays unit length to a few parts in a thousand.
    for (let r = 0; r < 4; r++) expect(Math.hypot(...w.subarray(r * 128, r * 128 + 128))).toBeCloseTo(1, 2)
  })

  it('a float buffer passes through descriptorsAsFloat, and so does null', () => {
    const f = new Float32Array(128)
    expect(descriptorsAsFloat(f)).toBe(f)
    expect(descriptorsAsFloat(null)).toBeNull()
  })

  it('give dot products that are exact in Float32 whatever the summation order', () => {
    // The GPU kernel and the WASM matcher sum in different orders: on widened bytes both
    // land on the same exact value, so the two matchers pick the same neighbours.
    const worst = new Uint8Array(128).fill(255)
    const rows = [worst, ...Array.from({ length: 6 }, (_, i) => stored([i + 11]).u8)]
    for (const a of rows)
      for (const b of rows) {
        const wa = descriptorsAsFloat(a),
          wb = descriptorsAsFloat(b)
        let exact = 0
        for (let k = 0; k < 128; k++) exact += a[k] * b[k] // integers, exact in a double
        exact /= 512 * 512
        let fwd = 0,
          rev = 0
        for (let k = 0; k < 128; k++) fwd = Math.fround(fwd + Math.fround(wa[k] * wb[k]))
        for (let k = 127; k >= 0; k--) rev = Math.fround(rev + Math.fround(wa[k] * wb[k]))
        expect(fwd).toBe(exact)
        expect(rev).toBe(exact)
        // The matcher's s = ‖b‖² − 2·a·b is exact too.
        let nb = 0
        for (let k = 0; k < 128; k++) nb = Math.fround(nb + Math.fround(wb[k] * wb[k]))
        let nbExact = 0
        for (let k = 0; k < 128; k++) nbExact += b[k] * b[k]
        expect(Math.fround(nb - 2 * fwd)).toBe((nbExact - 2 * exact * 512 * 512) / (512 * 512))
      }
  })

  it('are RootSIFT whatever the image is stamped: toMatchSpace never converts them', () => {
    const { u8 } = stored([5])
    expect(toMatchSpace(u8, { detector: 'sift' })).toBe(u8) // unstamped would mean L2 for floats
    expect(toMatchSpace(u8, { detector: 'sift', descNorm: 'root' })).toBe(u8)
  })
})
