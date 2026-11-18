import { describe, expect, it } from 'vitest'
import { AUTHALIC_RADIUS, authalicLatitude, ellipsoidArea, geodesicDistance, geodesicLength } from './geodesic.js'
import { WGS84_A } from '../constants.js'

const dms = (d, m, s) => Math.sign(d) * (Math.abs(d) + m / 60 + s / 3600)

describe('geodesicDistance', () => {
  it("matches Vincenty's own test line, Flinders Peak to Buninyong (54,972.271 m)", () => {
    const flinders = [dms(144, 25, 29.5244), dms(-37, 57, 3.7203)]
    const buninyong = [dms(143, 55, 35.3839), dms(-37, 39, 10.1561)]
    expect(geodesicDistance(flinders, buninyong)).toBeCloseTo(54972.271, 2)
  })

  it('gives a degree of the equator as a·π/180, the short way across the antimeridian too', () => {
    const deg = (WGS84_A * Math.PI) / 180
    expect(geodesicDistance([10, 0], [11, 0])).toBeCloseTo(deg, 4)
    expect(geodesicDistance([179.5, 0], [-179.5, 0])).toBeCloseTo(deg, 4)
  })

  it('gives the WGS84 quarter meridian (10,001,965.729 m)', () => {
    expect(geodesicDistance([7, 0], [7, 90])).toBeCloseTo(10001965.729, 2)
  })

  it('is zero for one point, and symmetric', () => {
    expect(geodesicDistance([4.37, 52.0], [4.37, 52.0])).toBe(0)
    const a = [4.37, 52.0],
      b = [5.1, 51.2]
    expect(geodesicDistance(a, b)).toBeCloseTo(geodesicDistance(b, a), 6)
  })

  it('still answers for nearly antipodal points, near half the meridian', () => {
    const d = geodesicDistance([0, 0.5], [179.7, -0.5])
    expect(d).toBeGreaterThan(19.9e6)
    expect(d).toBeLessThan(20.04e6)
  })
})

describe('geodesicLength', () => {
  it('sums the segments, and closes the ring when asked', () => {
    const pts = [
      [10, 0],
      [11, 0],
      [11, 1],
    ]
    const open = geodesicDistance(pts[0], pts[1]) + geodesicDistance(pts[1], pts[2])
    expect(geodesicLength(pts)).toBeCloseTo(open, 6)
    expect(geodesicLength(pts, { closed: true })).toBeCloseTo(open + geodesicDistance(pts[2], pts[0]), 6)
  })
})

describe('ellipsoidArea', () => {
  it('uses the authalic sphere of the WGS84 surface (510,065,621.7 km²)', () => {
    expect((4 * Math.PI * AUTHALIC_RADIUS ** 2) / 1e6).toBeCloseTo(510065621.7, 0)
  })

  // A cell between two parallels and two meridians has the closed-form area
  // R_q² · Δλ · (sin β₂ − sin β₁) on the ellipsoid (β the authalic latitude).
  const cellArea = (lat1, lat2, dLon) =>
    AUTHALIC_RADIUS ** 2 *
    dLon *
    (Math.PI / 180) *
    (Math.sin(authalicLatitude(lat2)) - Math.sin(authalicLatitude(lat1)))

  it.each([
    [0, 0.01],
    [45, 45.01],
    [-70, -69.99],
  ])('gives the area of a small cell at latitude %d', (lat1, lat2) => {
    const ring = [
      [10, lat1],
      [10.01, lat1],
      [10.01, lat2],
      [10, lat2],
    ]
    const exact = cellArea(lat1, lat2, 0.01)
    expect(Math.abs(ellipsoidArea(ring) - exact) / exact).toBeLessThan(1e-6)
    // Either winding gives the same area.
    expect(ellipsoidArea([...ring].reverse())).toBeCloseTo(ellipsoidArea(ring), 3)
  })

  // A 1° cell (about 110 km) shows the projection is equal-area: without its scale
  // term the error is four times larger. The rest is the straight edges.
  it('stays within a few 1e-5 on a one-degree cell', () => {
    const ring = [
      [10, 0],
      [11, 0],
      [11, 1],
      [10, 1],
    ]
    const exact = cellArea(0, 1, 1)
    expect(Math.abs(ellipsoidArea(ring) - exact) / exact).toBeLessThan(2.5e-5)
  })

  it('keeps a polygon across the antimeridian in one piece', () => {
    const across = [
      [179.995, 30],
      [-179.995, 30],
      [-179.995, 30.01],
      [179.995, 30.01],
    ]
    const exact = cellArea(30, 30.01, 0.01)
    expect(Math.abs(ellipsoidArea(across) - exact) / exact).toBeLessThan(1e-6)
  })

  it('refuses a ring whose edges cross, and is 0 below three points', () => {
    const bowtie = [
      [0, 0],
      [0.01, 0.01],
      [0.01, 0],
      [0, 0.01],
    ]
    expect(ellipsoidArea(bowtie)).toBeNull()
    expect(ellipsoidArea([[0, 0]])).toBe(0)
  })
})
