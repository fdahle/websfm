import { describe, it, expect } from 'vitest'
import { siblingCanonicalMap, canonicalizeMatches } from './orientationSiblings.js'

const kp = (x, y, scale = 2) => ({ x, y, scale })

describe('siblingCanonicalMap', () => {
  it('maps every sibling to the first keypoint at the same x, y, scale', () => {
    const canon = siblingCanonicalMap([kp(1, 1), kp(5, 5), kp(1, 1), kp(1, 1, 3), kp(5, 5)])
    expect([...canon]).toEqual([0, 1, 0, 3, 1])
  })

  it('returns null when there are no siblings, or no scale (SuperPoint)', () => {
    expect(siblingCanonicalMap([kp(1, 1), kp(2, 2)])).toBeNull()
    expect(siblingCanonicalMap([{ x: 1, y: 1 }, { x: 1, y: 1 }])).toBeNull()
    expect(siblingCanonicalMap([])).toBeNull()
  })
})

describe('canonicalizeMatches', () => {
  // A: 0 and 2 are siblings. B: 1 and 3 are siblings.
  const canonA = Int32Array.from([0, 1, 0, 3])
  const canonB = Int32Array.from([0, 1, 2, 1])

  it('passes matches through untouched when neither image has siblings', () => {
    const m = [{ ia: 0, ib: 1, dist: 1 }]
    expect(canonicalizeMatches(m, null, null)).toEqual({ matches: m, merged: 0, ambiguous: 0 })
  })

  it('merges sibling-to-sibling duplicates, keeping the smallest distance', () => {
    const res = canonicalizeMatches([
      { ia: 0, ib: 1, dist: 0.4 },
      { ia: 2, ib: 3, dist: 0.3 }, // same feature pair via the other orientations
      { ia: 1, ib: 2, dist: 0.5 },
    ], canonA, canonB)
    expect(res).toEqual({ matches: [{ ia: 0, ib: 1, dist: 0.3 }, { ia: 1, ib: 2, dist: 0.5 }], merged: 1, ambiguous: 0 })
  })

  it('re-expresses a match made only through a secondary orientation', () => {
    const res = canonicalizeMatches([{ ia: 2, ib: 0, dist: 0.2 }], canonA, canonB)
    expect(res.matches).toEqual([{ ia: 0, ib: 0, dist: 0.2 }])
  })

  it('drops a feature matched to two different features as ambiguous', () => {
    const res = canonicalizeMatches([
      { ia: 0, ib: 0, dist: 0.2 },
      { ia: 2, ib: 2, dist: 0.2 }, // A's feature 0 (via sibling 2) → a different B feature
      { ia: 3, ib: 1, dist: 0.4 },
    ], canonA, canonB)
    expect(res.matches).toEqual([{ ia: 3, ib: 1, dist: 0.4 }])
    expect(res.ambiguous).toBe(2)
  })
})
