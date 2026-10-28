import { describe, expect, it } from 'vitest'
import {
  concatMatchParts,
  matchByteRange,
  packMatchDocument,
  packMatchFlags,
  planMatchReads,
  toMatchArray,
  unpackMatchIndex,
} from './matchStorage.js'

const F = [
  [0, -1, 2],
  [1, 0, -3],
  [-2, 3, 0.5],
]
const entries = () =>
  new Map([
    [
      'a--b',
      {
        idA: 'a',
        idB: 'b',
        rawCount: 40,
        inlierCount: 3,
        F,
        matches: toMatchArray([
          [1, 2],
          [3, 4],
          [5, 6],
        ]),
        status: 'done',
        enabled: true,
        weak: false,
      },
    ],
    [
      'a--c',
      {
        idA: 'a',
        idB: 'c',
        rawCount: 9,
        inlierCount: 1,
        F: null,
        matches: [[7, 8]],
        status: 'done',
        enabled: false,
        weak: true,
      },
    ],
    // Persisted with no matches: a rejected pair (tried, so a reload still counts it).
    ['b--c', { idA: 'b', idB: 'c', rawCount: 5, inlierCount: 0, F: null, matches: new Uint32Array(0), status: 'done' }],
    // Not persisted: running.
    [
      'c--d',
      { idA: 'c', idB: 'd', rawCount: 5, inlierCount: 2, F: null, matches: toMatchArray([[1, 1]]), status: 'running' },
    ],
  ])

// The bytes a writer would commit, and a reader's view of one pair from them.
const column = (doc) => concatMatchParts(doc.matchParts)
const slice = (col, e) => {
  const [s, t] = matchByteRange(e.off, e.nMatches)
  return new Uint32Array(col.buffer.slice(s, t))
}

describe('match document', () => {
  it('round-trips the persisted pairs: an index without matches, then per-pair byte ranges', () => {
    const doc = packMatchDocument(entries())
    expect(doc.meta.count).toBe(3)
    expect(doc.meta.images).toEqual(['a', 'b', 'c'])
    expect(doc.buffers.matches).toBeUndefined() // the index never carries the matches
    const col = column(doc)
    const back = new Map(unpackMatchIndex(doc.meta, doc.buffers, { matchBytes: col.byteLength }))
    expect([...back.keys()]).toEqual(['a--b', 'a--c', 'b--c'])
    const ab = back.get('a--b')
    expect(ab).toMatchObject({
      rawCount: 40,
      inlierCount: 3,
      nMatches: 3,
      off: 0,
      enabled: true,
      weak: false,
      status: 'done',
    })
    expect(ab.F).toEqual(F)
    expect([...slice(col, ab)]).toEqual([1, 2, 3, 4, 5, 6])
    const ac = back.get('a--c')
    expect(ac).toMatchObject({ F: null, enabled: false, weak: true, nMatches: 1, off: 6 })
    expect([...slice(col, ac)]).toEqual([7, 8])
    expect(back.get('b--c')).toMatchObject({ rawCount: 5, inlierCount: 0, nMatches: 0, off: 8, status: 'done' })
    expect(doc.layout.map(({ pairId, off, n }) => [pairId, off, n])).toEqual([
      ['a--b', 0, 3],
      ['a--c', 6, 1],
      ['b--c', 8, 0],
    ])
  })

  it("packs entries that carry only a count, taking each pair's bytes from matchesOf", () => {
    const lazy = new Map([
      ['a--b', { idA: 'a', idB: 'b', rawCount: 4, inlierCount: 2, F: null, nMatches: 2, status: 'done' }],
    ])
    const part = { opaque: 'blob slice' }
    const doc = packMatchDocument(lazy, { matchesOf: () => part })
    expect(doc.matchParts).toEqual([part])
    expect(doc.matchElements).toBe(4)
    expect([...doc.buffers.counts]).toEqual([4, 2, 2])
    // A typed part must agree with the count it is filed under.
    expect(() => packMatchDocument(lazy, { matchesOf: () => new Uint32Array(2) })).toThrow(/count says 2/)
  })

  it('keeps flags in their own buffer, in pair order', () => {
    const kept = [...entries().values()].slice(0, 2)
    expect([...packMatchFlags(kept)]).toEqual([4, 3])
  })

  it('refuses a document whose sizes disagree', () => {
    const doc = packMatchDocument(entries())
    const bytes = column(doc).byteLength
    expect(() => unpackMatchIndex(doc.meta, doc.buffers, { matchBytes: bytes - 8 })).toThrow(/Incomplete/)
    expect(() => unpackMatchIndex(doc.meta, { ...doc.buffers, counts: new Uint32Array(3) })).toThrow(/Incomplete/)
    expect(() => unpackMatchIndex({ ...doc.meta, version: 9 }, doc.buffers)).toThrow(/version/)
  })

  it('packs a legacy tuple list', () => {
    expect([
      ...toMatchArray([
        [1, 2],
        [3, 4],
      ]),
    ]).toEqual([1, 2, 3, 4])
    const m = new Uint32Array([1, 2])
    expect(toMatchArray(m)).toBe(m)
  })
})

describe('planMatchReads', () => {
  const file = {},
    other = {}
  const it_ = (off, n, f = file) => ({ file: f, off, n })

  it('merges ascending, adjacent pairs of one file into one read', () => {
    const w = planMatchReads([it_(0, 2), it_(4, 1), it_(6, 3)])
    expect(w).toHaveLength(1)
    expect([w[0].start, w[0].end, w[0].items.length]).toEqual([0, 48, 3])
  })

  it('splits on a file change, a backwards step, a large gap or the window size', () => {
    expect(planMatchReads([it_(0, 1), it_(2, 1, other)])).toHaveLength(2)
    expect(planMatchReads([it_(10, 1), it_(0, 1)])).toHaveLength(2)
    expect(planMatchReads([it_(0, 1), it_(1e6, 1)], { maxGapBytes: 1024 })).toHaveLength(2)
    expect(planMatchReads([it_(0, 100), it_(200, 100)], { windowBytes: 1000 })).toHaveLength(2)
    // A gap within the limit is read through, not split.
    expect(planMatchReads([it_(0, 1), it_(10, 1)], { maxGapBytes: 1024 })).toHaveLength(1)
  })
})
