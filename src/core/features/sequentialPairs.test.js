import { describe, expect, it } from 'vitest'
import { sequentialPairs } from './sequentialPairs.js'

describe('sequentialPairs', () => {
  const ids = ['a', 'b', 'c', 'd', 'e']
  const keys = (pairs) => pairs.map(([a, b]) => [a, b].sort().join('--'))

  it('matches each item to the requested number of following frames', () => {
    expect(keys(sequentialPairs(ids, { overlap: 2 }))).toEqual([
      'a--b', 'a--c', 'b--c', 'b--d', 'c--d', 'c--e', 'd--e',
    ])
  })

  it('closes an orbit without emitting duplicate undirected pairs', () => {
    const result = keys(sequentialPairs(ids, { overlap: 2, loopClosure: true }))
    expect(result).toContain('a--e')
    expect(result).toContain('a--d')
    expect(new Set(result).size).toBe(result.length)
    expect(result).toHaveLength(10)
  })

  it('degrades to exhaustive when the overlap covers the sequence', () => {
    expect(sequentialPairs(ids, { overlap: 99 })).toHaveLength(10)
    expect(sequentialPairs(ids, { overlap: 99, loopClosure: true })).toHaveLength(10)
  })

  it('cuts a 128-image orbit to a bounded window instead of 8128 exhaustive pairs', () => {
    const orbit = Array.from({ length: 128 }, (_, i) => `image-${i}`)
    expect(sequentialPairs(orbit, { overlap: 10 })).toHaveLength(1225)
    expect(sequentialPairs(orbit, { overlap: 10, loopClosure: true })).toHaveLength(1280)
  })

  it('handles empty and singleton inputs', () => {
    expect(sequentialPairs([])).toEqual([])
    expect(sequentialPairs(['a'])).toEqual([])
  })
})
