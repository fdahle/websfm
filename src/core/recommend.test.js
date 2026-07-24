import { describe, it, expect } from 'vitest'
import { recommendSettings } from './recommend.js'
import { profileDataset } from './profile.js'

// A minimal profile builder — recommend.js only reads these fields.
const profile = (over = {}) => ({
  nImages: 50, minDim: 4000, maxDim: 4000, medianMP: 12,
  kind: 'unknown', hasGps: false, hasPoses: false,
  hasCalibratedDistortion: false, sequentialNames: false,
  scale: 'medium', notes: [], ...over,
})

describe('recommendSettings', () => {
  it('returns all five stages even for a null profile', () => {
    const r = recommendSettings(null)
    expect(Object.keys(r)).toEqual(['detect', 'match', 'sfm', 'depthmap', 'fuse'])
    for (const k of Object.keys(r)) expect(r[k]).toEqual({})
  })

  it('detect.maxDim = clamp(round(0.5·native), 1200, 3200)', () => {
    expect(recommendSettings(profile({ maxDim: 4000 })).detect.maxDim.value).toBe(2000)
    expect(recommendSettings(profile({ maxDim: 11000 })).detect.maxDim.value).toBe(3200) // clamped high
    expect(recommendSettings(profile({ maxDim: 2000 })).detect.maxDim.value).toBe(1200)  // clamped low
    // No dimensions ⇒ keep the default (no maxDim recommendation).
    expect(recommendSettings(profile({ maxDim: null })).detect.maxDim).toBeUndefined()
  })

  it('detect.maxKeypoints scales inversely with set size', () => {
    expect(recommendSettings(profile({ scale: 'small' })).detect.maxKeypoints.value).toBe(8000)
    expect(recommendSettings(profile({ scale: 'medium' })).detect.maxKeypoints.value).toBe(5000)
    expect(recommendSettings(profile({ scale: 'large' })).detect.maxKeypoints.value).toBe(4000)
  })

  it('detect enables tiling only for very large scans', () => {
    expect(recommendSettings(profile({ maxDim: 4000 })).detect.tiling).toBeUndefined()
    const big = recommendSettings(profile({ maxDim: 11000 })).detect
    expect(big.tiling.value).toBe('on')
    expect(big.tileSize.value).toBe(1536)
  })

  it('match strategy: poses/GPS → preselect, sequential → sequential, else exhaustive', () => {
    expect(recommendSettings(profile({ hasPoses: true })).match.strategy.value).toBe('preselect')
    expect(recommendSettings(profile({ hasPoses: true })).match.preselectMethod.value).toBe('position')
    expect(recommendSettings(profile({ hasGps: true })).match.strategy.value).toBe('preselect')
    // Sequential naming only downgrades to sequential matching on a LARGE set —
    // on a medium set contiguous filenames don't justify skipping exhaustive.
    expect(recommendSettings(profile({ sequentialNames: true, scale: 'large' })).match.strategy.value).toBe('sequential')
    expect(recommendSettings(profile({ sequentialNames: true, scale: 'medium' })).match.strategy.value).toBe('exhaustive')
    expect(recommendSettings(profile()).match.strategy.value).toBe('exhaustive')
  })

  it('poses win over sequential naming for strategy', () => {
    const r = recommendSettings(profile({ hasPoses: true, sequentialNames: true, scale: 'large' }))
    expect(r.match.strategy.value).toBe('preselect')
  })

  it('sfm.refineIntrinsics stays auto but reasons about calibration', () => {
    expect(recommendSettings(profile()).sfm.refineIntrinsics.value).toBe('auto')
    expect(recommendSettings(profile({ hasCalibratedDistortion: true })).sfm.refineIntrinsics.reason)
      .toMatch(/double-correct/)
    expect(recommendSettings(profile({ hasCalibratedDistortion: false })).sfm.refineIntrinsics.reason)
      .toMatch(/k1/)
  })

  it('depthmap quality: budget and set size drive the pick', () => {
    // No budget: medium set → medium, large set → low.
    expect(recommendSettings(profile({ scale: 'medium' })).depthmap.quality.value).toBe('medium')
    expect(recommendSettings(profile({ scale: 'large' })).depthmap.quality.value).toBe('low')
    // Low memory forces low regardless of size.
    expect(recommendSettings(profile({ scale: 'small' }), { deviceMemoryGB: 2 }).depthmap.quality.value).toBe('low')
    // Ample memory + small set → high.
    expect(recommendSettings(profile({ scale: 'small' }), { deviceMemoryGB: 16 }).depthmap.quality.value).toBe('high')
  })

  it('fuse has no metadata-derived knobs (auto mode handles it)', () => {
    expect(recommendSettings(profile()).fuse).toEqual({})
  })

  it('every derived knob carries a non-empty reason', () => {
    const r = recommendSettings(profile({ maxDim: 11000, hasPoses: true }), { deviceMemoryGB: 4 })
    for (const stage of Object.values(r)) {
      for (const { reason } of Object.values(stage)) {
        expect(typeof reason).toBe('string')
        expect(reason.length).toBeGreaterThan(0)
      }
    }
  })

  // ── Pinned end-to-end profiles (U1 → U2) for the two benchmark datasets ──
  it('B0 (aerial film scans): tiled hi-res detect, sequential match, low dense', () => {
    // Scanned film: no EXIF, ~11k px, sequential names, many images, no GPS.
    const images = Array.from({ length: 250 }, (_, i) => ({
      name: `CA213732V${String(i + 1).padStart(4, '0')}.tif`,
      meta: { width: 11000, height: 11000 },
    }))
    const p = profileDataset({ images, sensors: [{ kind: 'film' }] })
    expect(p.kind).toBe('film')
    expect(p.scale).toBe('large')
    const r = recommendSettings(p)
    expect(r.detect.maxDim.value).toBe(3200)
    expect(r.detect.tiling.value).toBe('on')
    expect(r.match.strategy.value).toBe('sequential')
    expect(r.depthmap.quality.value).toBe('low') // large set
  })

  it('B1 (50-image building set): half-res detect, exhaustive match', () => {
    const images = Array.from({ length: 50 }, (_, i) => ({
      name: `building_${i}.jpg`,
      meta: { width: 4368, height: 2912, make: 'Canon', model: 'EOS 5D' },
    }))
    const p = profileDataset({ images })
    expect(p.kind).toBe('unknown')
    expect(p.scale).toBe('medium')
    const r = recommendSettings(p)
    expect(r.detect.maxDim.value).toBe(2184) // round(0.5·4368)
    expect(r.detect.tiling).toBeUndefined()
    expect(r.match.strategy.value).toBe('exhaustive')
    expect(r.depthmap.quality.value).toBe('medium')
  })
})
