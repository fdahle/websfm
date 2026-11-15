import { describe, it, expect } from 'vitest'
import { planBridgeRepair, bridgeKey, retryIsWorse } from './bridgeRepair.js'

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
  it('repairs a piece that hangs on the main block by a thread', () => {
    // a–b–c hold together; x–y join them through one 20-inlier pair; c–x near-missed.
    const entries = [ok('a', 'b', 300), ok('b', 'c', 300), ok('x', 'y', 300), ok('a', 'x', 20), rejected('c', 'x', 25)]
    const opts = { weakInliers: 30, weakCut: 100 }
    const r = planBridgeRepair({ imageIds: ['a', 'b', 'c', 'x', 'y'], entries, opts })
    expect(r).toMatchObject({ components: 1, pieces: 0, weakPieces: 1, weakImages: 2 })
    expect(r.pairs.map((p) => p.idA + p.idB)).toEqual(['cx'])
    // Off by default, and a piece held by enough weak pairs is not hanging by a thread.
    expect(planBridgeRepair({ imageIds: ['a', 'b', 'c', 'x', 'y'], entries }).pairs).toEqual([])
    const held = [...entries, ok('b', 'y', 25), ok('c', 'y', 29), ok('b', 'x', 28)]
    expect(planBridgeRepair({ imageIds: ['a', 'b', 'c', 'x', 'y'], entries: held, opts })).toMatchObject({
      weakPieces: 0,
      pairs: [],
    })
  })

  it('matches a split piece against the whole main block and a weak one against its core', () => {
    // Main a–b–c with w–v hanging on c by a thread; a split piece x–y.
    const ids = ['a', 'b', 'c', 'w', 'v', 'x', 'y']
    const entries = [
      ok('a', 'b', 300),
      ok('b', 'c', 300),
      ok('w', 'v', 300),
      ok('c', 'w', 20),
      ok('x', 'y', 300),
      rejected('w', 'x', 30), // a split-piece pair into the weak piece: inside the main block
      rejected('v', 'a', 20),
      rejected('w', 'v', 40), // inside a piece: never
    ]
    const r = planBridgeRepair({ imageIds: ids, entries, opts: { weakInliers: 30, weakCut: 100 } })
    expect(r).toMatchObject({ components: 2, pieces: 1, weakPieces: 1, weakImages: 2 })
    expect(r.pairs.map((p) => p.idA + p.idB).sort()).toEqual(['va', 'wx'])
  })

  it('takes the core from the main block even when a detached piece is larger', () => {
    // Main block: a0–a3 (6 images, strong) joined to b0–b2 and c0–c2 (strong) by 20-inlier
    // pairs; a detached piece d0–d6 (7 images) larger than the core. b and c hang by a
    // thread on a, and the near miss a1–b1 is proposed; nothing points at d as a core.
    const chain = (p, n) => Array.from({ length: n - 1 }, (_, i) => ok(`${p}${i}`, `${p}${i + 1}`, 200))
    const ids = [
      ['a', 6],
      ['b', 3],
      ['c', 3],
      ['d', 7],
    ].flatMap(([p, n]) => Array.from({ length: n }, (_, i) => `${p}${i}`))
    const entries = [
      ...chain('a', 6),
      ...chain('b', 3),
      ...chain('c', 3),
      ...chain('d', 7),
      ok('a5', 'b0', 20),
      ok('a0', 'c0', 20),
      rejected('a1', 'b1', 40),
      rejected('a2', 'd0', 40),
    ]
    const r = planBridgeRepair({ imageIds: ids, entries, opts: { weakInliers: 30, weakCut: 100 } })
    expect(r).toMatchObject({ mainSize: 12, pieces: 1, weakPieces: 2, weakImages: 6 })
    expect(r.pairs.map((p) => `${p.idA}${p.idB}`)).toEqual(expect.arrayContaining(['a1b1', 'a2d0']))
  })

  it('leaves out pairs an earlier round tried', () => {
    const entries = [...base, rejected('a', 'x', 30), rejected('c', 'x', 12)]
    const r = planBridgeRepair({ imageIds, entries, tried: new Set([bridgeKey('x', 'a')]) })
    expect(r.pairs.map((p) => p.idA + p.idB)).toEqual(['cx'])
  })
})

describe('retryIsWorse', () => {
  const weak = { status: 'done', inlierCount: 20, weak: true }
  it('keeps a weak bridge over a rejection, a failure or a cancelled retry', () => {
    expect(retryIsWorse({ status: 'done', inlierCount: 0 }, weak)).toBe(true)
    expect(retryIsWorse({ status: 'error', inlierCount: 0 }, weak)).toBe(true)
    expect(retryIsWorse(undefined, weak)).toBe(true)
  })
  it('takes an accepted retry, and a weak one only with more inliers', () => {
    expect(retryIsWorse({ status: 'done', inlierCount: 45 }, weak)).toBe(false)
    expect(retryIsWorse({ status: 'done', inlierCount: 25, weak: true }, weak)).toBe(false)
    expect(retryIsWorse({ status: 'done', inlierCount: 15, weak: true }, weak)).toBe(true)
  })
  it('treats a gated or skipped retry as a rejection', () => {
    expect(retryIsWorse({ status: 'done', inlierCount: 0, gated: true }, weak)).toBe(true)
    expect(retryIsWorse({ status: 'done', inlierCount: 0, skipped: true }, { status: 'done', inlierCount: 0 })).toBe(
      false,
    )
  })
})
