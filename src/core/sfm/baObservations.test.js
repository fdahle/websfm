import { describe, it, expect } from 'vitest'
import { mapObservations } from './baObservations.js'

describe('mapObservations', () => {
  const list = () => ({ n: 3, cam: Int32Array.of(0, 1, 0), pt: Int32Array.of(0, 0, 1),
    x: Float64Array.of(1, 2, 3), y: Float64Array.of(4, 5, 6), wx: null, wy: null })

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
