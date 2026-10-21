import { describe, it, expect } from 'vitest'
import {
  rasterizeDem,
  suggestGsd,
  cellCenter,
  stageDemPoints,
  coreExtent,
  fillEnclosedGaps,
  demGeometry,
  rasterizeDemBlocks,
} from './dem.js'
import { SparsePoints } from '../sfm/sparsePoints.js'

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
      { x: 0, y: 0, z: 1 },
      { x: 10, y: 0, z: 1 },
      { x: 0, y: 10, z: 9 },
      { x: 10, y: 10, z: 9 },
    ]
    const dem = rasterizeDem(pts, { gsd: 1, aggregate: 'max', fillRadius: 0 })
    // Top row (row 0) corresponds to y=10 → height 9; bottom row → y=0 → height 1.
    expect(dem.data[0]).toBeCloseTo(9) // top-left
    expect(dem.data[(dem.height - 1) * dem.width]).toBeCloseTo(1) // bottom-left
    const [cx, cy] = cellCenter(dem, 0, 0)
    expect(cx).toBeCloseTo(dem.originX + 0.5)
    expect(cy).toBeCloseTo(dem.originY - 0.5)
  })

  it('takes the max height per cell for a DSM (default)', () => {
    // Two points sit in the same cell (col 2, row 2 for gsd 1, extent 0..5);
    // a DSM keeps the higher (7). A 'min' aggregate keeps the lower (2).
    const pts = [
      { x: 2.2, y: 2.2, z: 2 },
      { x: 2.4, y: 2.4, z: 7 },
      { x: 5, y: 5, z: 3 },
    ]
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
      pts.push({ x: 5 + 3 * Math.cos((a * Math.PI) / 180), y: 5 + 3 * Math.sin((a * Math.PI) / 180), z: 4 })
    }
    const noFill = rasterizeDem(pts, { gsd: 1, fillRadius: 0 })
    const filled = rasterizeDem(pts, { gsd: 1, fillRadius: 4 })
    expect(filled.count).toBeGreaterThanOrEqual(noFill.count)
    expect(filled.filled).toBeGreaterThan(0)
  })

  it('supports nearest-neighbour interpolation and an explicit off switch', () => {
    const pts = [
      { x: 0, y: 0, z: 2 },
      { x: 4, y: 0, z: 10 },
      { x: 0, y: 4, z: 2 },
      { x: 4, y: 4, z: 10 },
    ]
    const nearest = rasterizeDem(pts, { gsd: 1, fillMethod: 'nearest', fillRadius: 2 })
    const off = rasterizeDem(pts, { gsd: 1, fillMethod: 'none', fillRadius: 20 })
    expect(nearest.filled).toBeGreaterThan(0)
    expect([...nearest.data].filter(Number.isFinite).every((z) => z === 2 || z === 10)).toBe(true)
    expect(off.filled).toBe(0)
  })

  it('caps the grid size via maxGrid by growing gsd', () => {
    const pts = [
      { x: 0, y: 0, z: 0 },
      { x: 1000, y: 1000, z: 1 },
    ]
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
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
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
      if (!b) {
        expect(Number.isNaN(dem.data[i])).toBe(true)
        continue
      }
      b.sort((a, c) => a - c)
      expect(dem.data[i]).toBe(Math.fround(b[b.length >> 1]))
    }
  })

  it('refuses a grid over the given budget, naming the size', () => {
    const pts = [
      { x: 0, y: 0, z: 0 },
      { x: 99, y: 99, z: 1 },
    ]
    expect(() => rasterizeDem(pts, { gsd: 1, memBudgetBytes: 100 * 100 * 24 - 1 })).toThrow(
      /\(100×100\) needs .*working-memory limit/,
    )
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

  it('stages a sparse cloud through its pos column', () => {
    const points = SparsePoints.fromRecords([{ x: 1, y: 2, z: 3 }])
    const s = stageDemPoints({ count: points.length, pos: points.pos })
    expect([...s.pos]).toEqual([1, 2, 3])
  })

  it('checks the in-region count, not the cloud size, against the budget', () => {
    expect(() => stageDemPoints(dense, { budgetBytes: 3 * 24 - 1 })).toThrow(/memory budget/)
    expect(stageDemPoints(dense, { budgetBytes: 2 * 24, inside: (x) => x > 1 }).count).toBe(2)
  })
})

