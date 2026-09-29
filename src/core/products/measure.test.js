import { describe, expect, it } from 'vitest'
import { planimetricArea, polylineLength, sampleProfile } from './measure.js'

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
