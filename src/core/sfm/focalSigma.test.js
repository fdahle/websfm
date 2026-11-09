import { describe, expect, it } from 'vitest'
import { FOCAL_UNFIXED_SHARE, focalSigmaNote, focalSigmaShare } from './focalSigma.js'

describe('focalSigmaNote', () => {
  it('turns σ into the share of the camera-to-ground distance heights can move', () => {
    // PUTI with RTK: 5671 ± 3.2 px is 0.056 % — 9 cm at 165 m.
    expect(focalSigmaShare(5671, 3.2)).toBeCloseTo(3.2 / 5671, 12)
    const note = focalSigmaNote(5671, 3.2)
    expect(note).toContain('± 3.2 px')
    expect(note).toContain('± 0.06 %')
  })

  it('says the focal is not fixed when its σ passes the threshold, and what fixes it', () => {
    const fx = 1000
    expect(focalSigmaNote(fx, fx * FOCAL_UNFIXED_SHARE * 0.99)).toMatch(/^focal ±/)
    const unfixed = focalSigmaNote(fx, fx * FOCAL_UNFIXED_SHARE)
    expect(unfixed).toMatch(/not fixed/)
    expect(unfixed).toMatch(/GCPs/)
  })

  it('says nothing without a usable σ', () => {
    expect(focalSigmaNote(1000, NaN)).toBe('')
    expect(focalSigmaNote(1000, 0)).toBe('')
    expect(focalSigmaNote(0, 3)).toBe('')
  })
})
