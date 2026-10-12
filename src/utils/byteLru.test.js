import { describe, expect, it } from 'vitest'
import { createByteLru } from './byteLru.js'

describe('byte-bounded LRU', () => {
  it('evicts the least recently used clean entries past the budget', () => {
    const lru = createByteLru({ budgetBytes: 100 })
    lru.set('a', 'A', 40); lru.set('b', 'B', 40)
    expect(lru.get('a')).toBe('A') // a is now the most recent
    lru.set('c', 'C', 40)          // 120 > 100: b goes, not a
    expect(lru.has('b')).toBe(false)
    expect([lru.peek('a'), lru.peek('c')]).toEqual(['A', 'C'])
    expect(lru.stats()).toMatchObject({ entries: 2, bytes: 80, evictions: 1, peakBytes: 120 })
  })

  it('never evicts a pinned entry, and lets it go once unpinned with the same value', () => {
    const lru = createByteLru({ budgetBytes: 50 })
    lru.set('fresh', 'F', 40, { pinned: true })
    lru.set('x', 'X', 40) // over budget: only x is evictable
    expect(lru.has('fresh')).toBe(true)
    expect(lru.has('x')).toBe(false)
    expect(lru.stats()).toMatchObject({ pinned: 1, pinnedBytes: 40 })
    expect(lru.unpin('fresh', 'stale value')).toBe(false) // a replaced value stays pinned
    expect(lru.isPinned('fresh')).toBe(true)
    expect(lru.unpin('fresh', 'F')).toBe(true)
    lru.set('y', 'Y', 40) // now fresh is the LRU clean entry
    expect(lru.has('fresh')).toBe(false)
  })

  it('replaces, deletes and clears with exact byte accounting', () => {
    const lru = createByteLru({ budgetBytes: 1000 })
    lru.set('a', 1, 10); lru.set('a', 2, 30)
    expect(lru.stats().bytes).toBe(30)
    lru.set('b', 3, 5)
    expect(lru.delete('a')).toBe(true)
    expect(lru.stats().bytes).toBe(5)
    lru.clear()
    expect(lru.stats()).toMatchObject({ entries: 0, bytes: 0 })
    expect(lru.get('b')).toBeUndefined()
  })
})
