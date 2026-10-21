import { describe, it, expect } from 'vitest'
import {
  gsdForLongSide,
  orthoGridFor,
  orthoDemSurface,
  demGridFor,
  DEM_PLANE_MAX,
  MAX_RASTER_SIDE,
} from './rasterSize.js'
import { demGeometry } from './dem.js'
import { gridGeometry } from './surface.js'

const surface = (width, height, gsd) => ({ width, height, gsd, originX: 1000, originY: 5000 })

describe('a raster size as its long side in pixels', () => {
  it('gives exactly that many cells on the longer side', () => {
    for (const [span, n] of [
      [100, 2],
      [123.456, 4096],
      [987.6, 12345],
      [3, 7],
    ]) {
      const g = gridGeometry(0, 0, span, span / 3, gsdForLongSide(span, n), Infinity)
      expect(g.width).toBe(n)
    }
    expect(gsdForLongSide(100, 1)).toBe(0)
    expect(gsdForLongSide(0, 500)).toBe(0)
  })

  it('sizes an ortho by its long side over the surface, and a cell size wins over it', () => {
    const s = surface(2000, 1000, 0.5)
    expect(orthoGridFor(s, { longSide: 8000 }).geom.width).toBe(8000)
    expect(orthoGridFor(s, { gsd: 0.25, longSide: 8000 }).geom.gsd).toBe(0.25)
    // Auto: the surface's own cells.
    expect(orthoGridFor(s, {}).geom).toMatchObject({ width: 2000, height: 1000, identity: true })
  })

  it('keeps an ortho past 4 GiB (a BigTIFF), and coarsens only past the side cap, saying so', () => {
    // 40,001² RGBA is 6.4 GB: kept as asked.
    const big = orthoGridFor(surface(4000, 4000, 1), { gsd: 0.1 })
    expect(big.coarsened).toBe(false)
    expect(big.geom.width).toBe(40001)
    // 80,001 a side is past the cap: coarsened to it.
    const { geom, coarsened, want } = orthoGridFor(surface(4000, 4000, 1), { gsd: 0.05 })
    expect(want).toBe(0.05)
    expect(coarsened).toBe(true)
    expect(Math.max(geom.width, geom.height)).toBeLessThanOrEqual(MAX_RASTER_SIDE)
  })

  it('reads a block-built DEM surface at the level the budget allows, as the worker does', () => {
    const dem = { cog: {}, fullWidth: 20000, fullHeight: 10000, fullGsd: 0.1, originX: 0, originY: 0, tileSize: 512 }
    // 2 GiB → 85.9 M cells: level 1 (10,000 × 5,000) is the finest that fits.
    expect(orthoDemSurface(dem, 2 * 1024 ** 3)).toMatchObject({ width: 10000, height: 5000, gsd: 0.2 })
    expect(orthoDemSurface({ width: 300, height: 200, gsd: 1, originX: 0, originY: 0 }, 1)).toMatchObject({
      width: 300,
    })
  })
})

describe('the DEM grid the readout shows is the one the run builds', () => {
  // A cloud filling a 400 × 300 box with 120,000 points.
  const pts = []
  for (let i = 0; i < 120000; i++) pts.push({ x: (i % 400) + 0.5 * ((i * 7) % 2), y: Math.floor(i / 400), z: 0 })
  const box = {
    minX: Math.min(...pts.map((p) => p.x)),
    maxX: Math.max(...pts.map((p) => p.x)),
    minY: 0,
    maxY: Math.max(...pts.map((p) => p.y)),
  }

  it('auto: about one point per cell, in one plane', () => {
    const est = demGridFor(box, pts.length, {})
    const run = demGeometry(pts, {})
    expect(est.blocks).toBe(false)
    expect(est.geom.width).toBe(run.width)
    expect(est.geom.height).toBe(run.height)
  })

  it('a long side in px, in the plane and past it', () => {
    expect(demGridFor(box, pts.length, { longSide: 1000 }).geom.width).toBe(demGeometry(pts, { longSide: 1000 }).width)
    expect(demGeometry(pts, { longSide: 1000 }).width).toBe(1000)
    const big = demGridFor(box, pts.length, { longSide: 9000 })
    expect(big.blocks).toBe(true)
    expect(big.geom.width).toBe(9000)
  })

  it('caps an auto DEM at one plane and flags it', () => {
    const est = demGridFor({ minX: 0, maxX: 10000, minY: 0, maxY: 100 }, 1e9, {})
    expect(est.geom.width).toBe(DEM_PLANE_MAX)
    expect(est.coarsened).toBe(true)
  })
})
