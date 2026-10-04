import { describe, expect, it } from 'vitest'
import { planimetricArea, polylineLength, sampleProfile, polygonVolume, fitBasePlane, groundVolume } from './measure.js'

describe('raster measurements', () => {
  it('measures a polyline and a concave polygon at large survey coordinates', () => {
    const p = [[0,0],[2,0],[2,1],[1,1],[1,2],[0,2]].map(([x,y]) => ({ x: x + 7e6, y: y + 8e6 }))
    expect(planimetricArea(p)).toBe(3)
    expect(planimetricArea([...p].reverse())).toBe(3)
    expect(planimetricArea([{x:0,y:0},{x:1,y:1},{x:0,y:1},{x:1,y:0}])).toBeNull()
    expect(polylineLength([{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 6, y: 4 }])).toBe(8)
  })
  it('includes vertices and endpoints and preserves DEM holes', () => {
    const grid = { width: 5, height: 1, data: new Float32Array([1,2,3,4,5]), mask: new Uint8Array([1,1,0,1,1]), geoTransform: { originX: 0, originY: 1, scaleX: 1, scaleY: -1 } }
    const result = sampleProfile(grid, [{ x: .5, y: .5 }, { x: 2.5, y: .5 }, { x: 4.5, y: .5 }])
    expect(result.map(p => p.distance)).toEqual([0,1,2,3,4])
    expect(result.map(p => p.z)).toEqual([1,2,null,4,5])
  })
})

describe('polygonVolume', () => {
  // 10×10 grid of 1-unit cells at survey-sized coordinates, z = 0 everywhere, with
  // a 2×2 block of height 3 at cells (4..5, 4..5).
  const ox = 5e5, oy = 7e6
  function grid({ hole = false } = {}) {
    const data = new Float32Array(100)
    for (const [c, r] of [[4, 4], [5, 4], [4, 5], [5, 5]]) data[r * 10 + c] = 3
    const mask = new Uint8Array(100).fill(1)
    if (hole) mask[4 * 10 + 4] = 0
    return { width: 10, height: 10, data, mask, geoTransform: { originX: ox, originY: oy, scaleX: 1, scaleY: -1 } }
  }
  const square = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => ({ x: ox + x, y: oy - y }))

  it('integrates a stockpile above a flat base', () => {
    const v = polygonVolume(grid(), square(1, 1, 9, 9), { base: 'plane' })
    expect(v.cut).toBeCloseTo(12)
    expect(v.fill).toBe(0)
    expect(v.insideCells).toBe(64)
    expect(v.coverage).toBe(1)
    expect(v.base.plane.a).toBeCloseTo(0)
  })

  it('splits cut and fill against a custom base', () => {
    const v = polygonVolume(grid(), square(1, 1, 9, 9), { base: 'custom', height: 1 })
    expect(v.cut).toBeCloseTo(4 * 2)
    expect(v.fill).toBeCloseTo(60 * 1)
    expect(v.net).toBeCloseTo(8 - 60)
  })

  it('applies a reference DEM vertical offset to heights, bases and volumes alike', () => {
    // vOffset +30: the stockpile and the custom base move together, so a custom base
    // given in corrected heights (e.g. a GCP Z filled from this DEM) is consistent.
    const v = polygonVolume({ ...grid(), zOffset: 30 }, square(1, 1, 9, 9), { base: 'custom', height: 31 })
    expect(v.cut).toBeCloseTo(8)
    expect(v.fill).toBeCloseTo(60)
    const low = polygonVolume({ ...grid(), zOffset: 30 }, square(1, 1, 9, 9), { base: 'lowest' })
    expect(low.base.height).toBeCloseTo(30)
    expect(low.cut).toBeCloseTo(12)
    const prof = sampleProfile({ ...grid(), zOffset: 30 }, [{ x: ox + 0.5, y: oy - 0.5 }, { x: ox + 1.5, y: oy - 0.5 }])
    expect(prof.map(p => p.z)).toEqual([30, 30])
  })

  it('a missing custom height is a base error, never a base of zero', () => {
    expect(polygonVolume(grid(), square(1, 1, 9, 9), { base: 'custom', height: null })).toEqual({ error: 'base' })
  })

  it('fits a tilted plane exactly through three vertices', () => {
    const plane = fitBasePlane([{ x: 0, y: 0, z: 1 }, { x: 10, y: 0, z: 3 }, { x: 0, y: 10, z: -1 }])
    expect(plane.a).toBeCloseTo(0.2)
    expect(plane.b).toBeCloseTo(-0.2)
    expect(fitBasePlane([{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }, { x: 2, y: 2, z: 5 }])).toBeNull()
  })

  it('reports holes as missing coverage instead of filling them', () => {
    const v = polygonVolume(grid({ hole: true }), square(1, 1, 9, 9), { base: 'lowest' })
    expect(v.cut).toBeCloseTo(9)
    expect(v.validCells).toBe(63)
    expect(v.coverage).toBeCloseTo(63 / 64)
  })

  it('counts polygon area outside the raster as uncovered', () => {
    const v = polygonVolume(grid(), square(5, 1, 15, 9), { base: 'custom', height: 0 })
    expect(v.insideCells).toBe(80)
    expect(v.validCells).toBe(40)
  })

  it('refuses an undetermined base or a self-intersecting polygon', () => {
    expect(polygonVolume(grid(), square(1, 1, 9, 9), { base: 'custom' }).error).toBe('base')
    const bow = [[1, 1], [9, 9], [9, 1], [1, 9]].map(([x, y]) => ({ x: ox + x, y: oy - y }))
    expect(polygonVolume(grid(), bow).error).toBe('self-intersecting')
  })
})

describe('groundVolume', () => {
  it('divides grid volumes by k² (heights are not scaled by the projection)', () => {
    const v = { cut: 100, fill: 20, net: 80, cellArea: 4, coverage: 1 }
    const g = groundVolume(v, 0.98)
    expect(g.cut).toBeCloseTo(100 / 0.9604, 9)
    expect(g.net).toBeCloseTo(80 / 0.9604, 9)
    expect(g.cellArea).toBeCloseTo(4 / 0.9604, 9)
    expect(g.groundScale).toBe(0.98)
    expect(groundVolume(v, 1)).toBe(v)
    expect(groundVolume({ error: 'base' }, 0.98)).toEqual({ error: 'base' })
  })
})
