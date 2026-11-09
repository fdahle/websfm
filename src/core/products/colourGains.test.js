import { describe, it, expect } from 'vitest'
import { exposurePriors, fitGains } from './colourGains.js'

// A strip of `n` photos over ground of random brightness: each sample point is seen by
// photo i and i + 1 (and i + 2 every third point), and a photo records radiance × its
// exposure (× a little noise). The right gains are ∝ 1 / exposure: then every overlap
// agrees.
function strip(exposure, { pointsPerPair = 60, noise = 0.01, seed = 3 } = {}) {
  let s = seed
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648
  const n = exposure.length
  const pt = [],
    img = [],
    rgb = []
  let L = 0
  for (let i = 0; i + 1 < n; i++)
    for (let k = 0; k < pointsPerPair; k++) {
      const radiance = [0.05 + 0.1 * rnd(), 0.05 + 0.1 * rnd(), 0.05 + 0.1 * rnd()]
      const seen = k % 3 === 0 && i + 2 < n ? [i, i + 1, i + 2] : [i, i + 1]
      for (const j of seen) {
        pt.push(L)
        img.push(j)
        for (const r of radiance) rgb.push(r * exposure[j] * (1 + noise * (rnd() - 0.5)))
      }
      L++
    }
  return {
    nImages: n,
    nPoints: L,
    obsPt: Int32Array.from(pt),
    obsImg: Int32Array.from(img),
    obsRgb: Float32Array.from(rgb),
  }
}

// How far the levelled photos disagree: the largest spread of gain × exposure over the
// block (0 when every photo, levelled, records the same ground the same).
function mismatch(gains, exposure) {
  const v = exposure.map((e, i) => Math.log(gains[3 * i + 1] * e))
  return Math.max(...v) - Math.min(...v)
}

const exif = (e) => ({ exposureTime: e / 1000, iso: 100, fNumber: 2.8 })

describe('exposurePriors', () => {
  it('gives each photo the log gain to the median exposure', () => {
    const { prior, withExif, spread } = exposurePriors([exif(1), exif(2), exif(4), exif(8), exif(2)])
    expect(withExif).toBe(5)
    expect(spread).toBeCloseTo(8, 9)
    // Median exposure 2: the photo at 1 needs ×2, the one at 8 ×¼.
    expect(Array.from(prior, Math.exp).map((g) => +g.toFixed(9))).toEqual([2, 1, 0.5, 0.25, 1])
  })

  it('weighs time, ISO and aperture as the light they let through', () => {
    // f/4 at ISO 200 lets through as much as f/2.8 at ISO 100, near enough (4² / 2.8² ≈ 2.04).
    const { prior } = exposurePriors([
      { exposureTime: 0.001, iso: 100, fNumber: 2.8 },
      { exposureTime: 0.001, iso: 200, fNumber: 4 },
      { exposureTime: 0.002, iso: 100, fNumber: 2.8 },
    ])
    expect(Math.exp(prior[0] - prior[1])).toBeCloseTo(200 / 16 / (100 / 7.84), 9)
    expect(Math.exp(prior[0] - prior[2])).toBeCloseTo(2, 9)
  })

  it('leaves out a factor no photo has, and a photo without one the others have', () => {
    const noAperture = (t, iso) => ({ exposureTime: t, iso, fNumber: null })
    const a = exposurePriors([noAperture(0.001, 100), noAperture(0.001, 400), null, noAperture(0.002, 100)])
    expect(a.withExif).toBe(3)
    expect(a.prior[2]).toBe(0)
    expect(Math.exp(a.prior[0] - a.prior[1])).toBeCloseTo(4, 9)
    // One photo with the full set: nothing to compare it with.
    const b = exposurePriors([exif(1), { exposureTime: 0.004, iso: 100 }])
    expect(b.withExif).toBe(0)
    expect(Array.from(b.prior)).toEqual([0, 0])
  })

  it('is all zeros without EXIF or when nothing varies', () => {
    expect(Array.from(exposurePriors([null, {}, { iso: [100, 0] }]).prior)).toEqual([0, 0, 0])
    const same = exposurePriors([exif(1), exif(1), exif(1)])
    expect(Array.from(same.prior)).toEqual([0, 0, 0])
    expect(same.spread).toBe(1)
  })
})

