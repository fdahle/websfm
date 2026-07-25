import { describe, it, expect } from 'vitest'
import { resolveDetectMaxDim, DETECT_RESOLUTION_BANDS } from './detectResolution.js'
import {
  DETECT_SIFT_DEFAULTS, DETECT_SIFT_PRESETS,
  DETECT_SUPERPOINT_DEFAULTS, DETECT_SUPERPOINT_PRESETS,
} from '../defaults.user.js'

// The absolute maxDim each preset resolves to today (presets are deltas over the
// defaults; medium is the empty delta).
const absoluteMaxDim = (defaults, presets, preset) =>
  ({ ...defaults, ...presets[preset] }).maxDim

describe('resolveDetectMaxDim — absolute mode', () => {
  // The default must be bit-identical to the pre-existing behaviour, or every
  // project's detector output moves the moment this module lands.
  it('passes maxDim through unchanged by default', () => {
    expect(resolveDetectMaxDim(10137, { maxDim: 2400 })).toMatchObject({ maxDim: 2400, mode: 'absolute' })
    expect(resolveDetectMaxDim(800, { maxDim: 2400 })).toMatchObject({ maxDim: 2400, mode: 'absolute' })
  })

  it('passes through when explicitly absolute', () => {
    expect(resolveDetectMaxDim(10137, { maxDim: 2400, maxDimMode: 'absolute' }).maxDim).toBe(2400)
  })
})

describe('resolveDetectMaxDim — auto mode', () => {
  const auto = (nativeMax, extra = {}) =>
    resolveDetectMaxDim(nativeMax, { maxDim: 2400, maxDimMode: 'auto', ...extra })

  it('gives a film scan more resolution, up to the ceiling', () => {
    const r = auto(10137)
    expect(r.maxDim).toBe(DETECT_RESOLUTION_BANDS.sift.medium.ceilPx)
    expect(r.maxDim).toBeGreaterThan(2400)
    expect(r.reason).toMatch(/ceiling/)
  })

  it('leaves a mid-size DSLR frame near the old absolute value', () => {
    // The band is centred so the common case does not move much.
    expect(auto(6000).maxDim).toBe(2400)
  })

  it('floors small images rather than shrinking them further', () => {
    // 0.4 × 2000 = 800, which would be a pointless downscale of an already-small
    // image. The floor lifts it back to the absolute default, then the native size
    // caps it — so a small image is detected whole.
    const r = auto(2000)
    expect(r.maxDim).toBe(2000)
    expect(r.reason).toMatch(/full native/)
  })

  it('never upscales past the native size', () => {
    for (const n of [400, 900, 1500, 1600]) {
      expect(auto(n).maxDim).toBeLessThanOrEqual(n)
    }
  })

  it('is monotonic in native size', () => {
    let prev = 0
    for (const n of [500, 1000, 2000, 4000, 6000, 8000, 12000, 20000]) {
      const v = auto(n).maxDim
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })

  it('honours the preset band', () => {
    expect(auto(10137, { preset: 'low' }).maxDim).toBe(DETECT_RESOLUTION_BANDS.sift.low.ceilPx)
    expect(auto(10137, { preset: 'high' }).maxDim).toBe(DETECT_RESOLUTION_BANDS.sift.high.ceilPx)
    expect(auto(10137, { preset: 'low' }).maxDim)
      .toBeLessThan(auto(10137, { preset: 'high' }).maxDim)
  })

  it('keeps SuperPoint well under the untiled ORT overflow size', () => {
    // DETECT_TUNING.spMaxUntiledInputPx is 16 MP (~4000×4000); a square input at the
    // ceiling must stay clear of it or a single untiled pass fails outright.
    for (const preset of ['low', 'medium', 'high']) {
      const ceil = DETECT_RESOLUTION_BANDS.superpoint[preset].ceilPx
      expect(ceil * ceil).toBeLessThan(16_000_000)
    }
  })

  it('is always tighter for SuperPoint than for SIFT', () => {
    for (const preset of ['low', 'medium', 'high']) {
      expect(auto(10137, { detector: 'superpoint', preset }).maxDim)
        .toBeLessThan(auto(10137, { detector: 'sift', preset }).maxDim)
    }
  })

  it('falls back to absolute when the native size is unknown', () => {
    for (const bad of [0, null, undefined, NaN, -1]) {
      const r = auto(bad)
      expect(r.maxDim).toBe(2400)
      expect(r.mode).toBe('absolute')
      expect(r.reason).toMatch(/native size unknown/)
    }
  })

  it('falls back to the medium band for an unknown detector or preset', () => {
    expect(auto(6000, { detector: 'nonesuch' }).maxDim).toBe(auto(6000).maxDim)
    expect(auto(6000, { preset: 'nonesuch' }).maxDim).toBe(auto(6000).maxDim)
  })

  it('reports an auditable reason', () => {
    expect(auto(6000).reason).toMatch(/40% of 6000px/)
  })
})

// This is the safety argument for the whole feature: switching a project to auto
// can only ADD detection resolution, never remove it. If it could remove it, the
// scale-relative gates would follow it downward and quietly loosen every
// threshold — a silent quality regression with no visible cause.
describe('auto is never worse than absolute', () => {
  const cases = [
    ['sift', DETECT_SIFT_DEFAULTS, DETECT_SIFT_PRESETS],
    ['superpoint', DETECT_SUPERPOINT_DEFAULTS, DETECT_SUPERPOINT_PRESETS],
  ]

  it('pins each band floor to that preset\'s absolute default', () => {
    for (const [detector, defaults, presets] of cases) {
      for (const preset of ['low', 'medium', 'high']) {
        expect(DETECT_RESOLUTION_BANDS[detector][preset].floorPx)
          .toBe(absoluteMaxDim(defaults, presets, preset))
      }
    }
  })

  it('resolves at least the absolute value at every image size', () => {
    const sizes = [640, 1200, 1600, 2000, 3000, 4000, 6000, 8000, 10137, 16000, 24000]
    for (const [detector, defaults, presets] of cases) {
      for (const preset of ['low', 'medium', 'high']) {
        const abs = absoluteMaxDim(defaults, presets, preset)
        for (const nativeMax of sizes) {
          const got = resolveDetectMaxDim(nativeMax, {
            maxDim: abs, maxDimMode: 'auto', detector, preset,
          }).maxDim
          // Capped at native: an image smaller than the absolute cap was already
          // being detected whole, so "no worse" means min(abs, nativeMax).
          expect(got).toBeGreaterThanOrEqual(Math.min(abs, nativeMax))
        }
      }
    }
  })
})
