import { describe, it, expect } from 'vitest'
import { filterStationaryMatches, stationaryTolPx } from './stationary.js'

const kps = (pts) => ({ x: (i) => pts[i][0], y: (i) => pts[i][1] })

describe('filterStationaryMatches', () => {
  it('drops matches that stay put and keeps the ones that move with the scene', () => {
    // 3 film-frame features (fiducials, a reseau cross) within 15 px; 3 ground points
    // displaced by ~40 % of a 1000 px frame.
    const A = kps([[10, 10], [990, 12], [500, 500], [300, 300], [600, 200], [700, 700]])
    const B = kps([[14, 8], [985, 20], [503, 495], [700, 310], [990, 190], [1050, 690]])
    const m = [0, 1, 2, 3, 4, 5].map((i) => ({ ia: i, ib: i }))
    const r = filterStationaryMatches(A, B, m, { tolPx: stationaryTolPx(1000, 1000, 1.5) })
    expect(r.dropped).toBe(3)
    expect(r.matches.map((x) => x.ia)).toEqual([3, 4, 5])
  })

  it('is off for a zero tolerance', () => {
    const A = kps([[1, 1]]), B = kps([[1, 1]])
    expect(filterStationaryMatches(A, B, [{ ia: 0, ib: 0 }], { tolPx: 0 }).dropped).toBe(0)
  })
})
