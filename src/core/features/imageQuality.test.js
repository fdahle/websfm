import { describe, it, expect } from 'vitest'

import { analyzeImageQuality, relativeQuality, qualityVerdicts } from './imageQuality.js'

// Deterministic LCG → 0..1.
function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** Random-noise gray plane (Float64 0..255), uncorrelated pixel to pixel. */
function noise(w, h, seed = 1) {
  const r = rng(seed)
  const g = new Float64Array(w * h)
  for (let i = 0; i < w * h; i++) g[i] = r() * 255
  return g
}

/** Separable box blur of radius r, clamped edges. */
function boxBlur(src, w, h, r) {
  if (r === 0) return src.slice()
  const tmp = new Float64Array(w * h)
  const out = new Float64Array(w * h)
  const n = 2 * r + 1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0
      for (let k = -r; k <= r; k++) a += src[y * w + Math.min(w - 1, Math.max(0, x + k))]
      tmp[y * w + x] = a / n
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0
      for (let k = -r; k <= r; k++) a += tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x]
      out[y * w + x] = a / n
    }
  }
  return out
}

/** Gray (0..255 float) → RGBA Uint8ClampedArray with r = g = b. */
function toRgba(gray, w, h) {
  const d = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    const v = Math.round(gray[i])
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v
    d[i * 4 + 3] = 255
  }
  return { width: w, height: h, data: d }
}

/**
 * A band-limited pattern defined in normalised frame coordinates, so it can be
 * rendered at any resolution: sum of six sinusoids with periods between 8 and 40 px
 * at the 1× size `baseW`.
 */
function pattern(w, h, baseW) {
  const r = rng(7)
  const waves = []
  for (let k = 0; k < 6; k++) {
    const period = 8 + r() * 32 // in 1× pixels
    const theta = r() * Math.PI
    const f = baseW / period // cycles per frame width
    waves.push({ fx: f * Math.cos(theta), fy: f * Math.sin(theta), ph: r() * 2 * Math.PI })
  }
  const g = new Float64Array(w * h)
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / w // frame-width units, so the pattern is not stretched
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w
      let a = 0
      for (const wv of waves) a += Math.sin(2 * Math.PI * (wv.fx * u + wv.fy * v) + wv.ph)
      g[y * w + x] = 128 + 12 * a
    }
  }
  return g
}

