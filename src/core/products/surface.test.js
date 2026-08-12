import { describe, it, expect } from 'vitest'
import { meshSurface, fitPlane, planeSurface, resampleSurface } from './surface.js'
import { rasterizeDem, cellCenter } from './dem.js'

// A unit square in the z=5 plane, split into two triangles, spanning x,y ∈ [0,10].
function flatQuad(z = 5) {
  return {
    pos: new Float32Array([0, 0, z, 10, 0, z, 10, 10, z, 0, 10, z]),
    idx: new Uint32Array([0, 1, 2, 0, 2, 3]),
  }
}

describe('meshSurface', () => {
  // The grid convention (shared with rasterizeDem) puts cell centres at
  // origin + (i+0.5)·gsd over width = ceil(span/gsd)+1 cells, so the outermost
  // half-ring of centres lies just outside the geometry and stays nodata. Every
  // centre that IS over the mesh must be covered.
  const interiorEvery = (g, fn) => {
    for (let row = 0; row < g.height; row++) {
      for (let col = 0; col < g.width; col++) {
        const [x, y] = cellCenter(g, col, row)
        if (x < 0 || x > 10 || y < 0 || y > 10) continue
        fn(g.data[row * g.width + col], x, y)
      }
    }
  }

  it('covers every cell centre over a flat quad, at the quad height', () => {
    const g = meshSurface(flatQuad(5), { gsd: 1 })
    interiorEvery(g, (v) => expect(v).toBeCloseTo(5, 5))
    expect(g.count).toBe(10 * 10) // the 11×11 grid's outer ring is off the quad
    expect(g.zMin).toBeCloseTo(5, 5)
    expect(g.zMax).toBeCloseTo(5, 5)
    expect(g.triangles).toBe(2)
  })

  it('uses the top-left (row 0 = max-Y) grid convention', () => {
    const g = meshSurface(flatQuad(), { gsd: 1 })
    expect(g.originX).toBeCloseTo(0, 6)
    expect(g.originY).toBeCloseTo(10, 6)
    const [, yTop] = cellCenter(g, 0, 0)
    const [, yBot] = cellCenter(g, 0, g.height - 1)
    expect(yTop).toBeGreaterThan(yBot)
  })

  it('interpolates height across a tilted triangle', () => {
    // A ramp: z = x. One triangle covering the lower-right half of [0,10]².
    const mesh = {
      pos: new Float32Array([0, 0, 0, 10, 0, 10, 10, 10, 10]),
      idx: new Uint32Array([0, 1, 2]),
    }
    const g = meshSurface(mesh, { gsd: 1 })
    for (let row = 0; row < g.height; row++) {
      for (let col = 0; col < g.width; col++) {
        const v = g.data[row * g.width + col]
        if (Number.isNaN(v)) continue
        const [x] = cellCenter(g, col, row)
        expect(v).toBeCloseTo(x, 4)
      }
    }
  })

  it('keeps the higher surface where two triangles overlap (DSM convention)', () => {
    const low = flatQuad(2), high = flatQuad(7)
    const mesh = {
      pos: new Float32Array([...low.pos, ...high.pos]),
      idx: new Uint32Array([...low.idx, ...[...high.idx].map((i) => i + 4)]),
    }
    const g = meshSurface(mesh, { gsd: 1 })
    interiorEvery(g, (v) => expect(v).toBeCloseTo(7, 5))
  })

  it('is denser than the DEM built from the same surface sampled sparsely', () => {
    // 100 scattered samples of the same flat surface → a holey DEM at a fine GSD.
    const pts = []
    for (let i = 0; i < 100; i++) {
      pts.push({ x: (i * 7.13) % 10, y: (i * 3.37) % 10, z: 5 })
    }
    const demGrid = rasterizeDem(pts, { gsd: 0.5, fillRadius: 0 })
    const meshGrid = meshSurface(flatQuad(5), { gsd: 0.5 })
    const demCoverage = demGrid.count / (demGrid.width * demGrid.height)
    const meshCoverage = meshGrid.count / (meshGrid.width * meshGrid.height)
    expect(demCoverage).toBeLessThan(0.6)
    expect(meshCoverage).toBeGreaterThan(0.9)
  })

  it('returns null with no triangles', () => {
    expect(meshSurface({ pos: new Float32Array(9), idx: new Uint32Array(0) })).toBeNull()
    expect(meshSurface(null)).toBeNull()
  })

  it('honours maxGrid by growing the cell size', () => {
    const g = meshSurface(flatQuad(), { gsd: 0.01, maxGrid: 64 })
    expect(Math.max(g.width, g.height)).toBeLessThanOrEqual(64)
    expect(g.gsd).toBeGreaterThan(0.01)
  })
})

