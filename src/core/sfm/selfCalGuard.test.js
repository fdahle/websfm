import { describe, expect, it } from 'vitest'
import { validateSelfCalUpdate } from './selfCalGuard.js'

const base = { fx: 2400, fy: 2400, cx: 1500, cy: 1100 }
const input = (proposed) => ({ before: base, proposed: { ...base, ...proposed }, nominalFx: 2400, width: 3000, height: 2200 })

describe('validateSelfCalUpdate', () => {
  it('accepts the healthy South Building-scale correction', () => {
    expect(validateSelfCalUpdate(input({ fx: 2566, fy: 2566, k1: -0.06, k2: 0.15, k3: -0.18 })).ok).toBe(true)
  })

  it('rejects a single-pass focal runaway', () => {
    const v = validateSelfCalUpdate(input({ fx: 3905, fy: 3905, k1: -0.53 }))
    expect(v).toMatchObject({ ok: false, code: 'focal-step' })
  })

  it('rejects cumulative drift even when the latest step is modest', () => {
    const v = validateSelfCalUpdate({ ...input({ fx: 3533, fy: 3533 }), before: { ...base, fx: 2842, fy: 2842 } })
    expect(v).toMatchObject({ ok: false, code: 'focal-nominal' })
  })

  it('rejects a bag with no inverse at the OBSERVED corner, keeps an invertible one', () => {
    // 4000×3000, f=3000: the observed corner radius is 0.833. k1 = −0.3 keeps the
    // radial scale positive there (the old test passed it) but r·s(r²) peaks at
    // ≈0.73 < 0.833, so the fold has nothing to map corner keypoints to.
    const at = (k) => validateSelfCalUpdate({
      before: { fx: 3000, fy: 3000, cx: 2000, cy: 1500 },
      proposed: { fx: 3000, fy: 3000, cx: 2000, cy: 1500, ...k }, nominalFx: 3000, width: 4000, height: 3000,
    }, { maxCornerShiftFrac: 1 })
    expect(at({ k1: -0.3 }).code).toBe('radial-fold')
    expect(at({ k1: -0.1 }).ok).toBe(true)
    expect(at({ k1: -0.15, k2: 0.02 }).ok).toBe(true)
  })

  it('rejects a folded radial curve and a runaway principal point', () => {
    expect(validateSelfCalUpdate(input({ k1: -10 })).code).toBe('radial-fold')
    expect(validateSelfCalUpdate(input({ cx: 2200 })).code).toBe('principal-point')
  })

  // The CA213732V strip: 10137×9600 scans with no focal in the metadata, so resolveK
  // guesses fx = 10137. The focal pre-solve proposed 7106 (−29.9 %); the true focal is
  // ~6700. Against an EXIF focal that step is a runaway; against a guess it is the fix.
  describe('a default-FOV focal guess', () => {
    const guess = { fx: 10137, fy: 10137, cx: 5068.5, cy: 4800 }
    const presolve = (fx, focalIsGuess) => validateSelfCalUpdate({
      before: guess, proposed: { ...guess, fx, fy: fx }, nominalFx: 10137,
      width: 10137, height: 9600, focalIsGuess,
    })

    it('rejects the TMA pre-solve step when the focal is treated as measured', () => {
      expect(presolve(7106, false)).toMatchObject({ ok: false, code: 'focal-step' })
    })

    it('accepts it, and the true focal, when the focal is only a guess', () => {
      expect(presolve(7106, true).ok).toBe(true)
      expect(presolve(6700, true).ok).toBe(true)
    })

    it('still bounds a guess: fx must stay within [0.3, 1.7] × the guess', () => {
      expect(presolve(10137 * 0.35, true).code).toBe('focal-step') // a 65 % jump in one pass
      const drifted = validateSelfCalUpdate({
        before: { ...guess, fx: 3500, fy: 3500 }, proposed: { ...guess, fx: 2800, fy: 2800 },
        nominalFx: 10137, width: 10137, height: 9600, focalIsGuess: true,
      })
      expect(drifted).toMatchObject({ ok: false, code: 'focal-nominal' })
      expect(drifted.reason).toMatch(/default-FOV guess/)
    })
  })
})
