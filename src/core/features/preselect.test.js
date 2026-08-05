import { describe, it, expect } from 'vitest'
import { preselectPairs, positionsForProximity, footprintOverlap, preselectByFootprintOverlap } from './preselect.js'

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

  it('uses planar distance and ignores altitude', () => {
    const items = [
      { uuid: 'a', pos: [0, 0, 10000] },
      { uuid: 'b', pos: [1, 0, -10000] },
      { uuid: 'c', pos: [5, 0, 10000] },
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

describe('positionsForProximity', () => {
  it('drops altitude in a projected CRS', () => {
    expect(positionsForProximity([{ uuid: 'a', pos: [3, 4, 99] }], 'EPSG:3857'))
      .toEqual([{ uuid: 'a', pos: [3, 4] }])
  })

  it('turns geographic positions into locally metric XY, including across the dateline', () => {
    const out = positionsForProximity([
      { uuid: 'west', pos: [179.999, 10, 0] },
      { uuid: 'east', pos: [-179.999, 10, 5000] },
    ], 'EPSG:4326')
    expect(out).toHaveLength(2)
    expect(Math.hypot(out[0].pos[0] - out[1].pos[0], out[0].pos[1] - out[1].pos[1]))
      .toBeLessThan(250)
  })
})

// Unit square [0,1]², shifted by dx along x. Closed ring (repeats first vertex),
// matching what core/footprint.js emits.
const squareAt = (dx) => [[dx, 0], [dx + 1, 0], [dx + 1, 1], [dx, 1], [dx, 0]]

describe('footprintOverlap', () => {
  it('is 1 for identical footprints', () => {
    expect(footprintOverlap(squareAt(0), squareAt(0))).toBeCloseTo(1, 6)
  })

  it('measures the shared fraction of two overlapping squares', () => {
    // Two unit squares offset by 0.25 share a 0.75×1 strip ⇒ 0.75 of each.
    expect(footprintOverlap(squareAt(0), squareAt(0.25))).toBeCloseTo(0.75, 6)
  })

  it('is 0 for disjoint footprints', () => {
    expect(footprintOverlap(squareAt(0), squareAt(2))).toBe(0)
  })

  it('is 0 for footprints that only touch at an edge', () => {
    expect(footprintOverlap(squareAt(0), squareAt(1))).toBe(0)
  })

  it('normalises by the SMALLER footprint (a small one inside a big one scores ~1)', () => {
    const big = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]
    const small = [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]  // fully inside big
    expect(footprintOverlap(big, small)).toBeCloseTo(1, 6)
    expect(footprintOverlap(small, big)).toBeCloseTo(1, 6)   // symmetric
  })

  it('handles open rings (no repeated closing vertex)', () => {
    const open = (dx) => [[dx, 0], [dx + 1, 0], [dx + 1, 1], [dx, 1]]
    expect(footprintOverlap(open(0), open(0.25))).toBeCloseTo(0.75, 6)
  })

  it('handles a rotated (convex) footprint', () => {
    // A diamond centred at (0.5,0.5) with area 0.5, fully inside the unit square.
    const diamond = [[0.5, 0.1], [0.9, 0.5], [0.5, 0.9], [0.1, 0.5], [0.5, 0.1]]
    expect(footprintOverlap(squareAt(0), diamond)).toBeCloseTo(1, 6) // diamond ⊂ square
  })
})

describe('preselectByFootprintOverlap', () => {
  // A strip of unit squares each overlapping its neighbour by 0.75.
  const strip = [
    { uuid: 'a', ring: squareAt(0) },
    { uuid: 'b', ring: squareAt(0.25) },
    { uuid: 'c', ring: squareAt(0.5) },
    { uuid: 'd', ring: squareAt(3) },   // far away — overlaps nothing
  ]

  it('keeps pairs above the overlap threshold, drops the rest', () => {
    const keep = preselectByFootprintOverlap(strip, { minOverlap: 0.5 })
    expect(keep.has('a--b')).toBe(true)   // 0.75
    expect(keep.has('b--c')).toBe(true)   // 0.75
    expect(keep.has('a--c')).toBe(true)   // squares 0 and 0.5 share 0.5 ⇒ == threshold
    expect(keep.has('a--d')).toBe(false)  // disjoint
    expect(keep.has('c--d')).toBe(false)  // disjoint
  })

  it('a stricter threshold prunes the weaker overlaps', () => {
    const keep = preselectByFootprintOverlap(strip, { minOverlap: 0.6 })
    expect(keep.has('a--b')).toBe(true)   // 0.75 ≥ 0.6
    expect(keep.has('a--c')).toBe(false)  // 0.5 < 0.6
  })

  it('returns an empty set for fewer than two footprints', () => {
    expect(preselectByFootprintOverlap([{ uuid: 'a', ring: squareAt(0) }]).size).toBe(0)
    expect(preselectByFootprintOverlap([]).size).toBe(0)
  })
})
