import { describe, it, expect } from 'vitest'
import { planBridgeRepair, bridgeKey } from './bridgeRepair.js'

const ok = (idA, idB, inlierCount = 50) => ({ idA, idB, status: 'done', inlierCount, rawCount: 200 })
const rejected = (idA, idB, rawCount) => ({ idA, idB, status: 'done', inlierCount: 0, rawCount })

// Main block a–b–c, a piece x–y, a lone image z.
const imageIds = ['a', 'b', 'c', 'x', 'y', 'z']
const base = [ok('a', 'b'), ok('b', 'c'), ok('x', 'y')]

describe('planBridgeRepair', () => {
  it('does nothing for a connected graph', () => {
    const r = planBridgeRepair({ imageIds: ['a', 'b', 'c'], entries: [ok('a', 'b'), ok('b', 'c')] })
    expect(r).toMatchObject({ components: 1, detached: 0, pieces: 0, pairs: [] })
  })

  it('retries near misses first, then never-matched overlapping pairs, then the other rejects', () => {
    const entries = [...base, rejected('a', 'x', 30), rejected('b', 'y', 3), rejected('c', 'x', 12)]
    const scoreUnmatched = (a, b) => (a === 'c' && b === 'y' ? 0.4 : 0)
    const r = planBridgeRepair({ imageIds, entries, scoreUnmatched })
    expect(r).toMatchObject({ components: 3, mainSize: 3, detached: 3, pieces: 1 }) // z is a lone image
    expect(r.pairs.map((p) => `${p.idA}${p.idB}:${p.source}`)).toEqual(['ax:retry', 'cx:retry', 'cy:new', 'by:retry'])
  })

  it('never proposes an excluded pair or one inside the main block', () => {
    const entries = [...base, { ...rejected('a', 'x', 40), disabled: true }, rejected('a', 'c', 40)]
    expect(planBridgeRepair({ imageIds, entries }).pairs).toEqual([])
  })

  it('retries a weak (PnP-only) pair across pieces', () => {
    const entries = [...base, { ...ok('a', 'x', 12), weak: true }]
    expect(planBridgeRepair({ imageIds, entries }).pairs).toEqual([{ idA: 'a', idB: 'x', source: 'retry', score: 200 }])
  })

  it('shares the pair budget between pieces, round robin', () => {
    const ids = ['a', 'b', 'p1', 'p2', 'q1', 'q2']
    const entries = [
      ok('a', 'b'),
      ok('p1', 'p2'),
      ok('q1', 'q2'),
      ...['p1', 'p2', 'q1', 'q2'].flatMap((p) => [rejected('a', p, 20), rejected('b', p, 20)]),
    ]
    const r = planBridgeRepair({ imageIds: ids, entries, opts: { maxPairs: 3, perComponent: 4 } })
    expect(r.pairs).toHaveLength(3)
    const pieceOf = (p) => (p.idB.startsWith('p') ? 'p' : 'q')
    expect(r.pairs.map(pieceOf).sort()).toEqual(['p', 'p', 'q'])
  })
  it('leaves out pairs an earlier round tried', () => {
    const entries = [...base, rejected('a', 'x', 30), rejected('c', 'x', 12)]
    const r = planBridgeRepair({ imageIds, entries, tried: new Set([bridgeKey('x', 'a')]) })
    expect(r.pairs.map((p) => p.idA + p.idB)).toEqual(['cx'])
  })
})
