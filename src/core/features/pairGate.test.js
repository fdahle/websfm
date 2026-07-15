import { describe, it, expect } from 'vitest'
import { evaluatePairAcceptance } from './pairGate.js'

// Match the merged defaults the store passes (MATCH_DEFAULTS + MATCH_TUNING) for the
// knobs the gate reads. Keep these explicit so a defaults change is a deliberate edit.
const SETTINGS = {
  minMatches: 15,
  minInlierRatio: 0.25,
  overrideInliers: 30,
  hfDegenerateRatio: 0.8,
  minInlierUniqueFrac: 0.5,
  minInlierSpreadPx: 8,
  weakMinInliers: 15,
}

// A healthy spread (never the reject cause) so tests exercise the count/ratio logic.
const goodSpread = (count) => ({ count, uniqueA: count, uniqueB: count, extentA: 500, extentB: 500 })
const result = (inlierCount, hInlierCount = 0) => ({ inlierCount, hInlierCount, F: [[1]], inlierMask: [] })

describe('evaluatePairAcceptance', () => {
  it('accepts a strong pair (enough inliers, ratio clears the gate)', () => {
    const v = evaluatePairAcceptance({
      result: result(60), rawCount: 100, spread: goodSpread(60), settings: SETTINGS,
    })
    expect(v.classification).toBe('accept')
    expect(v.accept).toBe(true)
    expect(v.weak).toBe(false)
  })

  it('accepts via the absolute-inlier override below the ratio floor', () => {
    // 35/200 = 0.175 ratio (< 0.25) but ≥ overrideInliers (30).
    const v = evaluatePairAcceptance({
      result: result(35), rawCount: 200, spread: goodSpread(35), settings: SETTINGS,
    })
    expect(v.classification).toBe('accept')
    expect(v.overrode).toBe(true)
  })

  it('marks a ratio-failing pair with enough inliers as WEAK, not rejected', () => {
    // 20/200 = 0.10 ratio (< gate), 20 < 30 override → not accepted, but 20 ≥ weak floor.
    const v = evaluatePairAcceptance({
      result: result(20), rawCount: 200, spread: goodSpread(20), settings: SETTINGS,
    })
    expect(v.classification).toBe('weak')
    expect(v.weak).toBe(true)
    expect(v.reason).toMatch(/weak bridge/)
  })

  it('marks a below-absolute-floor pair as WEAK when minMatches is raised high', () => {
    // The 227-inlier film chain link that a user-set minMatches=500 used to sever.
    const v = evaluatePairAcceptance({
      result: result(227), rawCount: 300, spread: goodSpread(227),
      settings: { ...SETTINGS, minMatches: 500 },
    })
    expect(v.classification).toBe('weak')
    expect(v.reason).toMatch(/below the 500 absolute floor/)
  })

  it('rejects (never weak) when inliers collapse positionally', () => {
    const spread = { count: 40, uniqueA: 3, uniqueB: 40, extentA: 500, extentB: 500 } // many→one
    const v = evaluatePairAcceptance({
      result: result(40), rawCount: 60, spread, settings: SETTINGS,
    })
    expect(v.classification).toBe('reject')
    expect(v.spreadDegenerate).toBe(true)
    expect(v.reason).toMatch(/collapse positionally/)
  })

  it('rejects a pinhead-region inlier cluster (epipole degeneracy)', () => {
    const spread = { count: 40, uniqueA: 40, uniqueB: 40, extentA: 3, extentB: 500 } // tiny extent
    const v = evaluatePairAcceptance({
      result: result(40), rawCount: 60, spread, settings: SETTINGS,
    })
    expect(v.classification).toBe('reject')
    expect(v.spreadDegenerate).toBe(true)
  })

  it('rejects when there is no fundamental matrix', () => {
    const v = evaluatePairAcceptance({ result: null, rawCount: 100, spread: null, settings: SETTINGS })
    expect(v.classification).toBe('reject')
    expect(v.reason).toMatch(/no fundamental matrix/)
  })

  it('rejects below the weak-pair floor', () => {
    // 10 inliers < weakMinInliers (15) → reject, not weak.
    const v = evaluatePairAcceptance({
      result: result(10), rawCount: 100, spread: goodSpread(10), settings: SETTINGS,
    })
    expect(v.classification).toBe('reject')
    expect(v.reason).toMatch(/weak-pair floor/)
  })

  it('flags H/F degeneracy as a quality label without rejecting', () => {
    const v = evaluatePairAcceptance({
      result: result(60, 55), rawCount: 100, spread: goodSpread(60), settings: SETTINGS,
    })
    expect(v.degenerate).toBe(true)
    expect(v.classification).toBe('accept') // degeneracy is a seed-quality label, not a gate
  })
})
