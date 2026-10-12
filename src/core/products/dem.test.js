import { describe, it, expect } from 'vitest'
import { rasterizeDem, suggestGsd, cellCenter, stageDemPoints, coreExtent } from './dem.js'

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

describe('rasterizeDem median', () => {
  // The typed counting-sort median must pick exactly what a per-cell sorted
  // bucket picks (sorted[len >> 1]), including even counts and empty cells.
  it('matches a per-cell bucket reference', () => {
    let seed = 7
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
    const pts = []
    for (let i = 0; i < 2000; i++) pts.push({ x: rnd() * 20, y: rnd() * 20, z: rnd() * 100 })
    const dem = rasterizeDem(pts, { gsd: 1, aggregate: 'median', fillRadius: 0 })
    const buckets = new Map()
    for (const p of pts) {
      const col = Math.min(dem.width - 1, Math.floor((p.x - dem.originX) / dem.gsd))
      const row = Math.min(dem.height - 1, Math.floor((dem.originY - p.y) / dem.gsd))
      const k = row * dem.width + col
      if (!buckets.has(k)) buckets.set(k, [])
      buckets.get(k).push(p.z)
    }
    for (let i = 0; i < dem.width * dem.height; i++) {
      const b = buckets.get(i)
      if (!b) { expect(Number.isNaN(dem.data[i])).toBe(true); continue }
      b.sort((a, c) => a - c)
      expect(dem.data[i]).toBe(Math.fround(b[b.length >> 1]))
    }
  })

  it('refuses a grid over the given budget, naming the size', () => {
    const pts = [{ x: 0, y: 0, z: 0 }, { x: 99, y: 99, z: 1 }]
    expect(() => rasterizeDem(pts, { gsd: 1, memBudgetBytes: 100 * 100 * 24 - 1 })).toThrow(/\(100×100\) needs .*working-memory limit/)
    expect(rasterizeDem(pts, { gsd: 1, memBudgetBytes: 100 * 100 * 24 })).not.toBeNull()
  })
})

describe('stageDemPoints', () => {
  const dense = { count: 3, pos: new Float64Array([0, 0, 1, 5, 5, 2, 9, 9, 3, 99]) }

  it('copies a dense cloud into a fresh buffer without touching the source', () => {
    const s = stageDemPoints(dense)
    expect([...s.pos]).toEqual([0, 0, 1, 5, 5, 2, 9, 9, 3])
    expect(s.pos.buffer).not.toBe(dense.pos.buffer)
    expect(s).toMatchObject({ count: 3, total: 3 })
  })

  it('copies only in-region points, sized to the survivors', () => {
    const s = stageDemPoints(dense, { inside: (x) => x > 1 })
    expect([...s.pos]).toEqual([5, 5, 2, 9, 9, 3])
    expect(s).toMatchObject({ count: 2, total: 3 })
  })

  it('stages sparse point objects', () => {
    const s = stageDemPoints({ points: [{ x: 1, y: 2, z: 3 }] })
    expect([...s.pos]).toEqual([1, 2, 3])
  })

  it('checks the in-region count, not the cloud size, against the budget', () => {
    expect(() => stageDemPoints(dense, { budgetBytes: 3 * 24 - 1 })).toThrow(/memory budget/)
    expect(stageDemPoints(dense, { budgetBytes: 2 * 24, inside: (x) => x > 1 }).count).toBe(2)
  })
})

describe('coreExtent', () => {
  let seed = 11
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
  const pack = (pts) => { const a = new Float64Array(pts.length * 3); pts.forEach((p, i) => { a[i * 3] = p[0]; a[i * 3 + 1] = p[1] }); return a }

  it('keeps an oblique capture\'s site and drops its thin far field', () => {
    // 20 × 20 site with 40k points; 4k points thinning out over 2 km to the south.
    const pts = []
    for (let i = 0; i < 40000; i++) pts.push([rnd() * 20, rnd() * 20])
    for (let i = 0; i < 4000; i++) { const d = 20 + 2000 * rnd() ** 2; pts.push([rnd() * 400 - 190, -d]) }
    const e = coreExtent(pack(pts), pts.length)
    // Within a few metres of the site (the far field starts at its southern edge,
    // so adjacent ground may stay); the 2 km of thin background is gone.
    expect(e.minX).toBeGreaterThan(-10); expect(e.maxX).toBeLessThan(30)
    expect(e.maxY).toBeLessThan(25); expect(e.minY).toBeGreaterThan(-40)
    expect(e.inside).toBeGreaterThan(40000 * 0.99)
  })

  it('loses nothing from a uniform cloud', () => {
    const pts = Array.from({ length: 20000 }, () => [rnd() * 100, rnd() * 50])
    const e = coreExtent(pack(pts), pts.length)
    expect(e.inside).toBeGreaterThan(pts.length * 0.99)
    expect(coreExtent(pack([[1, 1]]), 1)).toBeNull()
  })

  it('rasterizeDem leaves points outside the bounds out instead of clamping them', () => {
    const pts = [{ x: 0, y: 0, z: 1 }, { x: 4, y: 0, z: 1 }, { x: 0, y: 4, z: 1 }, { x: 4, y: 4, z: 1 }, { x: 500, y: 2, z: 99 }]
    const dem = rasterizeDem(pts, { gsd: 1, fillRadius: 0, bounds: { minX: 0, minY: 0, maxX: 4, maxY: 4 } })
    expect(dem.width).toBe(5)
    expect(dem.zMax).toBe(1) // the far point's 99 did not land on the border
  })
})
