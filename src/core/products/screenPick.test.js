import { describe, it, expect } from 'vitest'
import { pickNearestPoint, planeFromThreePoints } from './screenPick.js'

// Orthographic-like column-major matrix: clip = (x, y, -z·0.1, 1) — x,y map to NDC
// directly, depth grows with z.
const M = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 1]

describe('pickNearestPoint', () => {
  const pos = Float32Array.from([
    0, 0, 5, // far, under the cursor
    0.01, 0, 1, // near, under the cursor → wins
    0.5, 0.5, 0, // outside the radius
    0, 0, 50, // outside the clip volume (|z| > w)
  ])

  it('returns the point nearest the camera within the radius', () => {
    expect(pickNearestPoint(pos, 4, { matrix: M, x: 0, y: 0, tolX: 0.05, tolY: 0.05 })?.index).toBe(1)
  })

  it('returns null when nothing is within the radius', () => {
    expect(pickNearestPoint(pos, 4, { matrix: M, x: -0.9, y: 0.9, tolX: 0.05, tolY: 0.05 })).toBeNull()
  })

  it('only considers drawn indices', () => {
    expect(pickNearestPoint(pos, 4, { matrix: M, x: 0, y: 0, tolX: 0.05, tolY: 0.05, indices: Uint32Array.from([0, 2]) })?.index).toBe(0)
  })
})

describe('planeFromThreePoints', () => {
  it('fits a plane with a normal on the requested side, and rejects collinear points', () => {
    const p = planeFromThreePoints([0, 0, 1], [1, 0, 1], [0, 1, 1], [0, 0, -1])
    p.normal.forEach((v, i) => expect(v).toBeCloseTo([0, 0, -1][i], 12))
    expect(p.point[2]).toBe(1)
    expect(planeFromThreePoints([0, 0, 0], [1, 1, 1], [2, 2, 2])).toBeNull()
  })
})
