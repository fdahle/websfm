import { describe, expect, it } from 'vitest'
import { polygonMask, clipBounds, clipDem, clipOrtho, polygonsFromGeoJSON, normalizePolygons } from './rasterClip.js'

// 10×8 grid of 2-unit cells at survey-sized coordinates.
const ox = 5e5, oy = 7e6, gsd = 2
const geo = { width: 10, height: 8, gsd, originX: ox, originY: oy }
// Pixel-space corner (col, row) → world [x, y].
const W = (c, r) => [ox + c * gsd, oy - r * gsd]
const rect = (c0, r0, c1, r1) => [W(c0, r0), W(c1, r0), W(c1, r1), W(c0, r1), W(c0, r0)]
const count = (m) => { let n = 0; for (const v of m) n += v; return n }

describe('polygonMask', () => {
  it('fills a pixel-aligned square exactly, allTouched adds nothing on aligned edges', () => {
    const m = polygonMask(geo, [rect(2, 1, 6, 5)])
    expect(count(m)).toBe(16)
    expect(clipBounds(geo, m)).toEqual({ col0: 2, row0: 1, col1: 5, row1: 4, width: 4, height: 4 })
    expect(count(polygonMask(geo, [rect(2, 1, 6, 5)], { allTouched: true }))).toBe(16)
  })

  it('tests centres; allTouched takes every crossed pixel', () => {
    const shifted = [rect(2.25, 1.25, 6.25, 5.25)]
    expect(count(polygonMask(geo, shifted))).toBe(16)
    const all = polygonMask(geo, shifted, { allTouched: true })
    expect(count(all)).toBe(25)
    expect(clipBounds(geo, all)).toMatchObject({ col0: 2, row0: 1, col1: 6, row1: 5 })
    // A polygon inside one pixel: no centre, one touched pixel.
    const speck = [rect(3.1, 2.1, 3.4, 2.4)]
    expect(count(polygonMask(geo, speck))).toBe(0)
    const t = polygonMask(geo, speck, { allTouched: true })
    expect(count(t)).toBe(1)
    expect(t[2 * 10 + 3]).toBe(1)
  })

  it('fills a triangle; centres on the right edge stay outside', () => {
    const m = polygonMask(geo, [[W(0, 0), W(8, 0), W(0, 8)]])
    // centre (c+½, r+½) inside ⇔ c + r ≤ 6 → 7+6+…+1
    expect(count(m)).toBe(28)
    for (let r = 0; r < 8; r++) for (let c = 0; c < 10; c++) expect(m[r * 10 + c]).toBe(c + r <= 6 ? 1 : 0)
  })

  it('subtracts holes whatever their winding', () => {
    const outer = rect(1, 1, 9, 7)
    const holeCw = rect(3, 3, 5, 5)
    const holeCcw = [...holeCw].reverse()
    expect(count(polygonMask(geo, [[outer, holeCw]]))).toBe(48 - 4)
    const m = polygonMask(geo, [[outer, holeCcw]])
    expect(count(m)).toBe(44)
    expect(m[3 * 10 + 3]).toBe(0)
    expect(m[2 * 10 + 2]).toBe(1)
  })

  it('unions separate polygons instead of cancelling their overlap', () => {
    const multi = { type: 'MultiPolygon', coordinates: [[rect(0, 0, 4, 4)], [rect(2, 2, 6, 6)]] }
    expect(count(polygonMask(geo, multi))).toBe(16 + 16 - 4)
    // Two polygons sharing an edge claim each pixel once.
    expect(count(polygonMask(geo, [[rect(0, 0, 3, 3)], [rect(3, 0, 6, 3)]]))).toBe(18)
  })

  it('accepts a bare ring, {x,y} vertices, a polygon and a GeoJSON geometry alike', () => {
    const ring = rect(1, 2, 4, 6)
    const ref = polygonMask(geo, [[ring]])
    expect(count(ref)).toBe(12)
    expect(polygonMask(geo, ring)).toEqual(ref)
    expect(polygonMask(geo, ring.map(([x, y]) => ({ x, y })))).toEqual(ref)
    expect(polygonMask(geo, [ring])).toEqual(ref)
    expect(polygonMask(geo, { type: 'Polygon', coordinates: [ring] })).toEqual(ref)
    expect(polygonMask(geo, [ring, rect(6, 0, 8, 1)])).toEqual(polygonMask(geo, [[ring], [rect(6, 0, 8, 1)]]))
  })

  it('handles polygons partly or fully off the grid', () => {
    expect(count(polygonMask(geo, [rect(-5, -5, 2, 2)]))).toBe(4)
    expect(count(polygonMask(geo, [rect(-5, -5, 2, 2)], { allTouched: true }))).toBe(4)
    const none = polygonMask(geo, [rect(20, 20, 30, 30)])
    expect(count(none)).toBe(0)
    expect(clipBounds(geo, none)).toBeNull()
    expect(count(polygonMask(geo, []))).toBe(0)
  })

  it('approximates a many-vertex circle area and leaves the input untouched', () => {
    const big = { width: 400, height: 400, gsd: 1, originX: 0, originY: 400 }
    const ring = []
    for (let i = 0; i < 2000; i++) { const t = 2 * Math.PI * i / 2000; ring.push([200 + 150 * Math.cos(t), 200 + 150 * Math.sin(t)]) }
    const copy = ring.map(p => [...p])
    const n = count(polygonMask(big, ring))
    expect(Math.abs(n - Math.PI * 150 * 150) / (Math.PI * 150 * 150)).toBeLessThan(0.005)
    expect(ring).toEqual(copy)
  })
})

