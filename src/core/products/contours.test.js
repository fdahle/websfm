import { describe, it, expect } from 'vitest'
import { contourLevels, traceContours, contoursToGeoJSON, contoursToDxf, MAX_CONTOUR_LEVELS } from './contours.js'
import { cellCenter } from './dem.js'

// Build a DEM grid from z = f(x, y) evaluated at cell centres.
function makeGrid(width, height, f, { gsd = 1, originX = 0, originY = height * gsd, nodata } = {}) {
  const grid = { width, height, gsd, originX, originY, data: new Float32Array(width * height) }
  for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) {
    const [x, y] = cellCenter(grid, c, r)
    grid.data[r * width + c] = nodata?.(c, r) ? NaN : f(x, y)
  }
  return grid
}
const vertices = (line) => {
  const out = []
  for (let k = 0; k < line.points.length; k += 2) out.push([line.points[k], line.points[k + 1]])
  return out
}
const segmentsOf = (line) => {
  const v = vertices(line)
  const segs = []
  for (let i = 1; i < v.length; i++) segs.push([v[i - 1], v[i]])
  if (line.closed) segs.push([v[v.length - 1], v[0]])
  return segs
}
// Proper crossing (interiors intersect, not merely touching at endpoints).
function crosses([p1, p2], [p3, p4]) {
  const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4)
  const eps = 1e-12
  return ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))
}

describe('contourLevels', () => {
  it('lists base + k·interval inside [min, max]', () => {
    expect(contourLevels({ min: 3, max: 21 }, { interval: 5 })).toEqual([5, 10, 15, 20])
    expect(contourLevels({ min: 3, max: 21 }, { interval: 5, base: 2 })).toEqual([7, 12, 17])
    expect(contourLevels({ min: -7, max: -1 }, { interval: 2.5 })).toEqual([-5, -2.5])
    expect(contourLevels({ min: 5, max: 10 }, { interval: 5 })).toEqual([5, 10])
  })
  it('caps absurd level counts with a clear error', () => {
    expect(() => contourLevels({ min: 0, max: 1e6 }, { interval: 1 })).toThrow(/limit 10000/)
    expect(contourLevels({ min: 0, max: MAX_CONTOUR_LEVELS - 1 }, { interval: 1 })).toHaveLength(MAX_CONTOUR_LEVELS)
  })
  it('rejects a non-positive interval', () => {
    expect(() => contourLevels({ min: 0, max: 1 }, { interval: 0 })).toThrow(/positive/)
    expect(() => contourLevels({ min: 0, max: 1 }, { interval: -1 })).toThrow(/positive/)
  })
})

