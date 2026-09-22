import { describe, expect, it } from 'vitest'
import { Uint32PairList, packMatchPairs, wrapPackedMatches } from './matchCodec.js'

describe('reconstruction match transport', () => {
  it('packs tuples into eight bytes per match and preserves the solver read API', () => {
    const packed = packMatchPairs([[1, 2], [3, 4], [5, 6]])
    expect(packed.byteLength).toBe(24)
    const pairs = wrapPackedMatches([{ matches: packed }])[0].matches
    expect(pairs).toBeInstanceOf(Uint32PairList)
    expect(pairs.length).toBe(3)
    expect(pairs.at(1)).toEqual([3, 4])
    expect(pairs.at(-1)).toEqual([5, 6])
    expect(pairs.map(([a, b]) => a + b)).toEqual([3, 7, 11])
    expect(pairs.filter(([a]) => a >= 3)).toEqual([[3, 4], [5, 6]])
    expect([...pairs]).toEqual([[1, 2], [3, 4], [5, 6]])

    const cloned = structuredClone([{ matches: pairs }])
    const rewrapped = wrapPackedMatches(cloned)[0].matches
    expect(rewrapped).toBeInstanceOf(Uint32PairList)
    expect(rewrapped.at(0)).toEqual([1, 2])
  })
})