describe('coreExtent', () => {
  let seed = 11
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
  const pack = (pts) => {
    const a = new Float64Array(pts.length * 3)
    pts.forEach((p, i) => {
      a[i * 3] = p[0]
      a[i * 3 + 1] = p[1]
    })
    return a
  }

  it("keeps an oblique capture's site and drops its thin far field", () => {
    // 20 × 20 site with 40k points; 4k points thinning out over 2 km to the south.
    const pts = []
    for (let i = 0; i < 40000; i++) pts.push([rnd() * 20, rnd() * 20])
    for (let i = 0; i < 4000; i++) {
      const d = 20 + 2000 * rnd() ** 2
      pts.push([rnd() * 400 - 190, -d])
    }
    const e = coreExtent(pack(pts), pts.length)
    // Within a few metres of the site (the far field starts at its southern edge,
    // so adjacent ground may stay); the 2 km of thin background is gone.
    expect(e.minX).toBeGreaterThan(-10)
    expect(e.maxX).toBeLessThan(30)
    expect(e.maxY).toBeLessThan(25)
    expect(e.minY).toBeGreaterThan(-40)
    expect(e.inside).toBeGreaterThan(40000 * 0.99)
  })

  it('loses nothing from a uniform cloud', () => {
    const pts = Array.from({ length: 20000 }, () => [rnd() * 100, rnd() * 50])
    const e = coreExtent(pack(pts), pts.length)
    expect(e.inside).toBeGreaterThan(pts.length * 0.99)
    expect(coreExtent(pack([[1, 1]]), 1)).toBeNull()
  })

  it('rasterizeDem leaves points outside the bounds out instead of clamping them', () => {
    const pts = [
      { x: 0, y: 0, z: 1 },
      { x: 4, y: 0, z: 1 },
      { x: 0, y: 4, z: 1 },
      { x: 4, y: 4, z: 1 },
      { x: 500, y: 2, z: 99 },
    ]
    const dem = rasterizeDem(pts, { gsd: 1, fillRadius: 0, bounds: { minX: 0, minY: 0, maxX: 4, maxY: 4 } })
    expect(dem.width).toBe(5)
    expect(dem.zMax).toBe(1) // the far point's 99 did not land on the border
  })
})

describe('fillEnclosedGaps', () => {
  // A tilted plane z = 0.5·col + 0.25·row on a w×h grid.
  const plane = (w, h) => {
    const d = new Float32Array(w * h)
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) d[r * w + c] = 0.5 * c + 0.25 * r
    return d
  }

  it('fills a building-sized hole close to the surrounding plane', () => {
    const w = 64,
      h = 48
    const d = plane(w, h)
    for (let r = 15; r < 35; r++) for (let c = 20; c < 45; c++) d[r * w + c] = NaN
    expect(fillEnclosedGaps(d, w, h)).toBe(20 * 25)
    let worst = 0
    for (let r = 15; r < 35; r++) {
      for (let c = 20; c < 45; c++) worst = Math.max(worst, Math.abs(d[r * w + c] - (0.5 * c + 0.25 * r)))
    }
    // Pull–push is smooth, not exact on a plane; the hole spans 12.5 height units.
    expect(worst).toBeLessThan(1.5)
  })

  it('leaves nodata that reaches the border alone', () => {
    const w = 20,
      h = 20
    const d = plane(w, h)
    for (let r = 0; r < 20; r++) for (let c = 15; c < 20; c++) d[r * w + c] = NaN // survey edge
    for (let r = 5; r < 9; r++) for (let c = 5; c < 9; c++) d[r * w + c] = NaN // enclosed
    expect(fillEnclosedGaps(d, w, h)).toBe(16)
    for (let r = 0; r < 20; r++) for (let c = 15; c < 20; c++) expect(Number.isNaN(d[r * w + c])).toBe(true)
    for (let r = 5; r < 9; r++) for (let c = 5; c < 9; c++) expect(Number.isFinite(d[r * w + c])).toBe(true)
  })

  it('does nothing on a full or an empty grid', () => {
    expect(fillEnclosedGaps(plane(5, 5), 5, 5)).toBe(0)
    expect(fillEnclosedGaps(new Float32Array(9).fill(NaN), 3, 3)).toBe(0)
  })

  it('is applied by rasterizeDem when fillHoles is set', () => {
    // Ground ring around an empty 6×6 courtyard (a removed building).
    const pts = []
    for (let x = 0; x <= 20; x++) {
      for (let y = 0; y <= 20; y++) if (!(x >= 7 && x <= 13 && y >= 7 && y <= 13)) pts.push({ x, y, z: 1 })
    }
    const off = rasterizeDem(pts, { gsd: 1, fillRadius: 1 })
    const on = rasterizeDem(pts, { gsd: 1, fillRadius: 1, fillHoles: true })
    expect(on.holesFilled).toBeGreaterThan(0)
    expect(on.count + on.filled).toBe(on.width * on.height)
    expect(off.count + off.filled).toBeLessThan(off.width * off.height)
    expect(on.zMax).toBeCloseTo(1, 5)
  })
})

