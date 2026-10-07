import { describe, expect, it } from 'vitest'
import { slope, aspect, hillshade, terrainProducts } from './terrain.js'

// A w×h DEM sampling z = f(x, y) at cell centres, row 0 = north (max y).
function demOf(f, { w = 7, h = 6, gsd = 2, originX = 5e5, originY = 7e6 } = {}) {
  const data = new Float32Array(w * h)
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    // Relative coordinates keep the plane's Float32 heights well conditioned.
    data[r * w + c] = f((c + 0.5) * gsd, -(r + 0.5) * gsd)
  }
  return { width: w, height: h, gsd, originX, originY, data }
}
const plane = (a, b, opts) => demOf((x, y) => 100 + a * x + b * y, opts)
// Interior cells only: on the border the off-grid neighbours take the centre value
// (GDAL -compute_edges), which deliberately under-reads a plane there.
const interior = (raster) => {
  const out = []
  for (let r = 1; r < raster.height - 1; r++) for (let c = 1; c < raster.width - 1; c++) out.push(raster.data[r * raster.width + c])
  return out
}
// Float32 heights of ~100 carry ~1e-5 rounding, so 3 decimals.
const allClose = (raster, v, digits = 3) => { for (const x of interior(raster)) expect(x).toBeCloseTo(v, digits) }
const MID = 2 * 7 + 3 // an interior cell of the default 7×6 grid

describe('slope', () => {
  it('is constant atan(√(a²+b²)) on a plane', () => {
    const a = 0.3, b = -0.4
    const s = slope(plane(a, b))
    allClose(s, Math.atan(0.5) * 180 / Math.PI)
    expect([...s.mask].every(m => m === 1)).toBe(true)
    expect(s.units).toBe('degrees')
    expect(s.originX).toBe(5e5)
  })

  it('reports percent rise', () => {
    allClose(slope(plane(0.3, -0.4), { units: 'percent' }), 50)
  })

  it('divides the grid spacing by k: k = 2 doubles tan(slope)', () => {
    const g = plane(0.25, 0)
    allClose(slope(g, { k: 2, units: 'percent' }), 50)
    allClose(slope(g, { k: 2 }), Math.atan(0.5) * 180 / Math.PI)
  })

  it('applies zFactor to heights only', () => {
    allClose(slope(plane(0.25, 0), { zFactor: 0.5, units: 'percent' }), 12.5)
  })

  it('propagates nodata from the centre, fills neighbours with the centre value', () => {
    const g = plane(0.5, 0, { w: 6, h: 6 })
    g.mask = new Uint8Array(36).fill(1)
    g.mask[2 * 6 + 2] = 0 // interior cell masked
    g.data[0] = NaN // corner NaN
    const s = slope(g, { units: 'percent' })
    expect(s.mask[14]).toBe(0)
    expect(Number.isNaN(s.data[14])).toBe(true)
    expect(s.mask[0]).toBe(0)
    expect(Number.isNaN(s.data[0])).toBe(true)
    // Cell (1,1) has two missing neighbours (the NaN corner and the masked cell,
    // both replaced by its own z): still valid and finite.
    expect(s.mask[7]).toBe(1)
    expect(Number.isFinite(s.data[7])).toBe(true)
    // A window untouched by nodata reads the plane exactly.
    expect(s.data[4 * 6 + 4]).toBeCloseTo(50, 4)
    // East border: the off-grid column takes the centre value — a one-sided
    // difference over half the Horn baseline, i.e. half the true rise (GDAL
    // -compute_edges behaves the same way).
    expect(s.data[3 * 6 + 5]).toBeCloseTo(25, 4)
  })

  it('does not mutate the input', () => {
    const g = plane(0.1, 0.2)
    const before = g.data.slice()
    slope(g); aspect(g); hillshade(g)
    expect(g.data).toEqual(before)
    expect(g.mask).toBeUndefined()
  })

  it('rejects bad parameters', () => {
    expect(() => slope(plane(0, 0), { k: 0 })).toThrow()
    expect(() => slope({ ...plane(0, 0), gsd: 0 })).toThrow()
    expect(() => terrainProducts(plane(0, 0), { products: ['curvature'] })).toThrow()
  })
})

