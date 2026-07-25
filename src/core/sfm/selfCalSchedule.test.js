import { describe, it, expect } from 'vitest'
import {
  stagedSelfCalTerms, stagedSelfCalDeferred, SELF_CAL_BASE_TERMS,
  distortionIdentifiable, withoutDistortionTerms,
} from './selfCalSchedule.js'

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

describe('distortionIdentifiable', () => {
  // The 2026-07-24 CA…V run: 5 cameras (clear of the old nCams<3 floor) but
  // 715 ×2-view / 83 ×3-view / 0 ×4+-view tracks, and k1 flipped sign between passes.
  const tmaRun = { nCams: 5, nTracks: 798, nMultiViewTracks: 83 }

  it('blocks distortion on a 2-view-dominated model that camera count would have passed', () => {
    const r = distortionIdentifiable(tmaRun)
    expect(r.ok).toBe(false)
    expect(r.scope).toBe('distortion')
    expect(r.reason).toMatch(/≥3 views/)
  })

  it('keeps refining focal when only distortion is unidentifiable', () => {
    expect(withoutDistortionTerms('f,k1')).toBe('f')
    expect(withoutDistortionTerms('f,cxcy,k1,k2,k3')).toBe('f,cxcy')
    expect(withoutDistortionTerms('k1')).toBe('none')
  })

  it('blocks everything below the camera floor (unchanged 2-camera behaviour)', () => {
    const r = distortionIdentifiable({ nCams: 2, nTracks: 500, nMultiViewTracks: 400 })
    expect(r).toMatchObject({ ok: false, scope: 'all' })
  })

  it('allows distortion once enough tracks span 3+ views', () => {
    expect(distortionIdentifiable({ nCams: 5, nTracks: 800, nMultiViewTracks: 120 }).ok).toBe(true)
  })

  it('allows it on a large model whose multi-view SHARE is low but count is high', () => {
    // 8% share, but 4000 constraining tracks in absolute terms.
    expect(distortionIdentifiable({ nCams: 40, nTracks: 50_000, nMultiViewTracks: 4000 }).ok).toBe(true)
  })

  it('does not divide by zero on an empty model', () => {
    expect(distortionIdentifiable({ nCams: 5, nTracks: 0, nMultiViewTracks: 0 }).ok).toBe(false)
  })
})
