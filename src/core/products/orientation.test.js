import { describe, it, expect } from 'vitest'
import { normalizeOrientation, orientationStatus, orientationBasis, upFromPlane } from './orientation.js'
import { makeFrame } from './projection.js'

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

describe('orientation', () => {
  it('normalizes up to unit length and rejects junk', () => {
    expect(normalizeOrientation({ up: [0, 0, 2], origin: [1, 2, 3] })).toMatchObject({ up: [0, 0, 1], headingDeg: 0 })
    expect(normalizeOrientation({ up: [0, 0, 0], origin: [0, 0, 0] })).toBeNull()
    expect(normalizeOrientation({ up: [0, 0, 1], origin: [0, NaN, 0] })).toBeNull()
  })

  it('is stamped like the region', () => {
    const o = { up: [0, 1, 0], origin: [0, 0, 0], sourceStamp: { id: 'm', createdAt: 1 } }
    expect(orientationStatus(o, { id: 'm', createdAt: 1 }).active).toBe(true)
    expect(orientationStatus(o, { id: 'm', createdAt: 2 }).reason).toBe('stale')
  })

  it('builds a right-handed orthonormal basis that a heading turns about up', () => {
    const tilted = { up: [0, 1, 0], origin: [5, 5, 5], headingDeg: 30 }
    const b = orientationBasis(tilted)
    expect(b.up).toEqual([0, 1, 0])
    expect(Math.abs(dot(b.east, b.up))).toBeLessThan(1e-12)
    expect(Math.abs(dot(b.north, b.east))).toBeLessThan(1e-12)
    cross(b.east, b.north).forEach((v, i) => expect(v).toBeCloseTo(b.up[i], 12))
    const b0 = orientationBasis({ ...tilted, headingDeg: 0 })
    expect(Math.acos(dot(b0.east, b.east)) * 180 / Math.PI).toBeCloseTo(30, 9)
    // A frame built on it maps the origin to 0 and up to +Z.
    const f = makeFrame({ ...b, crs: 'local', unit: 'model' })
    expect(f.fromSfm([5, 5, 5])).toEqual([0, 0, 0])
    expect(f.fromSfm([5, 7, 5])[2]).toBeCloseTo(2, 12)
  })

  it('turns a ground-plane normal to the cameras’ side', () => {
    expect(upFromPlane([0, 0, -1], [0, 0, 0], [[0, 0, 10], [1, 0, 12]])).toEqual([0, 0, 1])
    expect(upFromPlane([0, 0, 1], [0, 0, 0], [])).toEqual([0, 0, 1])
  })
})
