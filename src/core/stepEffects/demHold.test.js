import { describe, it, expect } from 'vitest'
import { demHoldEffects } from './demHold.js'

describe('demHoldEffects', () => {
  const project = { referenceName: 'Copernicus', referenceSigma: 2.4, gcps: 0, poses: 54, hasMatches: true }
  it('says what is held, how firmly, and in whose frame', () => {
    const e = demHoldEffects({ sigma: 2.4 }, project)
    expect(e.reference).toMatch(/held to the height of "Copernicus" there, ±\s2.4\sm, its declared vertical accuracy/)
    expect(e.reference).toMatch(
      /the 54 camera positions place the model on it, its height set between them and the DEM/,
    )
    expect(e.stable).toMatch(/anywhere on "Copernicus"/)
    expect(e.blocked).toBeNull()
    const withGcps = demHoldEffects({ sigma: 1 }, { ...project, gcps: 6 }).reference
    expect(withGcps).toMatch(/±\s1\sm, along.*the 6 GCPs place the model on it\.$/)
    expect(demHoldEffects({ sigma: 2 }, { ...project, referenceSigma: null }).reference).toMatch(
      /declares no vertical accuracy/,
    )
    expect(demHoldEffects({ sigma: 2 }, { ...project, stableName: 'Rock' }).stable).toMatch(/inside "Rock"/)
  })
  it('says why it cannot run', () => {
    expect(demHoldEffects({ sigma: 2 }, { ...project, geographic: true }).blocked).toMatch(/degrees/)
    expect(demHoldEffects({ sigma: 2 }, { ...project, hasMatches: false }).blocked).toMatch(/Match features/)
    expect(demHoldEffects({ sigma: 2 }, { ...project, poses: 2 }).blocked).toMatch(/three or more/)
    expect(demHoldEffects({ sigma: 2 }, { ...project, referenceName: null }).blocked).toMatch(/Import a reference/)
    expect(demHoldEffects({ sigma: 0 }, project).blocked).toMatch(/above 0/)
  })
})