describe('aspect', () => {
  it('points downhill, clockwise from north, with row 0 = north', () => {
    allClose(aspect(plane(1, 0)), 270) // rising east → faces west
    allClose(aspect(plane(-1, 0)), 90)
    allClose(aspect(plane(0, 1)), 180) // rising north → faces south
    allClose(aspect(plane(0, -1)), 0)
    allClose(aspect(plane(-1, -1)), 45) // rising south-west → faces north-east
    allClose(aspect(plane(1, -1)), 315)
  })

  it('is invariant to k and zFactor', () => {
    allClose(aspect(plane(0.3, 0.3), { k: 3 }), 225)
    allClose(aspect(plane(0.3, 0.3), { zFactor: 0.1 }), 225)
  })

  it('returns flatValue on flat ground', () => {
    const g = plane(0, 0)
    expect([...aspect(g).data].every(v => v === -1)).toBe(true)
    expect([...aspect(g, { flatValue: -9999 }).data].every(v => v === -9999)).toBe(true)
  })
})

describe('hillshade', () => {
  it('is constant on a plane and lights flat ground at sin(altitude)', () => {
    const flat = hillshade(plane(0, 0))
    expect([...flat.data].every(v => v === Math.round(1 + 254 * Math.sin(Math.PI / 4)))).toBe(true)
    const tilted = hillshade(plane(0.2, -0.1))
    expect(new Set(interior(tilted)).size).toBe(1)
  })

  it('is brightest when the slope faces the sun', () => {
    // 45° slopes facing each compass direction; downhill toward bearing θ means
    // the surface rises toward θ+180: z = −tan(45°)·(sin θ·x + cos θ·y).
    const shadeFacing = (deg) => {
      const t = deg * Math.PI / 180
      return hillshade(plane(-Math.sin(t), -Math.cos(t)), { azimuth: 315, altitude: 45 }).data[MID]
    }
    const values = [0, 45, 90, 135, 180, 225, 270, 315].map(d => [d, shadeFacing(d)])
    values.sort((p, q) => q[1] - p[1])
    expect(values[0][0]).toBe(315)
    expect(values[0][1]).toBe(255) // normal parallel to the sun
    expect(shadeFacing(135)).toBe(1) // facing away at 45°: self-shadowed
  })

  it('encodes nodata as 0 with mask 0', () => {
    const g = plane(0.1, 0.1, { w: 3, h: 3 })
    g.data[4] = NaN
    const hs = hillshade(g)
    expect(hs.data[4]).toBe(0)
    expect(hs.mask[4]).toBe(0)
    expect(hs.data[0]).toBeGreaterThan(0)
  })

  it('multidirectional shading stays in range and is flat-consistent', () => {
    const flat = hillshade(plane(0, 0), { multidirectional: true })
    expect(flat.data[0]).toBe(Math.round(1 + 254 * Math.sin(Math.PI / 4)))
    // A 45° slope facing due west: weights cos² to the fall line give the 270° sun
    // 2/4, the 225°/315° suns 1/4 each, the 360° sun none (USGS / GDAL rule).
    const west = hillshade(plane(1, 0), { multidirectional: true }).data[MID]
    const s = (az) => { const A = az * Math.PI / 180, H = Math.PI / 4; return (Math.sin(H) - Math.sin(A) * Math.cos(H)) / Math.SQRT2 }
    expect(west).toBe(Math.round(1 + 254 * (0.5 * s(270) + 0.25 * (s(225) + s(315)))))
    expect(west).toBeLessThan(hillshade(plane(1, 0), { azimuth: 270 }).data[MID])
  })
})

describe('terrainProducts', () => {
  it('returns only the requested rasters, sharing one pass', () => {
    const g = plane(0, 0.5)
    const both = terrainProducts(g, { products: ['slope', 'aspect'], units: 'percent' })
    expect(Object.keys(both).sort()).toEqual(['aspect', 'slope'])
    allClose(both.slope, 50)
    allClose(both.aspect, 180)
    const logs = []
    const all = terrainProducts(g, { onLog: (m, l, s) => logs.push([m, l, s]) })
    expect(Object.keys(all).sort()).toEqual(['aspect', 'hillshade', 'slope'])
    expect(all.hillshade.data).toBeInstanceOf(Uint8Array)
    expect(logs).toHaveLength(1)
    expect(logs[0][2]).toBe('Products')
  })
})
