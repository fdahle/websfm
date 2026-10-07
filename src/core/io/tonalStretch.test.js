import { describe, expect, it } from 'vitest'
import { percentileRange, stretch16ToRgba } from './tonalStretch.js'

describe('percentileRange', () => {
  it('finds the 0.5 / 99.5 % levels of a ramp and ignores alpha', () => {
    const n = 10000
    const gray = Uint16Array.from({ length: n }, (_, i) => 6000 + i * 3) // 6000 … 35997
    const r = percentileRange(gray, 1)
    expect(r.lo).toBe(6000 + 49 * 3)
    expect(r.hi).toBe(6000 + 9949 * 3)
    const withAlpha = new Uint16Array(2 * n)
    gray.forEach((v, i) => { withAlpha[2 * i] = v; withAlpha[2 * i + 1] = 65535 })
    expect(percentileRange(withAlpha, 2)).toEqual(r)
    // Parity with crates/imagecodec gray16_ramp_stretch_matches_js: DN 20997 → 128.
    const out = stretch16ToRgba(gray, n, 1, 1, r)
    expect(out[4999 * 4]).toBe(128)
  })

  it('never returns an empty range on a flat image', () => {
    const r = percentileRange(new Uint16Array(100).fill(500), 1)
    expect(r.hi).toBeGreaterThan(r.lo)
  })
})

describe('stretch16ToRgba', () => {
  it('maps [lo, hi] onto 0…255 and clips outside it', () => {
    const s = Uint16Array.from([1000, 6000, 21000, 36000, 60000])
    const out = stretch16ToRgba(s, 5, 1, 1, { lo: 6000, hi: 36000 })
    expect([...out.filter((_, i) => i % 4 === 0)]).toEqual([0, 0, 128, 255, 255])
    expect(out[3]).toBe(255) // opaque
    expect(out[1]).toBe(out[0]) // gray → R = G = B
  })

  it('uses one mapping for all colour channels and scales alpha by its full range', () => {
    const s = Uint16Array.from([6000, 21000, 36000, 32768])
    const out = stretch16ToRgba(s, 1, 1, 4, { lo: 6000, hi: 36000 })
    expect([...out]).toEqual([0, 128, 255, 128])
  })

  it('inverts MinIsWhite', () => {
    const out = stretch16ToRgba(Uint16Array.from([6000]), 1, 1, 1, { lo: 6000, hi: 36000 }, { invert: true })
    expect(out[0]).toBe(255)
  })

  it('doubles the usable contrast of a MicaSense-like frame compared with the high byte', () => {
    const s = Uint16Array.from({ length: 1000 }, (_, i) => 6300 + Math.round((i / 999) * 30700))
    const r = percentileRange(s, 1)
    const out = stretch16ToRgba(s, 1000, 1, 1, r)
    const highByteSpan = (37000 >> 8) - (6300 >> 8) // 120 levels
    const stretchedSpan = out[(999) * 4] - out[0]
    expect(highByteSpan).toBeLessThan(130)
    expect(stretchedSpan).toBe(255)
  })
})
