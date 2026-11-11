import { describe, it, expect } from 'vitest'
import { mapObservations, buildBaObservations, appendObservations, tieWeightOf } from './baObservations.js'

describe('mapObservations', () => {
  const list = () => ({
    n: 3,
    cam: Int32Array.of(0, 1, 0),
    pt: Int32Array.of(0, 0, 1),
    x: Float64Array.of(1, 2, 3),
    y: Float64Array.of(4, 5, 6),
    wx: null,
    wy: null,
  })

  it("moves only the mapped cameras' pixels, leaving the input untouched", () => {
    const obs = list()
    const out = mapObservations(obs, (ci) => (ci === 0 ? (x, y) => ({ x: x + 10, y: y * 2 }) : null))
    expect([...out.x]).toEqual([11, 2, 13])
    expect([...out.y]).toEqual([8, 5, 12])
    expect(out.cam).toBe(obs.cam)
    expect([...obs.x]).toEqual([1, 2, 3])
  })

  it('returns the list itself when no camera has a map', () => {
    const obs = list()
    expect(mapObservations(obs, () => null)).toBe(obs)
  })
})

describe('tie weights', () => {
  // Two points, each seen in two images; keypoints at (10·img + kp, 0).
  const views = [
    [
      [0, 0],
      [1, 0],
    ],
    [
      [0, 1],
      [1, 1],
    ],
  ]
  const tracks = {
    viewCount: (p) => views[p].length,
    forEachView: (p, fn) => views[p].forEach(([img, kp]) => fn(img, kp)),
  }
  const kp = (img) => ({ n: 2, xy: Float64Array.of(10 * img, 0, 10 * img + 1, 0) })
  const ids = Int32Array.of(0, 1)

  it('is 1 / f² for a detection that was downscaled f times, and 1 otherwise', () => {
    expect(tieWeightOf(4)).toBe(1 / 16)
    expect(tieWeightOf(4.76)).toBeCloseTo(1 / 22.6576, 12)
    for (const f of [1, 0.5, 0, -2, NaN, undefined, null]) expect(tieWeightOf(f)).toBe(1)
  })

  it('leaves the observations unweighted at weight 1', () => {
    const o = buildBaObservations(tracks, ids, (img) => img, kp)
    expect(o.n).toBe(4)
    expect(o.wx).toBeNull()
  })

  it('gives every tie the weight, and GCP marks appended after them keep their own', () => {
    const o = buildBaObservations(tracks, ids, (img) => img, kp, 1 / 16)
    expect([...o.wx]).toEqual([1 / 16, 1 / 16, 1 / 16, 1 / 16])
    expect([...o.wy]).toEqual([...o.wx])
    expect([...o.x]).toEqual([0, 10, 1, 11])
    const all = appendObservations(o, [{ camIdx: 0, ptIdx: 2, x: 5, y: 5, weightX: 4, weightY: 4 }])
    expect([...all.wx]).toEqual([1 / 16, 1 / 16, 1 / 16, 1 / 16, 4])
  })
})
