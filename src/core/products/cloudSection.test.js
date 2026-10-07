import { describe, it, expect } from 'vitest'
import { sectionCloud, sectionToCsv, sectionToDxf } from './cloudSection.js'

function flatCloud(points, withColor = true) {
  const pos = new Float64Array(points.length * 3)
  const col = withColor ? new Uint8Array(points.length * 3) : null
  points.forEach(([x, y, z], i) => {
    pos[3 * i] = x; pos[3 * i + 1] = y; pos[3 * i + 2] = z
    if (col) col[3 * i] = i % 256
  })
  return { count: points.length, pos, col }
}

// Plane z = 0.5·x on a 1-unit lattice, x ∈ [0, 20], y ∈ [-5, 5], shuffled.
function planeCloud() {
  const pts = []
  for (let x = 0; x <= 20; x++) for (let y = -5; y <= 5; y++) pts.push([x + 1000, y + 2000, 0.5 * x])
  for (let i = pts.length - 1; i > 0; i--) { const j = (i * 7919) % (i + 1); [pts[i], pts[j]] = [pts[j], pts[i]] }
  return flatCloud(pts)
}

describe('sectionCloud', () => {
  it('slices along x: station = x − ax, z on the plane, sorted by station', () => {
    const cloud = planeCloud()
    const logs = []
    const s = sectionCloud(cloud, { a: [1002, 2000], b: [1015, 2000], thickness: 0.5 }, (m) => logs.push(m))
    expect(s.length).toBeCloseTo(13)
    expect(s.cloud.count).toBe(14) // x = 1002 … 1015, y = 2000 only
    for (let k = 0; k < s.cloud.count; k++) {
      const x = s.cloud.pos[3 * k]
      expect(s.profile.station[k]).toBeCloseTo(x - 1002, 9)
      expect(s.profile.z[k]).toBeCloseTo(0.5 * (x - 1000), 9)
      expect(s.profile.offset[k]).toBeCloseTo(0, 9)
      if (k) expect(s.profile.station[k]).toBeGreaterThanOrEqual(s.profile.station[k - 1])
    }
    expect(s.cloud.pos).toBeInstanceOf(Float64Array)
    expect(s.cloud.col).toBeInstanceOf(Uint8Array)
    expect(logs[0]).toMatch(/Section: 14 of 231 points/)
  })

  it('keeps colours aligned with the reordered points', () => {
    const cloud = planeCloud()
    const s = sectionCloud(cloud, { a: [1000, 2000], b: [1020, 2000], thickness: 0.5 })
    for (let k = 0; k < s.cloud.count; k++) {
      const x = s.cloud.pos[3 * k], y = s.cloud.pos[3 * k + 1]
      let src = -1
      for (let i = 0; i < cloud.count; i++) if (cloud.pos[3 * i] === x && cloud.pos[3 * i + 1] === y) src = i
      expect(s.cloud.col[3 * k]).toBe(cloud.col[3 * src])
    }
  })

  it('thickness widens the slab symmetrically', () => {
    const cloud = planeCloud()
    const s = sectionCloud(cloud, { a: [1000, 2000], b: [1020, 2000], thickness: 4.2 })
    expect(s.cloud.count).toBe(21 * 5) // y offsets −2 … 2
    for (let k = 0; k < s.cloud.count; k++) expect(Math.abs(s.profile.offset[k])).toBeLessThanOrEqual(2.1)
  })

  it('offset is positive to the left of a→b', () => {
    const cloud = flatCloud([[0, 1, 0], [0, -1, 0], [5, 1, 0]])
    const east = sectionCloud(cloud, { a: [-1, 0], b: [10, 0], thickness: 4 })
    // Heading east, +y is left.
    expect(Array.from(east.profile.offset)).toEqual([1, -1, 1])
    const west = sectionCloud(cloud, { a: [10, 0], b: [-1, 0], thickness: 4 })
    expect(Array.from(west.profile.offset)).toEqual([-1, -1, 1]) // sorted: x=5 first, then the x=0 pair in input order
    expect(Array.from(west.profile.station)).toEqual([5, 10, 10])
  })

  it('extend drops the station bound (infinite line)', () => {
    const cloud = planeCloud()
    const seg = sectionCloud(cloud, { a: [1005, 2000], b: [1010, 2000], thickness: 0.5 })
    const ext = sectionCloud(cloud, { a: [1005, 2000], b: [1010, 2000], thickness: 0.5, extend: true })
    expect(seg.cloud.count).toBe(6)
    expect(ext.cloud.count).toBe(21)
    expect(ext.profile.station[0]).toBeCloseTo(-5)
    expect(ext.profile.station[20]).toBeCloseTo(15)
  })

  it('works on a diagonal line', () => {
    const cloud = flatCloud([[3, 3, 7], [3.1, 2.9, 1], [1, 5, 2]])
    const s = sectionCloud(cloud, { a: [0, 0], b: [10, 10], thickness: 1 })
    expect(s.cloud.count).toBe(2)
    expect(s.profile.station[0]).toBeCloseTo(3 * Math.SQRT2, 9)
    expect(Math.abs(s.profile.offset[1])).toBeCloseTo(0.1 * Math.SQRT2, 9)
  })

  it('handles empty results, uncoloured and Float32 clouds, and bad input', () => {
    const cloud = planeCloud()
    const logs = []
    const none = sectionCloud(cloud, { a: [0, 0], b: [1, 0], thickness: 1 }, (m, level) => logs.push(level))
    expect(none.cloud.count).toBe(0)
    expect(none.profile.station).toHaveLength(0)
    expect(logs).toEqual(['warn'])

    const f32 = { count: 2, pos: new Float32Array([0, 0, 1, 1, 0, 2]), col: null }
    const s = sectionCloud(f32, { a: [0, 0], b: [2, 0], thickness: 1 })
    expect(s.cloud.col).toBeNull()
    expect(s.cloud.pos).toBeInstanceOf(Float64Array)
    expect(Array.from(s.profile.z)).toEqual([1, 2])

    expect(() => sectionCloud(cloud, { a: [0, 0], b: [0, 0], thickness: 1 })).toThrow(/zero/)
    expect(() => sectionCloud(cloud, { a: [0, 0], b: [1, 0], thickness: 0 })).toThrow(/thickness/)
  })

  it('does not mutate the input cloud', () => {
    const cloud = planeCloud()
    const pos = Float64Array.from(cloud.pos), col = Uint8Array.from(cloud.col)
    sectionCloud(cloud, { a: [1000, 2000], b: [1020, 2000], thickness: 3 })
    expect(cloud.pos).toEqual(pos)
    expect(cloud.col).toEqual(col)
  })
})

