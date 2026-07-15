import { describe, it, expect } from 'vitest'
import { stagedSelfCalTerms, stagedSelfCalDeferred, SELF_CAL_BASE_TERMS } from './selfCalSchedule.js'

describe('stagedSelfCalTerms', () => {
  it('solves only the base f,k1 on a thin model', () => {
    expect(stagedSelfCalTerms({ nCams: 6, nObs: 5000 })).toBe(SELF_CAL_BASE_TERMS)
  })

  it('adds k2 once cams ≥ 8 and obs ≥ 10k', () => {
    expect(stagedSelfCalTerms({ nCams: 8, nObs: 10_000 })).toBe('f,k1,k2')
    expect(stagedSelfCalTerms({ nCams: 8, nObs: 9_000 })).toBe('f,k1') // obs gate not cleared
  })

  it('adds principal point at cams ≥ 10', () => {
    expect(stagedSelfCalTerms({ nCams: 10, nObs: 12_000 })).toBe('f,cxcy,k1,k2')
  })

  it('unlocks the full bag on a large, well-observed model', () => {
    expect(stagedSelfCalTerms({ nCams: 20, nObs: 30_000 })).toBe('f,cxcy,k1,k2,k3')
  })

  it('reports what is deferred and why', () => {
    const deferred = stagedSelfCalDeferred({ nCams: 6, nObs: 5000 })
    expect(deferred.join(' ')).toMatch(/cx,cy/)
    expect(deferred.join(' ')).toMatch(/k2/)
    expect(deferred.join(' ')).toMatch(/k3/)
    expect(stagedSelfCalDeferred({ nCams: 20, nObs: 30_000 })).toHaveLength(0)
  })
})
