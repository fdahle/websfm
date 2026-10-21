import { describe, it, expect } from 'vitest'
import { createCellIndex } from './cellIndex.js'

describe('createCellIndex', () => {
  it('stores, overwrites and misses like a Map, through growth', () => {
    const idx = createCellIndex(4)
    const ref = new Map()
    // Keys spread over 2^50 (float64-exact packed cells), many collisions on the low bits.
    for (let i = 0; i < 20000; i++) {
      const key = (i % 7000) * 2 ** 32 + (i % 13) * 4096 + (i % 5)
      idx.set(key, i)
      ref.set(key, i)
    }
    expect(idx.size).toBe(ref.size)
    for (const [k, v] of ref) expect(idx.get(k)).toBe(v)
    expect(idx.get(2 ** 50 + 1, -7)).toBe(-7)
  })

  it('update only touches present keys', () => {
    const idx = createCellIndex()
    idx.set(42, -1)
    expect(idx.update(42, 9)).toBe(true)
    expect(idx.update(43, 9)).toBe(false)
    expect(idx.get(42)).toBe(9)
    expect(idx.get(43, -1)).toBe(-1)
    expect(idx.size).toBe(1)
  })
})