describe('clipDem', () => {
  const dem = () => {
    const data = new Float32Array(80)
    for (let i = 0; i < 80; i++) data[i] = i
    const mask = new Uint8Array(80).fill(1)
    mask[2 * 10 + 3] = 0 // a hole inside the clip polygon
    return { ...geo, data, mask, zMin: 0, zMax: 79, count: 79, crs: 'EPSG:3031', previewDataUrl: 'stale' }
  }

  it('crops with exact origin arithmetic and keeps holes as holes', () => {
    const src = dem()
    const out = clipDem(src, [rect(2, 1, 6, 5)])
    expect(out.width).toBe(4)
    expect(out.height).toBe(4)
    expect(out.originX).toBe(ox + 2 * gsd)
    expect(out.originY).toBe(oy - 1 * gsd)
    expect(out.gsd).toBe(gsd)
    expect(out.data[0]).toBe(1 * 10 + 2)
    expect(out.data[15]).toBe(4 * 10 + 5)
    // (col 3, row 2) → (1, 1) in the crop: masked in the source, still nodata.
    expect(out.mask[1 * 4 + 1]).toBe(0)
    expect(Number.isNaN(out.data[1 * 4 + 1])).toBe(true)
    expect(out.clip).toEqual({ col0: 2, row0: 1, col1: 5, row1: 4, insideCells: 16, validCells: 15 })
    expect(out.zMin).toBe(12)
    expect(out.zMax).toBe(45)
    expect(out.crs).toBe('EPSG:3031')
    expect(out.previewDataUrl).toBeUndefined()
    expect(out.count).toBeUndefined()
    // Source untouched.
    expect(src.data[0]).toBe(0)
    expect(src.mask[23]).toBe(0)
    expect(src.mask[0]).toBe(1)
  })

  it('keeps the full extent without crop, NaN outside', () => {
    const out = clipDem(dem(), [rect(2, 1, 6, 5)], { crop: false })
    expect(out.width).toBe(10)
    expect(out.originX).toBe(ox)
    expect(out.originY).toBe(oy)
    expect(Number.isNaN(out.data[0])).toBe(true)
    expect(out.mask[0]).toBe(0)
    expect(out.data[1 * 10 + 2]).toBe(12)
    expect(count(out.mask)).toBe(15)
  })

  it('treats a crop of a triangle by its bbox', () => {
    const out = clipDem(dem(), [[W(1, 1), W(5, 1), W(1, 5)]])
    expect(out).toMatchObject({ width: 3, height: 3, originX: ox + gsd, originY: oy - gsd })
  })

  it('returns null (crop) or an all-nodata grid when nothing is inside', () => {
    const logs = []
    expect(clipDem(dem(), [rect(20, 20, 30, 30)], { onLog: (m, l) => logs.push(l) })).toBeNull()
    expect(logs).toEqual(['warn'])
    const full = clipDem(dem(), [rect(20, 20, 30, 30)], { crop: false })
    expect(count(full.mask)).toBe(0)
    expect(full.clip).toEqual({ insideCells: 0, validCells: 0 })
  })
})