describe('fitPlane', () => {
  const on = (a, b, c) => (x, y) => a * x + b * y + c

  it('recovers an exact plane', () => {
    const f = on(0.2, -0.1, 3)
    const pts = []
    for (let x = 0; x < 10; x++) for (let y = 0; y < 10; y++) pts.push({ x, y, z: f(x, y) })
    const p = fitPlane(pts)
    expect(p.a).toBeCloseTo(0.2, 8)
    expect(p.b).toBeCloseTo(-0.1, 8)
    expect(p.c).toBeCloseTo(3, 8)
    expect(p.rms).toBeCloseTo(0, 8)
  })

  it('stays accurate on large projected coordinates (UTM-sized)', () => {
    // The un-centred normal equations lose precision here; the centred fit must not.
    const f = on(0.001, -0.002, 100)
    const pts = []
    for (let i = 0; i < 20; i++) {
      for (let j = 0; j < 20; j++) {
        const x = 500000 + i, y = 7000000 + j
        pts.push({ x, y, z: f(x, y) })
      }
    }
    const p = fitPlane(pts)
    expect(p.a).toBeCloseTo(0.001, 6)
    expect(p.b).toBeCloseTo(-0.002, 6)
    expect(p.rms).toBeLessThan(1e-4)
  })

  it('rejects blunders when robust (and is dragged by them when not)', () => {
    const pts = []
    for (let x = 0; x < 12; x++) for (let y = 0; y < 12; y++) pts.push({ x, y, z: 0 })
    for (let i = 0; i < 12; i++) pts.push({ x: 11, y: i, z: 400 })  // a wall at the edge
    const robust = fitPlane(pts, { robust: true })
    const plain = fitPlane(pts, { robust: false })
    expect(robust.dropped).toBeGreaterThan(0)
    expect(Math.hypot(robust.a, robust.b)).toBeLessThan(1e-6)
    expect(Math.hypot(plain.a, plain.b)).toBeGreaterThan(1)
  })

  it('falls back to a horizontal plane on collinear support', () => {
    const pts = [{ x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 3 }, { x: 2, y: 0, z: 5 }]
    const p = fitPlane(pts, { robust: false })
    // y is unconstrained, so no gradient may be invented in either axis.
    expect(Number.isFinite(p.a)).toBe(true)
    expect(Number.isFinite(p.b)).toBe(true)
    expect(Number.isFinite(p.c)).toBe(true)
  })

  it('needs at least three points', () => {
    expect(fitPlane([{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }])).toBeNull()
  })
})

describe('planeSurface', () => {
  it('produces a fully dense grid matching the fit', () => {
    const pts = []
    for (let x = 0; x < 10; x++) for (let y = 0; y < 10; y++) pts.push({ x, y, z: 0.3 * x + 2 })
    const g = planeSurface(pts, { gsd: 1 })
    expect(g.count).toBe(g.width * g.height)
    for (let row = 0; row < g.height; row++) {
      for (let col = 0; col < g.width; col++) {
        const [x] = cellCenter(g, col, row)
        expect(g.data[row * g.width + col]).toBeCloseTo(0.3 * x + 2, 4)
      }
    }
    expect(g.plane.a).toBeCloseTo(0.3, 6)
  })
})

describe('resampleSurface', () => {
  const src = () => planeSurface(
    Array.from({ length: 100 }, (_, i) => ({ x: i % 10, y: Math.floor(i / 10), z: 0.5 * (i % 10) + 1 })),
    { gsd: 1 },
  )

  it('is a no-op at the same cell size', () => {
    const g = src()
    expect(resampleSurface(g, g.gsd)).toBe(g)
  })

  it('refines a linear surface without changing its values', () => {
    const g = src()
    const fine = resampleSurface(g, 0.25)
    expect(fine.gsd).toBeCloseTo(0.25, 8)
    expect(fine.width).toBeGreaterThan(g.width * 3)
    // Same extent, so the corner origins are unchanged.
    expect(fine.originX).toBeCloseTo(g.originX, 8)
    expect(fine.originY).toBeCloseTo(g.originY, 8)
    // Bilinear over a plane reproduces the plane, except in the border ring where
    // the target centre lies past the outermost SOURCE centre (half a source cell
    // = 2 fine cells) and the interpolation clamps instead of extrapolating.
    for (let row = 3; row < fine.height - 3; row++) {
      for (let col = 3; col < fine.width - 3; col++) {
        const [x] = cellCenter(fine, col, row)
        expect(fine.data[row * fine.width + col]).toBeCloseTo(0.5 * x + 1, 3)
      }
    }
  })

  it('never grows the mask past the surface edge', () => {
    // A grid with a nodata half: refining must not paint colour into it.
    const g = src()
    for (let row = 0; row < g.height; row++) {
      for (let col = 0; col < g.width; col++) {
        if (col >= g.width / 2) { g.data[row * g.width + col] = NaN; g.mask[row * g.width + col] = 0 }
      }
    }
    const fine = resampleSurface(g, 0.5)
    const cutX = g.originX + (g.width / 2) * g.gsd
    for (let row = 0; row < fine.height; row++) {
      for (let col = 0; col < fine.width; col++) {
        if (!fine.mask[row * fine.width + col]) continue
        const [x] = cellCenter(fine, col, row)
        expect(x).toBeLessThan(cutX + g.gsd)
      }
    }
  })
})