describe('analyzeImageQuality', () => {
  it('sharpness strictly decreases with blur radius', () => {
    const w = 400
    const h = 300
    const base = noise(w, h, 3)
    const scores = [0, 1, 2, 4].map((r) => analyzeImageQuality(toRgba(boxBlur(base, w, h, r), w, h)).sharpness)
    for (let i = 1; i < scores.length; i++) expect(scores[i]).toBeLessThan(scores[i - 1])
    expect(scores[3]).toBeGreaterThan(0)
  })

  it('reports the analysis grid and never upsamples', () => {
    const small = analyzeImageQuality(toRgba(noise(300, 200), 300, 200))
    expect(small).toMatchObject({ analysisWidth: 300, analysisHeight: 200, scale: 1 })
    const big = analyzeImageQuality(toRgba(noise(2000, 1000), 2000, 1000))
    expect(big).toMatchObject({ analysisWidth: 1024, analysisHeight: 512, scale: 1024 / 2000 })
  })

  it('is resolution-invariant: the same scene at 2× scores within 20%', () => {
    // 1× is itself downscaled (1200 → 1024, a non-integer factor), 2× by 2400 → 1024.
    const one = analyzeImageQuality(toRgba(pattern(1200, 900, 1200), 1200, 900))
    const two = analyzeImageQuality(toRgba(pattern(2400, 1800, 1200), 2400, 1800))
    expect(one.analysisWidth).toBe(1024)
    expect(two.analysisWidth).toBe(1024)
    const ratio = two.sharpness / one.sharpness
    expect(ratio).toBeGreaterThan(0.8)
    expect(ratio).toBeLessThan(1.2)
  })

  it('a mask excluding the sharp half lowers the score', () => {
    const w = 400
    const h = 300
    const sharp = noise(w, h, 5)
    const soft = boxBlur(sharp, w, h, 2)
    const mixed = new Float64Array(w * h)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) mixed[y * w + x] = x < w / 2 ? sharp[y * w + x] : soft[y * w + x]
    }
    const mask = new Uint8Array(w * h)
    for (let y = 0; y < h; y++) for (let x = w / 2; x < w; x++) mask[y * w + x] = 1
    const raster = toRgba(mixed, w, h)
    const full = analyzeImageQuality(raster)
    const masked = analyzeImageQuality(raster, { mask })
    expect(masked.sharpness).toBeLessThan(full.sharpness)
    // The masked score is the blurred half alone; P90 still sees the sharp tiles unmasked.
    const softOnly = analyzeImageQuality(toRgba(soft, w, h))
    expect(masked.sharpness).toBeCloseTo(softOnly.sharpness, 3)
    expect(full.sharpnessP90).toBeGreaterThan(full.sharpness)
  })

  it('does not mutate its inputs', () => {
    const raster = toRgba(noise(64, 48), 64, 48)
    const copy = raster.data.slice()
    const mask = new Uint8Array(64 * 48).fill(1)
    analyzeImageQuality(raster, { mask })
    expect(raster.data).toEqual(copy)
    expect(mask.every((v) => v === 1)).toBe(true)
  })

  it('measures exposure shares on a saturated image', () => {
    const w = 100
    const h = 100
    const g = new Float64Array(w * h)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) g[y * w + x] = y < 30 ? 255 : y < 50 ? 0 : 128
    }
    const q = analyzeImageQuality(toRgba(g, w, h))
    expect(q.overexposed).toBeCloseTo(0.3, 6)
    expect(q.underexposed).toBeCloseTo(0.2, 6)
    expect(q.meanLuma).toBeCloseTo((0.3 * 255 + 0.5 * 128) / 255, 2)
  })

  it('accepts gray input (Uint8 0..255 and Float32 0..1) like the RGBA path', () => {
    const w = 200
    const h = 150
    const g = boxBlur(noise(w, h, 9), w, h, 1)
    const u8 = new Uint8Array(w * h)
    const f32 = new Float32Array(w * h)
    for (let i = 0; i < w * h; i++) {
      u8[i] = Math.round(g[i])
      f32[i] = u8[i] / 255
    }
    const a = analyzeImageQuality({ width: w, height: h, data: u8, channels: 1 })
    const b = analyzeImageQuality({ width: w, height: h, data: f32, channels: 1 })
    const c = analyzeImageQuality(toRgba(g, w, h))
    expect(b.sharpness).toBeCloseTo(a.sharpness, 8)
    // RGBA luma truncates (rgbaToGray), so it agrees only to ~1 LSB per pixel.
    expect(Math.abs(c.sharpness / a.sharpness - 1)).toBeLessThan(0.05)
  })

  it('returns nulls when nothing is valid', () => {
    const raster = toRgba(noise(32, 32), 32, 32)
    const q = analyzeImageQuality(raster, { mask: new Uint8Array(32 * 32) })
    expect(q.sharpness).toBeNull()
    expect(q.sharpnessP90).toBeNull()
    expect(q.meanLuma).toBeNull()
  })
})

describe('relativeQuality', () => {
  it('divides by the batch median and passes null through', () => {
    expect(relativeQuality([1, 2, null, 4])).toEqual([0.5, 1, null, 2])
    expect(relativeQuality([2, 4, 6, 8])).toEqual([0.4, 0.8, 1.2, 1.6])
  })

  it('is all-null when the median is undefined or zero', () => {
    expect(relativeQuality([null, null])).toEqual([null, null])
    expect(relativeQuality([0, 0, 1])).toEqual([null, null, null])
  })
})

describe('qualityVerdicts', () => {
  it('flags blurry, overexposed and underexposed frames', () => {
    const v = qualityVerdicts([
      { id: 'a', sharpness: 10, overexposed: 0, underexposed: 0 },
      { id: 'b', sharpness: 4, overexposed: 0, underexposed: 0 },
      { id: 'c', sharpness: 11, overexposed: 0.4, underexposed: 0 },
      { id: 'd', sharpness: 9, overexposed: 0, underexposed: 0.3 },
      { id: 'e', sharpness: null, overexposed: null, underexposed: null },
    ])
    expect(v.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(v[0]).toMatchObject({ flags: [], ok: true })
    expect(v[1].flags).toEqual(['blurry'])
    expect(v[1].relative).toBeCloseTo(4 / 9.5, 10)
    expect(v[2].flags).toEqual(['overexposed'])
    expect(v[3].flags).toEqual(['underexposed'])
    expect(v[4]).toMatchObject({ relative: null, flags: [], ok: true })
  })

  it('honours custom thresholds', () => {
    const rs = [
      { id: 1, sharpness: 7, overexposed: 0.1, underexposed: 0 },
      { id: 2, sharpness: 10, overexposed: 0, underexposed: 0 },
      { id: 3, sharpness: 10, overexposed: 0, underexposed: 0 },
    ]
    expect(qualityVerdicts(rs)[0].ok).toBe(true)
    expect(qualityVerdicts(rs, { minRelative: 0.8, maxClipped: 0.05 })[0].flags).toEqual(['blurry', 'overexposed'])
  })
})
