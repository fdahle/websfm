import { describe, it, expect } from 'vitest'
import { estimatePairCount, subsetGateStatus } from './matchPlan.js'
import { MATCH_TUNING } from '../tuning.js'

describe('estimatePairCount', () => {
  it('counts every pair for exhaustive matching', () => {
    expect(estimatePairCount(127)).toEqual({ count: 8001, exact: true })
    expect(estimatePairCount(1).count).toBe(0)
  })

  it('counts sequential pairs exactly, with and without loop closure', () => {
    // 10 images, 3 following: 9 + 8 + 7 = 24 open; closed adds the 3+2+1 wrap pairs.
    expect(estimatePairCount(10, { strategy: 'sequential', sequentialOverlap: 3 })).toEqual({ count: 24, exact: true })
    expect(
      estimatePairCount(10, { strategy: 'sequential', sequentialOverlap: 3, sequentialLoopClosure: true }).count,
    ).toBe(30)
  })

  it('gives an upper bound for position preselection and none for footprints', () => {
    expect(estimatePairCount(100, { strategy: 'preselect', maxNeighbors: 10 })).toEqual({ count: 1000, exact: false })
    expect(estimatePairCount(5, { strategy: 'preselect', maxNeighbors: 10 }).count).toBe(10)
    expect(estimatePairCount(100, { strategy: 'preselect', preselectMethod: 'footprint' }).count).toBeNull()
  })
})

describe('subsetGateStatus — mirrors matchAll’s run-level bypasses', () => {
  it('runs for a large exhaustive brute-force run', () => {
    expect(subsetGateStatus({ pairCount: 8001 })).toEqual({ active: true, reason: null })
  })

  it('is bypassed when the pairs were already chosen for overlap', () => {
    expect(subsetGateStatus({ strategy: 'sequential', pairCount: 8001 }).active).toBe(false)
    expect(subsetGateStatus({ strategy: 'preselect', pairCount: 8001 }).reason).toMatch(/Preselect/)
  })

  it('is bypassed for a small run', () => {
    const s = subsetGateStatus({ pairCount: MATCH_TUNING.subsetGateMinPairs - 1 })
    expect(s.active).toBe(false)
    expect(s.reason).toMatch(/cheap/)
    expect(subsetGateStatus({ pairCount: MATCH_TUNING.subsetGateMinPairs }).active).toBe(true)
  })

  it('has no reason to give when the user switched it off', () => {
    expect(subsetGateStatus({ subsetGate: false, pairCount: 8001 })).toEqual({ active: false, reason: null })
  })
})
