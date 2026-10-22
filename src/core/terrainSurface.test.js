import { describe, it, expect } from 'vitest'
import { terrainSurface } from './terrainSurface.js'

// Every tile flat at 100 m (EGM96).
const flat = () => ({ elev: new Float32Array(16).fill(100), w: 4, h: 4 })
// A 1 km box in UTM 32N around 9° E, 45° N.
const bounds = [500000, 4983000, 501000, 4984000]

describe('terrainSurface', () => {
  it('samples the terrain in the DEM CRS, as it is when the datum is unknown', async () => {
    const s = await terrainSurface({ crs: 'EPSG:32632', bounds, loadTile: flat })
    expect(s.sample(500500, 4983500)).toBeCloseTo(100, 6)
    expect(s.datumNote).toMatch(/unknown/)
  })

  it("converts to the DEM's vertical datum", async () => {
    const s = await terrainSurface({ crs: 'EPSG:32632', bounds, datum: 'geoid:EGM96', loadTile: flat })
    expect(s.sample(500500, 4983500)).toBeCloseTo(100, 6)
    expect(s.datumNote).toBe('')
  })

  it('refuses a DEM without a CRS, one past 85°, and one whose tiles cannot be read', async () => {
    await expect(terrainSurface({ crs: 'local', bounds, loadTile: flat })).rejects.toThrow(/coordinate system/)
    await expect(terrainSurface({ crs: 'EPSG:4326', bounds: [0, -89, 1, -88], loadTile: flat })).rejects.toThrow(/85°/)
    await expect(
      terrainSurface({
        crs: 'EPSG:32632',
        bounds,
        loadTile: () => {
          throw new Error('offline')
        },
      }),
    ).rejects.toThrow(/offline/)
  })
})
