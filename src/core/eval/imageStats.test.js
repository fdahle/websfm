import { describe, it, expect } from 'vitest'
import { perImageResiduals, unregisteredReason, imageResidualVectors } from './imageStats.js'

const K = { fx: 1000, fy: 1000, cx: 500, cy: 400 }
const cam = { R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 0], K }

describe('perImageResiduals', () => {
  it('computes rms/median/max per camera', () => {
    const cameras = new Map([['a', cam], ['b', cam]])
    // Point at (0,0,10) projects to (500,400) in an identity camera.
    const pts = [
      { x: 0, y: 0, z: 10, viewsPx: new Map([['a', [503, 404]], ['b', [500, 400]]]) }, // a:5px b:0
      { x: 0, y: 0, z: 10, viewsPx: new Map([['a', [500, 400]]]) },                     // a:0px
    ]
    const rows = perImageResiduals(cameras, pts)
    const a = rows.find((r) => r.uuid === 'a')
    const b = rows.find((r) => r.uuid === 'b')
    expect(a.nObs).toBe(2)
    expect(a.maxPx).toBeCloseTo(5, 6)
    expect(a.rmsPx).toBeCloseTo(Math.sqrt((25 + 0) / 2), 6)
    expect(b.nObs).toBe(1)
    expect(b.medianPx).toBeCloseTo(0, 6)
  })

  it('includes registered cameras with zero observations as null-stat rows', () => {
    const cameras = new Map([['a', cam], ['lonely', cam]])
    const pts = [{ x: 0, y: 0, z: 10, viewsPx: new Map([['a', [500, 400]]]) }]
    const rows = perImageResiduals(cameras, pts)
    const lonely = rows.find((r) => r.uuid === 'lonely')
    expect(lonely).toEqual({ uuid: 'lonely', nObs: 0, rmsPx: null, medianPx: null, maxPx: null })
    expect(rows).toHaveLength(2)
  })
})

describe('unregisteredReason', () => {
  it('orders reasons most-fundamental first', () => {
    expect(unregisteredReason({ kpCount: 0, degree: 0, componentIndex: 2 })).toBe('no features')
    expect(unregisteredReason({ kpCount: 500, degree: 0, componentIndex: 2 })).toBe('no accepted pairs')
    expect(unregisteredReason({ kpCount: 500, degree: 4, componentIndex: 2 })).toBe('disconnected (component 3)')
    expect(unregisteredReason({ kpCount: 500, degree: 4, componentIndex: 0 })).toBeNull()
  })
  it('tolerates missing facts', () => {
    expect(unregisteredReason({})).toBeNull()
    expect(unregisteredReason()).toBeNull()
  })
})

describe('imageResidualVectors', () => {
  it('returns obs pixel + (obs − projection) vector', () => {
    const K = { fx: 1000, fy: 1000, cx: 500, cy: 400 }
    const cam = { R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 0], K }
    // Point at (0,0,10) projects to (500,400); observed at (503,404) → vector (3,4).
    const pts = [{ x: 0, y: 0, z: 10, viewsPx: new Map([['a', [503, 404]]]) }]
    const v = imageResidualVectors(cam, pts, 'a')
    expect(v).toHaveLength(1)
    expect(v[0].px).toBe(503)
    expect(v[0].du).toBeCloseTo(3, 6)
    expect(v[0].dv).toBeCloseTo(4, 6)
    expect(v[0].mag).toBeCloseTo(5, 6)
  })
  it('maps both endpoints through toScan and keeps mag in the pinhole frame', () => {
    const K = { fx: 1000, fy: 1000, cx: 500, cy: 400 }
    const cam = { R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 0], K }
    const pts = [{ x: 0, y: 0, z: 10, viewsPx: new Map([['a', [503, 404]]]) }]
    // A scale+offset stand-in for the scan→canonical affine: it stretches the vector,
    // which is exactly why the tail can't be mapped alone.
    const toScan = (x, y) => ({ x: 2 * x + 10, y: 3 * y - 5 })

    const v = imageResidualVectors(cam, pts, 'a', toScan)
    expect(v[0].px).toBeCloseTo(2 * 503 + 10, 6) // drawn at the mapped observation
    expect(v[0].py).toBeCloseTo(3 * 404 - 5, 6)
    expect(v[0].du).toBeCloseTo(6, 6)            // 3 px × 2
    expect(v[0].dv).toBeCloseTo(12, 6)           // 4 px × 3
    expect(v[0].mag).toBeCloseTo(5, 6)           // unchanged — still the reported error
  })

  it('skips points not seen in the image; empty when no cam', () => {
    const cam = { R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 0], K: { fx: 1, fy: 1, cx: 0, cy: 0 } }
    expect(imageResidualVectors(cam, [{ x: 0, y: 0, z: 1, viewsPx: new Map([['b', [0, 0]]]) }], 'a')).toEqual([])
    expect(imageResidualVectors(null, [], 'a')).toEqual([])
  })
})
