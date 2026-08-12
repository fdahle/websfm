import { describe, it, expect } from 'vitest'
import { rasterizeDem, suggestGsd, cellCenter } from './dem.js'

describe('suggestGsd', () => {
  it('scales as √(area/n)', () => {
    // 10×10 area, 100 points ⇒ ~1 unit/cell.
    const pts = []
    for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) pts.push({ x: i, y: j, z: 0 })
    const gsd = suggestGsd(pts)
    expect(gsd).toBeGreaterThan(0.5)
    expect(gsd).toBeLessThan(1.5)
  })
})

describe('rasterizeDem', () => {
  it('rasterises a flat sheet to a single height', () => {
    const pts = []
    for (let x = 0; x <= 10; x++) for (let y = 0; y <= 10; y++) pts.push({ x, y, z: 5 })
    const dem = rasterizeDem(pts, { gsd: 1, fillRadius: 0 })
    expect(dem.zMin).toBeCloseTo(5)
    expect(dem.zMax).toBeCloseTo(5)
    expect(dem.count).toBe(dem.width * dem.height)
  })

  it('uses a top-left origin: row 0 is the max-Y edge', () => {
    const pts = [
      { x: 0, y: 0, z: 1 }, { x: 10, y: 0, z: 1 },
      { x: 0, y: 10, z: 9 }, { x: 10, y: 10, z: 9 },
    ]
    const dem = rasterizeDem(pts, { gsd: 1, aggregate: 'max', fillRadius: 0 })
    // Top row (row 0) corresponds to y=10 → height 9; bottom row → y=0 → height 1.
    expect(dem.data[0]).toBeCloseTo(9)                              // top-left
    expect(dem.data[(dem.height - 1) * dem.width]).toBeCloseTo(1)   // bottom-left
    const [cx, cy] = cellCenter(dem, 0, 0)
    expect(cx).toBeCloseTo(dem.originX + 0.5)
    expect(cy).toBeCloseTo(dem.originY - 0.5)
  })

  it('takes the max height per cell for a DSM (default)', () => {
    // Two points sit in the same cell (col 2, row 2 for gsd 1, extent 0..5);
    // a DSM keeps the higher (7). A 'min' aggregate keeps the lower (2).
    const pts = [{ x: 2.2, y: 2.2, z: 2 }, { x: 2.4, y: 2.4, z: 7 }, { x: 5, y: 5, z: 3 }]
    const max = rasterizeDem(pts, { gsd: 1, aggregate: 'max', fillRadius: 0 })
    const min = rasterizeDem(pts, { gsd: 1, aggregate: 'min', fillRadius: 0 })
    // Locate the cell the two co-located points fall in (origin = point bbox).
    const col = Math.floor((2.2 - max.originX) / max.gsd)
    const row = Math.floor((max.originY - 2.2) / max.gsd)
    const idx = row * max.width + col
    expect(max.data[idx]).toBeCloseTo(7)
    expect(min.data[idx]).toBeCloseTo(2)
    expect(max.zMax).toBeCloseTo(7)
  })

  it('fills interior holes by IDW but leaves them NaN with fillRadius 0', () => {
    // A ring of points around an empty centre cell.
    const pts = []
    for (let a = 0; a < 360; a += 20) {
      pts.push({ x: 5 + 3 * Math.cos(a * Math.PI / 180), y: 5 + 3 * Math.sin(a * Math.PI / 180), z: 4 })
    }
    const noFill = rasterizeDem(pts, { gsd: 1, fillRadius: 0 })
    const filled = rasterizeDem(pts, { gsd: 1, fillRadius: 4 })
    expect(filled.count).toBeGreaterThanOrEqual(noFill.count)
    expect(filled.filled).toBeGreaterThan(0)
  })

  it('supports nearest-neighbour interpolation and an explicit off switch', () => {
    const pts = [
      { x: 0, y: 0, z: 2 }, { x: 4, y: 0, z: 10 },
      { x: 0, y: 4, z: 2 }, { x: 4, y: 4, z: 10 },
    ]
    const nearest = rasterizeDem(pts, { gsd: 1, fillMethod: 'nearest', fillRadius: 2 })
    const off = rasterizeDem(pts, { gsd: 1, fillMethod: 'none', fillRadius: 20 })
    expect(nearest.filled).toBeGreaterThan(0)
    expect([...nearest.data].filter(Number.isFinite).every((z) => z === 2 || z === 10)).toBe(true)
    expect(off.filled).toBe(0)
  })

  it('caps the grid size via maxGrid by growing gsd', () => {
    const pts = [{ x: 0, y: 0, z: 0 }, { x: 1000, y: 1000, z: 1 }]
    const dem = rasterizeDem(pts, { gsd: 0.1, maxGrid: 64, fillRadius: 0 })
    expect(Math.max(dem.width, dem.height)).toBeLessThanOrEqual(64)
    expect(dem.gsd).toBeGreaterThan(0.1)
  })

  it('returns null for degenerate input', () => {
    expect(rasterizeDem([], {})).toBeNull()
    expect(rasterizeDem([{ x: 1, y: 1, z: 0 }], { gsd: 1 })).toBeNull()
  })
})