describe('sectionToCsv', () => {
  it('writes a header and one row per point in station order', () => {
    const s = sectionCloud(planeCloud(), { a: [1000, 2000], b: [1003, 2000], thickness: 0.5 })
    const csv = sectionToCsv(s)
    const rows = csv.trimEnd().split('\n')
    expect(rows[0]).toBe('station,z,offset,x,y')
    expect(rows).toHaveLength(5)
    expect(rows[2]).toBe('1.000,0.500,0.000,1001.000,2000.000')
    expect(sectionToCsv(s, { decimals: 1 }).split('\n')[1]).toBe('0.0,0.0,0.0,1000.0,2000.0')
    expect(sectionToCsv(sectionCloud(planeCloud(), { a: [0, 0], b: [1, 0], thickness: 1 }))).toBe('station,z,offset,x,y\n')
  })
})

describe('sectionToDxf', () => {
  const s = sectionCloud(planeCloud(), { a: [1000, 2000], b: [1020, 2000], thickness: 0.5 })
  const entities = (text, name) => {
    const lines = text.split('\n')
    return lines.filter((l, i) => l === name && lines[i - 1].trim() === '0').length
  }
  it('writes POINT entities in (station, z) on layer SECTION', () => {
    const text = sectionToDxf(s)
    expect(entities(text, 'POINT')).toBe(21)
    expect(entities(text, 'POLYLINE')).toBe(0)
    expect(text).toContain('\nSECTION\n')
    expect(text).toContain('\n20.0\n') // last station
    expect(text).toContain('\n10.0\n') // its z
    expect(text).not.toContain('\n1020.0\n') // not world x
  })
  it('writes one polyline when asked', () => {
    const text = sectionToDxf(s, { asPolyline: true })
    expect(entities(text, 'POLYLINE')).toBe(1)
    expect(entities(text, 'VERTEX')).toBe(21)
    expect(entities(text, 'POINT')).toBe(0)
  })
})
