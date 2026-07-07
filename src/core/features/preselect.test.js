import { describe, it, expect } from 'vitest'
import { preselectPairs } from './preselect.js'

describe('preselectPairs', () => {
  // Five cameras evenly spaced along a line (a flight strip).
  const strip = [
    { uuid: 'a', pos: [0, 0, 0] },
    { uuid: 'b', pos: [1, 0, 0] },
    { uuid: 'c', pos: [2, 0, 0] },
    { uuid: 'd', pos: [3, 0, 0] },
    { uuid: 'e', pos: [4, 0, 0] },
  ]

  it('keeps each camera to its k nearest, cutting O(N²) down for a strip', () => {
    const keep = preselectPairs(strip, { maxNeighbors: 1 })
    // Each keeps its single nearest; the relation is symmetric ⇒ the chain a-b-c-d-e.
    expect(keep).toEqual(new Set(['a--b', 'b--c', 'c--d', 'd--e']))
    // Far pairs are dropped.
    expect(keep.has('a--e')).toBe(false)
    expect(keep.has('a--c')).toBe(false)
  })

  it('maxNeighbors=2 widens the window (still fewer than exhaustive 10)', () => {
    const keep = preselectPairs(strip, { maxNeighbors: 2 })
    expect(keep.has('a--b')).toBe(true)
    expect(keep.has('a--c')).toBe(true)   // 2nd nearest to a
    expect(keep.has('a--d')).toBe(false)  // beyond the window
    expect(keep.size).toBeLessThan(10)    // exhaustive would be C(5,2)=10
  })

  it('respects maxDistance', () => {
    const keep = preselectPairs(strip, { maxNeighbors: 10, maxDistance: 1.5 })
    expect(keep.has('a--b')).toBe(true)   // distance 1
    expect(keep.has('a--c')).toBe(false)  // distance 2 > 1.5
  })

  it('handles a 2D block (nearest neighbours are the grid neighbours)', () => {
    const block = [
      { uuid: 'p00', pos: [0, 0, 0] }, { uuid: 'p10', pos: [1, 0, 0] },
      { uuid: 'p01', pos: [0, 1, 0] }, { uuid: 'p11', pos: [1, 1, 0] },
    ]
    const keep = preselectPairs(block, { maxNeighbors: 2 })
    // Each corner's two nearest are its edge neighbours (dist 1), not the diagonal (√2).
    expect(keep.has('p00--p11')).toBe(false)
    expect(keep.has('p00--p10')).toBe(true)
    expect(keep.has('p00--p01')).toBe(true)
  })
})