describe('traceContours', () => {
  it('a cone z = r gives concentric closed rings at radius = level', () => {
    const cx = 20.5, cy = 20.5
    const grid = makeGrid(41, 41, (x, y) => Math.hypot(x - cx, y - cy))
    const logs = []
    const res = traceContours(grid, { interval: 5, indexEvery: 2 }, (m) => logs.push(m))
    for (const level of [5, 10, 15]) {
      const lines = res.lines.filter((l) => l.level === level)
      expect(lines).toHaveLength(1)
      expect(lines[0].closed).toBe(true)
      for (const [x, y] of vertices(lines[0])) expect(Math.abs(Math.hypot(x - cx, y - cy) - level)).toBeLessThan(0.15)
    }
    // Index flags: every 2nd level from base 0.
    expect(res.lines.find((l) => l.level === 10).index).toBe(true)
    expect(res.lines.find((l) => l.level === 5).index).toBe(false)
    // Level 25 runs off the grid edge: open arcs.
    const outer = res.lines.filter((l) => l.level === 25)
    expect(outer.length).toBeGreaterThan(0)
    expect(outer.every((l) => !l.closed)).toBe(true)
    expect(logs.some((m) => /Contours: .*closed/.test(m))).toBe(true)
  })

  it('a plane tilted in x gives straight open lines at x = level', () => {
    const grid = makeGrid(20, 10, (x) => x, { originX: 100, originY: 50 })
    const res = traceContours(grid, { interval: 2 })
    expect(res.levels).toEqual([102, 104, 106, 108, 110, 112, 114, 116, 118])
    expect(res.lines).toHaveLength(9)
    for (const line of res.lines) {
      expect(line.closed).toBe(false)
      const v = vertices(line)
      expect(v).toHaveLength(10)
      for (const [x] of v) expect(x).toBeCloseTo(line.level, 4)
      const ys = v.map(([, y]) => y).sort((a, b) => a - b)
      expect(ys[0]).toBeCloseTo(40.5, 6)
      expect(ys[ys.length - 1]).toBeCloseTo(49.5, 6)
    }
  })

  it('levels equal to sample values give one line, not doubled ones', () => {
    // z = column index exactly ⇒ every level coincides with a whole column.
    const grid = makeGrid(8, 5, (x) => x - 0.5)
    const res = traceContours(grid, { interval: 1 })
    for (const level of [1, 2, 3, 4, 5, 6, 7]) {
      const lines = res.lines.filter((l) => l.level === level)
      expect(lines).toHaveLength(1)
      const v = vertices(lines[0])
      expect(v).toHaveLength(5)
      for (const [x] of v) expect(x).toBeCloseTo(level + 0.5, 9)
    }
  })

  it('a level exactly at an isolated peak sample collapses to nothing', () => {
    const grid = makeGrid(3, 3, () => 0)
    grid.data[4] = 10
    const res = traceContours(grid, { interval: 10 })
    expect(res.lines).toHaveLength(0)
  })

  it('nodata holes break lines: they end at the hole and none passes through it', () => {
    const inHole = (c, r) => c >= 8 && c <= 11 && r >= 3 && r <= 6
    for (const variant of ['nan', 'mask']) {
      const grid = makeGrid(20, 10, (x) => x, variant === 'nan' ? { nodata: inHole } : {})
      if (variant === 'mask') {
        grid.mask = new Uint8Array(200).fill(1)
        for (let r = 0; r < 10; r++) for (let c = 0; c < 20; c++) if (inHole(c, r)) grid.mask[r * 20 + c] = 0
      }
      const res = traceContours(grid, { interval: 2 })
      const at10 = res.lines.filter((l) => l.level === 10)
      expect(at10).toHaveLength(2)
      for (const line of at10) {
        expect(line.closed).toBe(false)
        for (const [, y] of vertices(line)) expect(y <= 2.5 + 1e-9 || y >= 7.5 - 1e-9).toBe(true)
      }
      // A level clear of the hole is untouched.
      expect(res.lines.filter((l) => l.level === 4)).toHaveLength(1)
    }
  })

  it('resolves a 2×2 saddle into two non-crossing segments', () => {
    expect(crosses([[0, 0], [1, 1]], [[0, 1], [1, 0]])).toBe(true) // the checker itself works
    const grid = { width: 2, height: 2, gsd: 1, originX: 0, originY: 2, data: new Float32Array([1, 0, 0, 1]) }
    for (const level of [0.4, 0.5, 0.6]) {
      const res = traceContours(grid, { interval: 1, base: level })
      const lines = res.lines.filter((l) => l.level === level)
      expect(lines).toHaveLength(2)
      expect(crosses(segmentsOf(lines[0])[0], segmentsOf(lines[1])[0])).toBe(false)
    }
  })

  it('same-level lines never cross on a surface full of saddles', () => {
    const grid = makeGrid(40, 40, (x, y) => Math.sin(x / 3) * Math.cos(y / 2.5) + 0.01 * x)
    const res = traceContours(grid, { interval: 0.2, base: 0.05 })
    expect(res.lines.some((l) => l.closed)).toBe(true)
    for (const level of res.levels) {
      const segs = res.lines.filter((l) => l.level === level).flatMap(segmentsOf)
      let crossings = 0
      for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) if (crosses(segs[i], segs[j])) crossings++
      expect(crossings).toBe(0)
    }
  })

  it('drops lines shorter than minLength and smooths with endpoints kept', () => {
    const cx = 20.5, cy = 20.5
    const grid = makeGrid(41, 41, (x, y) => Math.hypot(x - cx, y - cy))
    const res = traceContours(grid, { interval: 5, minLength: 2 * Math.PI * 7 })
    expect(res.lines.some((l) => l.level === 5)).toBe(false)
    expect(res.lines.some((l) => l.level === 10)).toBe(true)

    const plane = makeGrid(20, 10, (x, y) => x + 0.3 * Math.sin(y))
    const raw = traceContours(plane, { interval: 4 })
    const sm = traceContours(plane, { interval: 4, smooth: 3 })
    expect(sm.lines).toHaveLength(raw.lines.length)
    for (let i = 0; i < raw.lines.length; i++) {
      const a = raw.lines[i].points, b = sm.lines[i].points
      expect(b.length).toBe(a.length)
      expect([b[0], b[1]]).toEqual([a[0], a[1]])
      expect([b[b.length - 2], b[b.length - 1]]).toEqual([a[a.length - 2], a[a.length - 1]])
    }
  })

  it('handles an all-nodata grid and does not mutate the input', () => {
    const empty = makeGrid(4, 4, () => NaN)
    expect(traceContours(empty, { interval: 1 })).toEqual({ levels: [], lines: [] })
    const grid = makeGrid(10, 10, (x, y) => x + y)
    const before = Float32Array.from(grid.data)
    traceContours(grid, { interval: 1, smooth: 2 })
    expect(grid.data).toEqual(before)
    expect(() => traceContours(grid, { interval: 1e-5 })).toThrow(/limit/)
  })
})

describe('exports', () => {
  const cx = 10.5, cy = 10.5
  const grid = makeGrid(21, 21, (x, y) => Math.hypot(x - cx, y - cy))
  const res = traceContours(grid, { interval: 2, indexEvery: 5 })

  it('GeoJSON: 2D LineStrings, closed rings repeat their first vertex', () => {
    const fc = contoursToGeoJSON(res)
    expect(fc.type).toBe('FeatureCollection')
    expect(fc.crs).toBeUndefined()
    expect(fc.features).toHaveLength(res.lines.length)
    const ring = fc.features.find((f) => f.properties.elevation === 4)
    expect(ring.geometry.type).toBe('LineString')
    const co = ring.geometry.coordinates
    expect(co[0]).toEqual(co[co.length - 1])
    expect(co[0]).toHaveLength(2)
    expect(ring.properties.index).toBe(false)
    expect(fc.features.find((f) => f.properties.elevation === 10).properties.index).toBe(true)

    const named = contoursToGeoJSON(res, { crs: 'EPSG:3031', elevationProperty: 'z' })
    expect(named.crs).toEqual({ type: 'name', properties: { name: 'EPSG:3031' } })
    expect(named.features[0].properties).toHaveProperty('z')
  })

  it('DXF: one polyline per line on CONTOUR / CONTOUR_INDEX at its elevation', () => {
    const text = contoursToDxf(res)
    const lines = text.split('\n')
    const polylines = lines.filter((l, i) => l === 'POLYLINE' && lines[i - 1].trim() === '0').length
    expect(polylines).toBe(res.lines.length)
    expect(text).toContain('\nCONTOUR_INDEX\n')
    expect(text).toContain('\n10.0\n')
    expect(lines[lines.length - 2]).toBe('EOF')
  })
})
