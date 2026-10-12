import { describe, expect, it } from 'vitest'
import { Uint32PairList, packMatchPairs, wrapPackedMatches, asPairList, swapMatchRoles, transposeF } from './matchCodec.js'

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

describe('asPairList', () => {
  it('wraps packed matches and packs plain lists, with indexed a(i) / b(i)', () => {
    const packed = new Uint32PairList(Uint32Array.from([3, 4, 5, 6]))
    expect(asPairList(packed)).toBe(packed)
    const fromArray = asPairList([[1, 2], [7, 8]])
    expect([fromArray.length, fromArray.a(1), fromArray.b(1)]).toEqual([2, 7, 8])
    const fromTyped = asPairList(Uint32Array.from([9, 10]))
    expect([fromTyped.a(0), fromTyped.b(0)]).toEqual([9, 10])
  })
})

describe('swapMatchRoles / transposeF', () => {
  it('swaps each pair and leaves the input alone', () => {
    const m = Uint32Array.from([1, 2, 3, 4])
    expect(Array.from(swapMatchRoles(m))).toEqual([2, 1, 4, 3])
    expect(Array.from(m)).toEqual([1, 2, 3, 4])
  })
  it('transposes F so the epipolar constraint holds with the roles swapped', () => {
    const F = [[0, -0.3, 0.2], [0.4, 0, -1.1], [-0.25, 0.9, 0.05]]
    const a = [3, 7, 1], b = [5, -2, 1]
    const xFy = (x, M, y) => x.reduce((s, xi, r) => s + xi * M[r].reduce((t, m, c) => t + m * y[c], 0), 0)
    expect(xFy(b, F, a)).toBeCloseTo(xFy(a, transposeF(F), b), 12)
  })
})
