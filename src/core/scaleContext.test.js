import { describe, it, expect } from 'vitest'
import {
  detectScaleOf,
  buildScaleContext,
  pairScaleContext,
  resolveScaledPx,
  describeScaleContext,
  SCALE_CONTEXT_DEFAULTS,
} from './scaleContext.js'

describe('detectScaleOf', () => {
  it('reads a valid scale', () => {
    expect(detectScaleOf({ detectScale: 0.25 })).toBe(0.25)
    expect(detectScaleOf({ detectScale: 1 })).toBe(1)
  })

  // Back-compat is the whole safety argument: a project that predates detectScale
  // must resolve every threshold to its old value.
  it('treats a missing scale as 1 (no correction)', () => {
    expect(detectScaleOf({})).toBe(1)
    expect(detectScaleOf(null)).toBe(1)
    expect(detectScaleOf(undefined)).toBe(1)
  })

  it('rejects corrupt values rather than tightening the gate', () => {
    // rasterize clamps to 1, so > 1 is corrupt data. Honouring it would make the
    // factor < 1 and tighten every downstream threshold — the opposite of the fix.
    expect(detectScaleOf({ detectScale: 1.5 })).toBe(1)
    expect(detectScaleOf({ detectScale: 0 })).toBe(1)
    expect(detectScaleOf({ detectScale: -0.5 })).toBe(1)
    expect(detectScaleOf({ detectScale: NaN })).toBe(1)
    expect(detectScaleOf({ detectScale: '0.5' })).toBe(1)
  })
})

describe('buildScaleContext', () => {
  it('is a no-op at full detection resolution', () => {
    const ctx = buildScaleContext([{ detectScale: 1 }, { detectScale: 1 }])
    expect(ctx.factor).toBe(1)
    expect(resolveScaledPx(2.0, ctx)).toBe(2.0)
  })

  it('is a no-op for an empty set', () => {
    const ctx = buildScaleContext([])
    expect(ctx.n).toBe(0)
    expect(ctx.factor).toBe(1)
    expect(resolveScaledPx(4.0, ctx)).toBe(4.0)
  })

  // The motivating case: 10137px film scan detected at maxDim 2400.
  it('recovers the film-scan factor', () => {
    const scale = 2400 / 10137
    const ctx = buildScaleContext([{ detectScale: scale }])
    expect(ctx.factor).toBeCloseTo(4.22, 2)
    // The 2.0px F-RANSAC gate lands above the ~4.2px localization quantum.
    expect(resolveScaledPx(2.0, ctx)).toBeCloseTo(8.45, 2)
  })

  it('uses the median, so a few odd images do not move the factor', () => {
    const ctx = buildScaleContext([
      { detectScale: 0.25 }, { detectScale: 0.25 }, { detectScale: 0.25 },
      { detectScale: 1 },
    ])
    expect(ctx.medianScale).toBe(0.25)
    expect(ctx.factor).toBeCloseTo(4, 6)
  })

  it('ignores a factor below the engage threshold', () => {
    // 1.02× is a rounding artefact, not a resolution loss worth reporting.
    const ctx = buildScaleContext([{ detectScale: 0.98 }])
    expect(ctx.factor).toBe(1)
    expect(ctx.rawFactor).toBeGreaterThan(1)
  })

  it('clamps a runaway factor and says so', () => {
    // maxDim 800 on a 16000px scan — the honest fix is more detection resolution.
    const ctx = buildScaleContext([{ detectScale: 800 / 16000 }])
    expect(ctx.rawFactor).toBeCloseTo(20, 6)
    expect(ctx.factor).toBe(SCALE_CONTEXT_DEFAULTS.maxFactor)
    expect(ctx.clamped).toBe(true)
    expect(describeScaleContext(ctx)).toMatch(/CLAMPED/)
  })

  // Regression: the median of an even split lands on the sharper image, so the
  // factor is 1 and no correction engages — precisely the case the user must be
  // told about. An early "factor === 1 ⇒ nothing to say" return swallowed it.
  it('flags a mixed set even when the factor does not engage', () => {
    const ctx = buildScaleContext([{ detectScale: 1 }, { detectScale: 0.25 }])
    expect(ctx.mixed).toBe(true)
    expect(ctx.factor).toBe(1)
    expect(describeScaleContext(ctx)).toMatch(/mixed detection scales/)
  })

  it('flags a mixed set that also scales', () => {
    const ctx = buildScaleContext([{ detectScale: 0.25 }, { detectScale: 0.25 }, { detectScale: 1 }])
    expect(ctx.mixed).toBe(true)
    expect(ctx.factor).toBeCloseTo(4, 6)
    expect(describeScaleContext(ctx)).toMatch(/mixed detection scales/)
  })

  it('does not flag a uniform set as mixed', () => {
    expect(buildScaleContext([{ detectScale: 0.5 }, { detectScale: 0.5 }]).mixed).toBe(false)
  })
})

describe('pairScaleContext', () => {
  // An epipolar residual is measured in both images, so the coarser one sets the
  // noise floor. A mean would leave the gate below it whenever one image is sharp.
  it('takes the coarser of the two scales', () => {
    const ctx = pairScaleContext({ detectScale: 1 }, { detectScale: 0.25 })
    expect(ctx.factor).toBeCloseTo(4, 6)
  })

  it('is a no-op when both are full resolution', () => {
    expect(pairScaleContext({ detectScale: 1 }, { detectScale: 1 }).factor).toBe(1)
  })

  it('treats a missing scale on either side as full resolution', () => {
    expect(pairScaleContext({}, { detectScale: 1 }).factor).toBe(1)
  })
})

describe('resolveScaledPx', () => {
  it('passes through sentinel values that mean "no gate"', () => {
    const ctx = buildScaleContext([{ detectScale: 0.25 }])
    expect(resolveScaledPx(0, ctx)).toBe(0)
    expect(resolveScaledPx(Infinity, ctx)).toBe(Infinity)
    expect(resolveScaledPx(NaN, ctx)).toBeNaN()
  })

  it('never tightens a threshold', () => {
    for (const s of [1, 0.9, 0.5, 0.25, 0.05]) {
      const ctx = buildScaleContext([{ detectScale: s }])
      expect(resolveScaledPx(4.0, ctx)).toBeGreaterThanOrEqual(4.0)
    }
  })

  it('tolerates a malformed context', () => {
    expect(resolveScaledPx(4.0, null)).toBe(4.0)
    expect(resolveScaledPx(4.0, { factor: 0.5 })).toBe(4.0)
  })
})

describe('describeScaleContext', () => {
  it('reports the inputs, not just the factor', () => {
    const ctx = buildScaleContext([{ detectScale: 0.25 }, { detectScale: 0.25 }])
    const msg = describeScaleContext(ctx, 'SfM thresholds')
    expect(msg).toMatch(/SfM thresholds/)
    expect(msg).toMatch(/×4\.00/)
    expect(msg).toMatch(/0\.250/)   // the median scale behind the factor
    expect(msg).toMatch(/2 images/)
  })

  it('has a distinct line for the unscaled case', () => {
    expect(describeScaleContext(buildScaleContext([{ detectScale: 1 }]))).toMatch(/unscaled/)
  })
})
