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

  it('keeps every pair when maxNeighbors ≥ N-1 (degrades to exhaustive)', () => {
    const keep = preselectPairs(strip, { maxNeighbors: 10 })
    expect(keep.size).toBe(10) // C(5,2)
    for (const a of ['a', 'b', 'c', 'd', 'e']) {
      for (const b of ['a', 'b', 'c', 'd', 'e']) {
        if (a < b) expect(keep.has(`${a}--${b}`)).toBe(true)
      }
    }
  })

  it('returns an empty set for a single item (no pairs possible)', () => {
    expect(preselectPairs([{ uuid: 'a', pos: [0, 0, 0] }]).size).toBe(0)
  })

  it('returns an empty set for no items', () => {
    expect(preselectPairs([]).size).toBe(0)
  })

  it('treats a missing z as 0 in the distance', () => {
    // 2D positions (no z) must not throw and should rank by planar distance.
    const items = [
      { uuid: 'a', pos: [0, 0] },
      { uuid: 'b', pos: [1, 0] },
      { uuid: 'c', pos: [5, 0] },
    ]
    const keep = preselectPairs(items, { maxNeighbors: 1 })
    expect(keep.has('a--b')).toBe(true)
    expect(keep.has('a--c')).toBe(false)
  })

  it('breaks distance ties by keeping enough neighbours to cover them', () => {
    // b and c are equidistant from a; with k=2 both are kept.
    const items = [
      { uuid: 'a', pos: [0, 0, 0] },
      { uuid: 'b', pos: [1, 0, 0] },
      { uuid: 'c', pos: [-1, 0, 0] },
    ]
    const keep = preselectPairs(items, { maxNeighbors: 2 })
    expect(keep.has('a--b')).toBe(true)
    expect(keep.has('a--c')).toBe(true)
  })
})
