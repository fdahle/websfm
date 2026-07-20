import { describe, it, expect } from 'vitest'
import { graphHealth, bridgeEdges, completedMatchGraphHealth } from './matchGraph.js'

describe('completedMatchGraphHealth', () => {
  it('returns missing before matching has produced a terminal result', () => {
    expect(completedMatchGraphHealth([], ['a', 'b'])).toBeNull()
    expect(completedMatchGraphHealth([{ status: 'running' }], ['a', 'b'])).toBeNull()
  })

  it('reports a genuinely empty accepted graph after matching completes', () => {
    const h = completedMatchGraphHealth([
      { idA: 'a', idB: 'b', status: 'done', inlierCount: 0 },
    ], ['a', 'b'])
    expect(h.components).toHaveLength(2)
    expect(h.isolated).toEqual(['a', 'b'])
  })
})

describe('graphHealth', () => {
  it('finds two components and excludes weak/disabled edges', () => {
    const ids = ['a', 'b', 'c', 'd', 'e']
    const pairs = [
      { idA: 'a', idB: 'b', inlierCount: 100 },
      { idA: 'b', idB: 'c', inlierCount: 80 },
      { idA: 'd', idB: 'e', inlierCount: 50 },
      { idA: 'a', idB: 'e', inlierCount: 5, weak: true },      // weak — must NOT join
      { idA: 'c', idB: 'd', inlierCount: 40, disabled: true }, // disabled — must NOT join
    ]
    const h = graphHealth(pairs, ids)
    expect(h.components).toHaveLength(2)
    expect(h.components[0].sort()).toEqual(['a', 'b', 'c']) // largest first
    expect(new Set(h.components[1])).toEqual(new Set(['d', 'e']))
    expect(h.degrees.get('b')).toBe(2)
    expect(h.degrees.get('a')).toBe(1) // weak edge to e not counted
    expect(h.isolated).toEqual([])
  })

  it('reports isolated images (no accepted edge)', () => {
    const ids = ['a', 'b', 'lonely']
    const pairs = [{ idA: 'a', idB: 'b', inlierCount: 100 }]
    const h = graphHealth(pairs, ids)
    expect(h.isolated).toEqual(['lonely'])
    expect(h.weaklyConnected.map((w) => w.id).sort()).toEqual(['a', 'b']) // degree 1 < 2
  })

  it('handles an empty graph', () => {
    const h = graphHealth([], ['a', 'b'])
    expect(h.components).toHaveLength(2) // each singleton is its own component
    expect(h.isolated.sort()).toEqual(['a', 'b'])
  })

  it('exposes component membership index (0 = largest)', () => {
    const ids = ['a', 'b', 'c', 'd', 'e']
    const pairs = [
      { idA: 'a', idB: 'b', inlierCount: 100 },
      { idA: 'b', idB: 'c', inlierCount: 80 },
      { idA: 'd', idB: 'e', inlierCount: 50 },
    ]
    const h = graphHealth(pairs, ids)
    expect(h.componentIndex.get('a')).toBe(0)
    expect(h.componentIndex.get('d')).toBe(1)
  })
})

describe('bridgeEdges', () => {
  it('finds the single bridge joining two clusters', () => {
    // Two triangles a-b-c and d-e-f, joined only by the c-d edge.
    const ids = ['a', 'b', 'c', 'd', 'e', 'f']
    const pairs = [
      { idA: 'a', idB: 'b', inlierCount: 100 },
      { idA: 'b', idB: 'c', inlierCount: 90 },
      { idA: 'a', idB: 'c', inlierCount: 80 },
      { idA: 'c', idB: 'd', inlierCount: 12 },  // the only link between clusters
      { idA: 'd', idB: 'e', inlierCount: 70 },
      { idA: 'e', idB: 'f', inlierCount: 60 },
      { idA: 'd', idB: 'f', inlierCount: 50 },
    ]
    const b = bridgeEdges(pairs, ids)
    expect(b).toHaveLength(1)
    const set = new Set([b[0].idA, b[0].idB])
    expect(set).toEqual(new Set(['c', 'd']))
    expect(b[0].inlierCount).toBe(12)
  })

  it('a fully cyclic graph has no bridges', () => {
    const ids = ['a', 'b', 'c']
    const pairs = [
      { idA: 'a', idB: 'b', inlierCount: 10 },
      { idA: 'b', idB: 'c', inlierCount: 10 },
      { idA: 'a', idB: 'c', inlierCount: 10 },
    ]
    expect(bridgeEdges(pairs, ids)).toEqual([])
  })

  it('a path graph is all bridges, weakest first', () => {
    const ids = ['a', 'b', 'c']
    const pairs = [
      { idA: 'a', idB: 'b', inlierCount: 30 },
      { idA: 'b', idB: 'c', inlierCount: 10 },
    ]
    const b = bridgeEdges(pairs, ids)
    expect(b).toHaveLength(2)
    expect(b[0].inlierCount).toBe(10) // sorted ascending
  })

  it('excludes weak/disabled edges', () => {
    const ids = ['a', 'b', 'c']
    const pairs = [
      { idA: 'a', idB: 'b', inlierCount: 30 },
      { idA: 'b', idB: 'c', inlierCount: 10, weak: true },
    ]
    const b = bridgeEdges(pairs, ids)
    expect(b).toHaveLength(1)
    expect(new Set([b[0].idA, b[0].idB])).toEqual(new Set(['a', 'b']))
  })
})
