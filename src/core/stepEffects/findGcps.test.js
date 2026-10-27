import { describe, it, expect } from 'vitest'
import { findGcpsEffects } from './findGcps.js'
import { FIND_GCPS_DEFAULTS } from '../defaults.user.js'

const S = { ...FIND_GCPS_DEFAULTS, band: 'rgb' }

describe('findGcpsEffects', () => {
  it('words the image match, its band and the matcher', () => {
    const e = findGcpsEffects(S, { referenceName: 'S2', bandCount: 4 })
    expect(e.match).toMatch(/^DISK \+ LightGlue \(SuperPoint .*\) matches the orthophoto to "S2" \(mean of bands 1–3\)/)
    expect(e.match).toMatch(/same ground resolution, then up to 6 × 6 tiles/)
    const sift = findGcpsEffects({ ...S, matcher: 'sift', band: 2 }, { referenceName: 'S2', bandCount: 4 })
    expect(sift.match).toMatch(/^SIFT .* \(band 2\): first a 1,536-pixel look/)
    expect(findGcpsEffects(S, { referenceName: 'Pan', bandCount: 1 }).match).toMatch(/"Pan": first/)
    expect(findGcpsEffects(S).match).toMatch(/^Choose a reference orthophoto/)
  })

  it('words the terrain fit, with and without a DEM', () => {
    const t = { ...S, matcher: 'terrain' }
    expect(findGcpsEffects(t, { demName: 'REMA', sparsePoints: 12345 }).match).toMatch(
      /^The sparse cloud's 12,345 points are fitted to "REMA" by ICP/,
    )
    expect(findGcpsEffects(t, { sparsePoints: 10 }).match).toMatch(/^Choose the reference DEM/)
    expect(findGcpsEffects(t).pick).toMatch(/within three times the fit's RMS/)
  })

  it('words the pick: the limit, its grid and the stable ground', () => {
    expect(findGcpsEffects(S).pick).toMatch(
      /^Up to 90 sparse tracks .* next to a verified match, .* 9 × 9 grid .*; anywhere\.$/,
    )
    expect(findGcpsEffects({ ...S, candidates: 30 }, { stableName: 'Rock', stablePolygons: 12 }).pick).toMatch(
      /5 × 5 grid of the block; only inside the 12 polygons of "Rock"\.$/,
    )
  })

  it('counts the review and the missing heights', () => {
    expect(findGcpsEffects(S).review).toMatch(/^Find candidates first/)
    const found = { total: 40, selected: 12, control: 10, check: 2, withoutZ: 5 }
    const e = findGcpsEffects(S, { found })
    expect(e.review).toBe('12 of 40 candidates selected: 10 control, 2 checkpoints. Only selected rows are added.')
    expect(e.heights).toMatch(/^5 of the 12 selected have no height/)
    expect(findGcpsEffects(S, { found: { ...found, withoutZ: 0 } }).heights).toBe('All 12 selected have a height.')
    expect(findGcpsEffects(S, { found: { ...found, selected: 1, withoutZ: 0 } }).heights).toBe(
      'The selected candidate has a height.',
    )
    expect(findGcpsEffects(S, { found: { ...found, selected: 0 } }).heights).toMatch(/^Select candidates/)
    expect(findGcpsEffects(S, { found: { total: 0 } }).review).toBe('No candidates were found.')
  })

  it('says where the reference is searched, and what would narrow it', () => {
    const area = (a, m = S) => findGcpsEffects(m, { area: a }).area
    expect(area({ source: 'manual', name: 'Box', polygons: 1 })).toMatch(/within the 1 polygon of "Box"/)
    expect(area({ source: 'ortho' })).toMatch(/georeferenced orthophoto's footprint/)
    expect(area({ source: 'footprints', footprintImages: 12 })).toMatch(/footprints of 12 photos/)
    expect(area({ source: 'gps', gpsImages: 40 })).toMatch(/GPS positions of 40 photos.*footprints would give/)
    expect(area({ source: null, poses: 40 })).toMatch(
      /whole reference .* Compute the footprints from the 40 camera poses/,
    )
    expect(area({})).toMatch(/whole reference .* Import a polygon layer/)
    expect(area({ source: 'gps' }, { ...S, matcher: 'terrain' })).toMatch(/search area is not used/)
  })
})