describe('clipOrtho', () => {
  const ortho = () => {
    const data = new Uint8ClampedArray(80 * 4)
    for (let i = 0; i < 80; i++) data.set([i, 100, 200, 255], i * 4)
    return { ...geo, data }
  }

  it('zeroes alpha outside and copies inside, preserving the array type', () => {
    const out = clipOrtho(ortho(), { type: 'Polygon', coordinates: [rect(2, 1, 6, 5)] }, { crop: false })
    expect(out.data).toBeInstanceOf(Uint8ClampedArray)
    expect(Array.from(out.data.subarray(0, 4))).toEqual([0, 0, 0, 0])
    const i = (1 * 10 + 2) * 4
    expect(Array.from(out.data.subarray(i, i + 4))).toEqual([12, 100, 200, 255])
    let opaque = 0
    for (let p = 0; p < 80; p++) if (out.data[p * 4 + 3]) opaque++
    expect(opaque).toBe(16)
    expect(out.mask).toBeUndefined()
  })

  it('crops with the same origin arithmetic and crops an existing mask', () => {
    const src = { ...ortho(), mask: new Uint8Array(80).fill(1) }
    src.mask[1 * 10 + 2] = 0
    const out = clipOrtho(src, [rect(2, 1, 6, 5)])
    expect(out).toMatchObject({ width: 4, height: 4, originX: ox + 4, originY: oy - 2 })
    expect(out.data[0]).toBe(12)
    expect(out.mask[0]).toBe(0)
    expect(out.mask[1]).toBe(1)
    expect(out.clip.insideCells).toBe(16)
    expect(clipOrtho(src, [rect(20, 20, 30, 30)])).toBeNull()
  })
})

describe('polygonsFromGeoJSON', () => {
  it('collects Polygon/MultiPolygon, counts what it ignores, drops closing vertices', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]], [[1, 1], [2, 1], [2, 2], [1, 1]]] } },
        { type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: [[[[10, 10], [11, 10], [11, 11], [10, 10]]], [[[20, 20], [21, 20], [21, 21]]]] } },
        { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [1, 2] } },
        { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } },
        { type: 'Feature', properties: {}, geometry: null },
        { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 1], [0, 0]]] } }, // degenerate
      ],
    }
    const { polygons, ignored } = polygonsFromGeoJSON(fc)
    expect(polygons).toHaveLength(3)
    expect(ignored).toBe(4)
    expect(polygons[0][0]).toEqual([[0, 0], [4, 0], [4, 4], [0, 4]])
    expect(polygons[0][1]).toEqual([[1, 1], [2, 1], [2, 2]])
    expect(polygons[2][0]).toEqual([[20, 20], [21, 20], [21, 21]])
  })

  it('accepts a bare geometry, a Feature and a GeometryCollection', () => {
    const poly = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }
    expect(polygonsFromGeoJSON(poly).polygons).toHaveLength(1)
    expect(polygonsFromGeoJSON({ type: 'Feature', geometry: poly }).polygons).toHaveLength(1)
    const gc = polygonsFromGeoJSON({ type: 'GeometryCollection', geometries: [poly, { type: 'Point', coordinates: [0, 0] }] })
    expect(gc).toEqual({ polygons: [[[[0, 0], [1, 0], [1, 1]]]], ignored: 1 })
    expect(normalizePolygons({ type: 'Feature', geometry: poly })).toEqual(gc.polygons)
  })
})
