import { describe, it, expect } from 'vitest'
import { createCellIndex, mixKey } from './cellIndex.js'

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

  // Packed cells (x·ny + y)·nz + z with ny·nz a multiple of 2^k sit 2^k apart along x.
  // A hash that keeps the key's own low bits puts them in a few slots of a power-of-two
  // table (each insert then probes one long run); every key bit must reach the slot.
  it('spreads keys a power of two apart over the slots', () => {
    for (const k of [10, 16, 20, 32]) {
      const mask = 2 ** 18 - 1,
        n = 2 ** 16
      const used = new Set()
      for (let i = 0; i < n; i++) used.add(mixKey(i * 2 ** k + 7) & mask)
      // n random keys over 2^18 slots fill ≈ 2^18·(1 − e^(−1/4)) ≈ 0.885 n of them.
      expect(used.size).toBeGreaterThan(0.85 * n)
    }
  })

  it('stores and finds such keys through growth', () => {
    // The slot spread above is what keeps this linear (the low-bits hash took ~9 s here);
    // no clock in the test, so a loaded machine cannot fail it.
    const idx = createCellIndex(1024)
    for (let i = 0; i < 2 ** 17; i++) idx.set(i * 2 ** 16, i)
    expect(idx.size).toBe(2 ** 17)
    for (let i = 0; i < 2 ** 17; i += 97) expect(idx.get(i * 2 ** 16)).toBe(i)
    expect(idx.get(2 ** 16 + 1, -1)).toBe(-1)
  })
})
