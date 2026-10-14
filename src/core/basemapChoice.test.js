import { describe, it, expect } from 'vitest'
import { chooseBasemap } from './basemapChoice.js'

const UTM = { basemap: 'osm', geographic: false }
const POLAR = { basemap: 'gibs', geographic: false }
const NO_TILES = { basemap: null, geographic: false }

describe('chooseBasemap', () => {
  it('maps each explicit choice to its layer in an ordinary CRS', () => {
    expect(chooseBasemap('satellite', UTM, false)).toEqual({ kind: 'satellite', note: '' })
    expect(chooseBasemap('terrain', UTM, false)).toEqual({ kind: 'terrain', note: '' })
    expect(chooseBasemap('streets', UTM, false)).toEqual({ kind: 'osm', note: '' })
    expect(chooseBasemap('none', UTM, false)).toEqual({ kind: null, note: '' })
  })

  it('Automatic follows the CRS: OSM, GIBS for the polar presets, else grid only', () => {
    expect(chooseBasemap('auto', UTM, false).kind).toBe('osm')
    expect(chooseBasemap('auto', POLAR, false).kind).toBe('gibs')
    expect(chooseBasemap('auto', NO_TILES, false).kind).toBeNull()
  })

  it('Streets uses OSM everywhere, even where Automatic would not', () => {
    expect(chooseBasemap('streets', POLAR, false).kind).toBe('osm')
    expect(chooseBasemap('streets', NO_TILES, false).kind).toBe('osm')
  })

  it('falls a choice the CRS cannot show back to Automatic, and says so', () => {
    const r = chooseBasemap('satellite', POLAR, false)
    expect(r.kind).toBe('gibs')
    expect(r.note).toBe('Satellite base layer is not available for this coordinate system — showing the automatic one.')
    expect(chooseBasemap('terrain', POLAR, false).note).toMatch(/^Terrain base layer is not available/)
  })

  it('never gives the model frame a basemap, nor a note', () => {
    for (const v of ['auto', 'streets', 'satellite', 'terrain', 'none']) {
      expect(chooseBasemap(v, { geographic: false, basemap: null }, true)).toEqual({ kind: null, note: '' })
    }
  })
})
