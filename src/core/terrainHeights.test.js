import { describe, it, expect } from 'vitest'
import { tileCoords, terrainZoom, terrainSampler, TERRAIN_MAX_ZOOM, TERRAIN_MAX_TILES } from './terrainHeights.js'

// A 4×4 tile whose height is 10·column + 1000·row (pixel centres).
const W = 4
const ramp = () => ({
  elev: Float32Array.from({ length: W * W }, (_, i) => 10 * (i % W) + 1000 * Math.floor(i / W)),
  w: W,
  h: W,
})

describe('tileCoords', () => {
  it('puts lon/lat 0/0 at the centre of the world', () => {
    const [x, y] = tileCoords(0, 0, 3)
    expect(x).toBeCloseTo(4, 9)
    expect(y).toBeCloseTo(4, 9)
  })
})

describe('terrainZoom', () => {
  it('reads a small area at the finest level', () => {
    expect(terrainZoom([8.0, 50.0, 8.05, 50.03])).toBe(TERRAIN_MAX_ZOOM)
  })
  it('steps down for a large area', () => {
    const box = [5, 45, 15, 55]
    const z = terrainZoom(box)
    expect(z).toBeLessThan(TERRAIN_MAX_ZOOM)
    const [x0, y0] = tileCoords(box[0], box[3], z).map(Math.floor)
    const [x1, y1] = tileCoords(box[2], box[1], z).map(Math.floor)
    expect((x1 - x0 + 1) * (y1 - y0 + 1)).toBeLessThanOrEqual(TERRAIN_MAX_TILES)
  })
})

describe('terrainSampler', () => {
  it('interpolates between pixel centres and fetches each tile once', async () => {
    let loads = 0
    const s = terrainSampler(0, {
      loadTile: () => {
        loads++
        return ramp()
      },
    })
    // Level 0 is one tile; lon 0 is its middle column edge (pixel x = 2 → between centres 1 and 2).
    const h = await s.heightAt(0, 0)
    expect(h).toBeCloseTo(15 + 1500, 6)
    await s.heightAt(10, 10)
    expect(loads).toBe(1)
  })

  it('clamps at the tile edge', async () => {
    const s = terrainSampler(0, { loadTile: ramp })
    expect(await s.heightAt(-180, 85)).toBeCloseTo(0, 6)
  })

  it('returns null and keeps the first error for a tile that fails', async () => {
    const s = terrainSampler(2, {
      loadTile: () => {
        throw new Error('offline')
      },
    })
    expect(await s.heightAt(0, 0)).toBeNull()
    expect(s.error).toBe('offline')
  })

  it('prefetches every tile of a box', async () => {
    const seen = new Set()
    const s = terrainSampler(3, {
      loadTile: (z, x, y) => {
        seen.add(`${x}/${y}`)
        return ramp()
      },
    })
    await s.prefetch([-10, -10, 10, 10])
    expect(seen.size).toBe(4)
    expect(s.tileCount).toBe(4)
  })
})