describe('fitGains', () => {
  it('levels neighbouring photos to the light they saw', () => {
    const exposure = [1, 1.3, 0.8, 1.6, 1.1, 0.7, 1.2, 0.9]
    const { gains, summary } = fitGains(strip(exposure))
    expect(summary.clamped).toBe(0)
    expect(mismatch(gains, exposure)).toBeLessThan(0.03)
  })

  // Auto-exposure over a flight: ten times the exposure from the first photo to the last.
  // Pulled towards gain 1, the fit gives back much of the trend (the pull is there so
  // small biases cannot add up along a block, and a real trend is one); centred on the
  // EXIF exposure, the photos agree.
  const tenfold = Array.from({ length: 16 }, (_, i) => 10 ** (i / 15))

  it('pulled towards gain 1, leaves an exposure trend in the levelled block', () => {
    expect(mismatch(fitGains(strip(tenfold)).gains, tenfold)).toBeGreaterThan(0.3)
    // Along 60 photos, a fourfold drift stays almost whole.
    const drift = Array.from({ length: 60 }, (_, i) => 4 ** (i / 59))
    expect(mismatch(fitGains(strip(drift)).gains, drift)).toBeGreaterThan(0.8)
    // And past 2 stops either side of 1 the clamp cuts it.
    const forty = Array.from({ length: 16 }, (_, i) => 40 ** (i / 15))
    expect(fitGains(strip(forty)).summary.clamped).toBeGreaterThan(0)
  })

  it('levels it centred on the EXIF exposure', () => {
    for (const e of [
      tenfold,
      Array.from({ length: 60 }, (_, i) => 4 ** (i / 59)),
      Array.from({ length: 16 }, (_, i) => 40 ** (i / 15)),
    ]) {
      const { gains, summary } = fitGains({ ...strip(e), prior: exposurePriors(e.map(exif)).prior })
      expect(summary.clamped).toBe(0)
      expect(mismatch(gains, e)).toBeLessThan(0.03)
    }
  })

  it("keeps the photos' own level: the exposures only set how they compare", () => {
    // Twelve photos at one exposure, then four at four times it. Taking the median
    // exposure as the level would leave the twelve as they are and darken the four
    // (mean log gain −0.35); the level is the photos' own, as without a prior.
    const skewed = [...Array(12).fill(1), ...Array(4).fill(4)]
    const meanLog = (g) => skewed.reduce((a, _, i) => a + Math.log(g[3 * i + 1]), 0) / skewed.length
    const plain = fitGains(strip(skewed))
    const centred = fitGains({ ...strip(skewed), prior: exposurePriors(skewed.map(exif)).prior })
    expect(mismatch(centred.gains, skewed)).toBeLessThan(0.03)
    expect(Math.abs(meanLog(centred.gains))).toBeLessThan(0.03)
    expect(Math.abs(meanLog(centred.gains) - meanLog(plain.gains))).toBeLessThan(0.03)
  })

  it('lets the overlaps correct an EXIF exposure that is off', () => {
    // EXIF 20 % off on every other photo (a camera's own tone curve, a rounded shutter
    // time): the overlaps still decide.
    const recorded = tenfold.map((e, i) => (i % 2 ? e * 1.2 : e / 1.2))
    const { prior } = exposurePriors(recorded.map(exif))
    const { gains } = fitGains({ ...strip(tenfold), prior })
    expect(mismatch(gains, tenfold)).toBeLessThan(0.04)
  })

  it('with a prior of zeros, is the fit without one', () => {
    const block = strip([1, 1.3, 0.8, 1.6, 1.1])
    const a = fitGains(block)
    const b = fitGains({ ...block, prior: new Float64Array(5) })
    a.gains.forEach((g, i) => expect(b.gains[i]).toBeCloseTo(g, 12))
  })
})
