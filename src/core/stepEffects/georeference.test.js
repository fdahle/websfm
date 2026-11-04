import { describe, it, expect } from 'vitest'
import { georeferenceReasons, georeferenceMethods, georeferenceSource, georeferenceFitEffect } from './georeference.js'

const ready = { hasMatches: true, gcps: 5, poses: 40, adjustReady: true, transformReady: true }

describe('georeferenceReasons', () => {
  it('lets every method run with enough control', () => {
    expect(georeferenceReasons(ready)).toEqual({ adjust: null, dem: null, transform: null })
  })
  it('says why each method cannot run', () => {
    const deg = georeferenceReasons({ ...ready, geographic: true })
    expect(deg.adjust).toMatch(/degrees/)
    expect(deg.dem).toMatch(/degrees/)
    expect(deg.transform).toMatch(/degrees/)
    const unmatched = georeferenceReasons({ ...ready, hasMatches: false })
    expect(unmatched.adjust).toMatch(/Match features/)
    expect(unmatched.dem).toMatch(/Match features/)
    expect(unmatched.transform).toBeNull()
    expect(georeferenceReasons({ ...ready, adjustReady: false }).adjust).toMatch(/two aligned photos/)
    expect(georeferenceReasons({ ...ready, gcps: 2, poses: 2 }).dem).toMatch(/three or more/)
    expect(georeferenceReasons({ ...ready, transformReady: false }).transform).toMatch(/sparse model/)
  })
})

describe('georeferenceMethods', () => {
  it('disables a card with its reason as the tooltip', () => {
    const cards = georeferenceMethods({ ...ready, adjustReady: false })
    expect(cards.map((c) => c.id)).toEqual(['adjust', 'dem', 'transform'])
    expect(cards[0]).toMatchObject({ disabled: true, reason: expect.stringMatching(/GCPs/) })
    expect(cards[2]).toMatchObject({ disabled: false, reason: null })
  })
})

describe('georeferenceSource', () => {
  it('reads out the CRS and the control', () => {
    expect(georeferenceSource({ crs: 'EPSG:32632', crsName: 'UTM zone 32N (WGS 84)', gcps: 1, poses: 42 })).toEqual({
      crs: 'EPSG:32632 · UTM zone 32N (WGS 84)',
      control: '1 GCP with coordinates · 42 camera positions',
    })
    expect(georeferenceSource({ crs: 'EPSG:9999', crsName: 'EPSG:9999' }).crs).toBe('EPSG:9999')
    expect(georeferenceSource().crs).toBe('Not set')
  })
})

describe('georeferenceFitEffect', () => {
  it('says what moves and what is fitted', () => {
    expect(georeferenceFitEffect('adjust', { crs: 'EPSG:32632', gcps: 5 })).toMatch(
      /rebuilds the model with 5 GCPs held .* fitted into EPSG:32632/,
    )
    expect(georeferenceFitEffect('transform', { crs: 'EPSG:32632', adjustReady: true })).toMatch(
      /fitted to the GCPs\. Cameras and points keep their shape/,
    )
    expect(georeferenceFitEffect('transform', { adjustReady: false })).toMatch(/the project CRS, fitted to the aligned/)
  })
})