describe('stageDemPoints index filter', () => {
  it('passes the point index to the predicate', () => {
    const cloud = { count: 4, pos: new Float32Array([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3]) }
    const cls = Uint8Array.from([2, 1, 2, 7])
    const staged = stageDemPoints(cloud, { inside: (x, y, z, i) => cls[i] === 2 })
    expect(staged.count).toBe(2)
    expect(Array.from(staged.pos)).toEqual([0, 0, 0, 2, 2, 2])
  })
})

describe('rasterizeDemBlocks (a DEM past one plane, SAT-3)', () => {
  // Rolling terrain with sparse, uneven coverage, so the fill reaches across block edges.
  let seed = 7
  const random = () => {
    seed = (1664525 * seed + 1013904223) >>> 0
    return seed / 4294967296
  }
  const n = 4000
  const pos = new Float64Array(3 * n)
  for (let i = 0; i < n; i++) {
    const x = random() * 100,
      y = random() * 60
    pos[3 * i] = x
    pos[3 * i + 1] = y
    pos[3 * i + 2] = 50 + 10 * Math.sin(x / 9) + 5 * Math.cos(y / 7) + random()
  }
  const points = Array.from({ length: n }, (_, i) => ({ x: pos[3 * i], y: pos[3 * i + 1], z: pos[3 * i + 2] }))

  it.each(['max', 'mean', 'median'])(
    'reproduces the single-plane grid exactly (%s, IDW radius 3)',
    async (aggregate) => {
      const opts = { gsd: 1.3, aggregate, fillMethod: 'idw', fillRadius: 3, maxGrid: Infinity }
      const whole = rasterizeDem(points, opts)
      const geom = demGeometry(points, opts)
      const out = new Float32Array(geom.width * geom.height)
      const res = await rasterizeDemBlocks(
        pos,
        n,
        geom,
        { ...opts, blockSize: 16 },
        {
          onBlock: ({ col0, row0, width, height, data }) => {
            for (let r = 0; r < height; r++)
              out.set(data.subarray(r * width, (r + 1) * width), (row0 + r) * geom.width + col0)
          },
        },
      )
      expect([res.width, res.height]).toEqual([whole.width, whole.height])
      expect(res.blocks).toBe(Math.ceil(whole.width / 16) * Math.ceil(whole.height / 16))
      for (let i = 0; i < out.length; i++) {
        if (Number.isNaN(whole.data[i])) expect(out[i]).toBeNaN()
        else expect(out[i]).toBeCloseTo(whole.data[i], 5)
      }
      expect(res.count).toBe(whole.count)
      expect(res.filled).toBe(whole.filled)
      expect(res.zMin).toBeCloseTo(whole.zMin, 5)
      expect(res.zMax).toBeCloseTo(whole.zMax, 5)
    },
  )

  it('leaves out points beyond the bounds rather than piling them on the edge', async () => {
    const opts = { gsd: 2, fillMethod: 'none', maxGrid: Infinity, bounds: { minX: 10, minY: 10, maxX: 50, maxY: 40 } }
    const whole = rasterizeDem(points, opts)
    const geom = demGeometry(points, opts)
    const out = new Float32Array(geom.width * geom.height)
    await rasterizeDemBlocks(
      pos,
      n,
      geom,
      { ...opts, blockSize: 8 },
      {
        onBlock: ({ col0, row0, width, height, data }) => {
          for (let r = 0; r < height; r++)
            out.set(data.subarray(r * width, (r + 1) * width), (row0 + r) * geom.width + col0)
        },
      },
    )
    for (let i = 0; i < out.length; i++) {
      if (Number.isNaN(whole.data[i])) expect(out[i]).toBeNaN()
      else expect(out[i]).toBeCloseTo(whole.data[i], 5)
    }
  })
})
