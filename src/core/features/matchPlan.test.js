import { describe, it, expect } from 'vitest'
import { estimatePairCount, subsetGateStatus } from './matchPlan.js'
import { MATCH_TUNING, RETRIEVAL_TUNING } from '../tuning.js'

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

  it('bounds Sequential with Find revisits by the window plus k per image', () => {
    const k = RETRIEVAL_TUNING.revisitNeighbors
    expect(estimatePairCount(100, { strategy: 'sequential', sequentialOverlap: 3, sequentialRevisits: true })).toEqual({
      count: 294 + 100 * k,
      exact: false,
    })
    // Never more than every pair.
    expect(estimatePairCount(6, { strategy: 'sequential', sequentialOverlap: 3, sequentialRevisits: true }).count).toBe(
      15,
    )
  })

  it('gives an upper bound for position preselection and none for footprints', () => {
    expect(estimatePairCount(100, { strategy: 'preselect', maxNeighbors: 10 })).toEqual({ count: 1000, exact: false })
    expect(estimatePairCount(5, { strategy: 'preselect', maxNeighbors: 10 }).count).toBe(10)
    expect(estimatePairCount(100, { strategy: 'preselect', preselectMethod: 'footprint' }).count).toBeNull()
  })

  it('bounds Similar images by n·k, and counts every pair when the set is no larger than k + 1', () => {
    expect(estimatePairCount(100, { strategy: 'retrieval', retrievalNeighbors: 20 })).toEqual({
      count: 2000,
      exact: false,
    })
    // 21 images, k 20: each image chooses all the others.
    expect(estimatePairCount(21, { strategy: 'retrieval', retrievalNeighbors: 20 })).toEqual({
      count: 210,
      exact: true,
    })
  })
})

describe('subsetGateStatus — mirrors matchAll’s run-level bypasses', () => {
  it('runs for a large exhaustive brute-force run', () => {
    expect(subsetGateStatus({ pairCount: 8001 })).toEqual({ active: true, reason: null })
  })

  it('is bypassed when the pairs were already chosen for overlap', () => {
    expect(subsetGateStatus({ strategy: 'sequential', pairCount: 8001 }).active).toBe(false)
    expect(subsetGateStatus({ strategy: 'preselect', pairCount: 8001 }).reason).toMatch(/Preselect/)
    expect(subsetGateStatus({ strategy: 'retrieval', pairCount: 8001 }).reason).toMatch(/Similar images/)
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
