import { describe, it, expect } from 'vitest'
import {
  mapObservations,
  buildBaObservations,
  appendObservations,
  tieWeightOf,
  tieScaleWeight,
  tieScaleWeightCounts,
} from './baObservations.js'

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

  it("weighs a keypoint by its scale against its image's finest, 1 / clamp(s / s₀, 1, cap)²", () => {
    // σ ∝ scale: twice the finest scale is half the precision, a quarter of the weight.
    expect(tieScaleWeight(4, 2, 8)).toBe(1 / 4)
    expect(tieScaleWeight(2, 2, 8)).toBe(1)
    expect(tieScaleWeight(1, 2, 8)).toBe(1) // never more than the finest
    expect(tieScaleWeight(100, 2, 4)).toBe(1 / 16) // capped at 4× the finest
    // No scale, no finest scale, or the switch off: the weight is left alone.
    for (const [s, s0, cap] of [
      [0, 2, 4],
      [4, 0, 4],
      [4, 2, 0],
      [4, 2, 1],
      [NaN, 2, 4],
    ])
      expect(tieScaleWeight(s, s0, cap)).toBe(1)
  })

  it('multiplies the tie weight by the scale weight when the cap is on, and only then', () => {
    // Image 0's keypoints at scales 2 and 6 (finest 2), image 1's at 3 and 3.
    const scales = [Float32Array.of(2, 6), Float32Array.of(3, 3)]
    const kps = (img) => ({ ...kp(img), scale: scales[img] })
    const off = buildBaObservations(tracks, ids, (img) => img, kps, 1 / 16)
    expect([...off.wx]).toEqual([1 / 16, 1 / 16, 1 / 16, 1 / 16])
    const on = buildBaObservations(tracks, ids, (img) => img, kps, 1 / 16, 4)
    // Order: point 0 in images 0, 1 (keypoint 0), point 1 in images 0, 1 (keypoint 1).
    expect([...on.wx]).toEqual([1 / 16, 1 / 16, 1 / 16 / 9, 1 / 16])
    expect([...on.wy]).toEqual([...on.wx])
    expect(tieScaleWeightCounts(on, 1 / 16)).toEqual({ n: 4, lowered: 1, bands: [3, 1, 0, 0] })
    // Without scales (a learned detector), the cap changes nothing.
    expect([...buildBaObservations(tracks, ids, (img) => img, kp, 1 / 16, 4).wx]).toEqual([...off.wx])
  })
})
