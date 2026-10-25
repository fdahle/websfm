import { describe, it, expect } from 'vitest'
import { siblingCanonicalMap, canonicalizeMatches } from './orientationSiblings.js'
import { keypointsFromObjects as K } from './keypoints.js'

const kp = (x, y, scale = 2) => ({ x, y, scale })

describe('siblingCanonicalMap', () => {
  // The map as it was built before the sort: a string key per keypoint.
  const byString = (kps) => {
    const first = new Map(),
      canon = Int32Array.from({ length: kps.length }, (_, i) => i)
    let any = false
    for (let i = 0; i < kps.length; i++) {
      const key = `${kps.x(i)},${kps.y(i)},${kps.scale(i)}`
      if (first.has(key)) {
        canon[i] = first.get(key)
        any = true
      } else first.set(key, i)
    }
    return any ? canon : null
  }
  it('gives the string-keyed map on many duplicates, −0, and an image with a NaN', () => {
    let st = 9
    const r = () => (st = (Math.imul(st, 1103515245) + 12345) >>> 0) / 2 ** 32
    for (let t = 0; t < 30; t++) {
      const objs = Array.from({ length: 400 }, () =>
        kp(Math.floor(r() * 12) / 2, Math.floor(r() * 9) / 4, 1 + Math.floor(r() * 3)),
      )
      if (t % 5 === 1) objs[7] = kp(-0, 0, 1)
      if (t % 5 === 2) objs[3] = kp(0, 0, 1)
      if (t % 10 === 3) objs[11] = kp(NaN, 2, 1)
      if (t % 10 === 4) objs.splice(0, objs.length, ...objs.map((_, i) => kp(i, i, 1))) // no siblings
      const kps = K(objs)
      const got = siblingCanonicalMap(kps),
        want = byString(kps)
      expect(got && Array.from(got)).toEqual(want && Array.from(want))
    }
  })
  it('maps every sibling to the first keypoint at the same x, y, scale', () => {
    const canon = siblingCanonicalMap(K([kp(1, 1), kp(5, 5), kp(1, 1), kp(1, 1, 3), kp(5, 5)]))
    expect([...canon]).toEqual([0, 1, 0, 3, 1])
  })

  it('returns null when there are no siblings, or no scale (SuperPoint)', () => {
    expect(siblingCanonicalMap(K([kp(1, 1), kp(2, 2)]))).toBeNull()
    expect(
      siblingCanonicalMap(
        K([
          { x: 1, y: 1 },
          { x: 1, y: 1 },
        ]),
      ),
    ).toBeNull()
    expect(siblingCanonicalMap(K([]))).toBeNull()
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
    const res = canonicalizeMatches(
      [
        { ia: 0, ib: 1, dist: 0.4 },
        { ia: 2, ib: 3, dist: 0.3 }, // same feature pair via the other orientations
        { ia: 1, ib: 2, dist: 0.5 },
      ],
      canonA,
      canonB,
    )
    expect(res).toEqual({
      matches: [
        { ia: 0, ib: 1, dist: 0.3 },
        { ia: 1, ib: 2, dist: 0.5 },
      ],
      merged: 1,
      ambiguous: 0,
    })
  })

  it('re-expresses a match made only through a secondary orientation', () => {
    const res = canonicalizeMatches([{ ia: 2, ib: 0, dist: 0.2 }], canonA, canonB)
    expect(res.matches).toEqual([{ ia: 0, ib: 0, dist: 0.2 }])
  })

  it('drops a feature matched to two different features as ambiguous', () => {
    const res = canonicalizeMatches(
      [
        { ia: 0, ib: 0, dist: 0.2 },
        { ia: 2, ib: 2, dist: 0.2 }, // A's feature 0 (via sibling 2) → a different B feature
        { ia: 3, ib: 1, dist: 0.4 },
      ],
      canonA,
      canonB,
    )
    expect(res.matches).toEqual([{ ia: 3, ib: 1, dist: 0.4 }])
    expect(res.ambiguous).toBe(2)
  })
})
