import { describe, it, expect } from 'vitest'
import { terrainEffects } from './terrain.js'
import { TERRAIN_DEFAULTS } from '../defaults.user.js'

describe('terrainEffects', () => {
  it('words each product and the files', () => {
    const e = terrainEffects({ ...TERRAIN_DEFAULTS, compression: 'deflate' })
    expect(e.slope).toBe('Steepness of every cell, in degrees.')
    expect(e.aspect).toBe('Off.')
    expect(e.hillshade).toBe('Shaded by a sun from 315° (north-west), 45° above the horizon.')
    expect(e.save).toBe('2 GeoTIFFs on the DEM’s grid and CRS, DEFLATE-compressed.')
    expect(terrainEffects({ ...TERRAIN_DEFAULTS, products: [] }).save).toMatch(/^Pick at least one/)
  })
})
