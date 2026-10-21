import { describe, it, expect } from 'vitest'
import { bigSet, bigMap, COLLECTION_LIMIT } from './bigCollections.js'

describe('bigSet / bigMap', () => {
  it('are plain collections up to the cap', () => {
    expect(bigSet(1000)).toBeInstanceOf(Set)
    expect(bigMap(COLLECTION_LIMIT)).toBeInstanceOf(Map)
    expect(bigSet(COLLECTION_LIMIT + 1)).not.toBeInstanceOf(Set)
  })

  it('shard numeric keys so that no shard nears its capacity', () => {
    const capacity = 256,
      n = 10_000
    const s = bigSet(n, { capacity })
    // Packed cell ids: consecutive runs and large strides, as a voxel grid makes them.
    const keys = []
    for (let i = 0; i < n; i++) keys.push(i % 2 ? i : i * 4_294_967_311 + 1_000_003)
    for (const k of keys) s.add(k)
    for (const k of keys) s.add(k) // duplicates are not counted twice
    expect(s.size).toBe(n)
    for (const k of keys) expect(s.has(k)).toBe(true)
    expect(s.has(-1)).toBe(false)
    expect(s.has(String(keys[1]))).toBe(false) // '1' is not 1
    expect(Math.max(...s.shards.map((x) => x.size))).toBeLessThan(capacity)
    expect([...s].sort((a, b) => a - b)).toEqual([...keys].sort((a, b) => a - b))
  })

  it('shard a Map and string keys alike', () => {
    const capacity = 64,
      n = 3000
    const m = bigMap(n, { capacity })
    for (let i = 0; i < n; i++) m.set(`${i},${-i},${i * 3}`, i)
    expect(m.size).toBe(n)
    for (let i = 0; i < n; i += 7) expect(m.get(`${i},${-i},${i * 3}`)).toBe(i)
    expect(m.get('nope')).toBeUndefined()
    expect(Math.max(...m.shards.map((x) => x.size))).toBeLessThan(capacity)
    m.delete('0,0,0')
    expect(m.has('0,0,0')).toBe(false)
    expect(m.size).toBe(n - 1)
    let seen = 0
    m.forEach(() => {
      seen++
    })
    expect(seen).toBe(n - 1)
  })
})
