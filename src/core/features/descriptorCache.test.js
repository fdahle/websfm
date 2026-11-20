import { expect, it } from 'vitest'
import { createDescriptorCache } from './descriptorCache.js'

const img = (uuid) => ({ uuid })
const desc = (n) => new Float32Array(n)
const settle = () => new Promise((r) => setTimeout(r, 0))

// Run the pairs one at a time through the cache as matchAll does (load on a miss, then
// release both images) and count the loads.
async function drive(pairs, budgetBytes, bytesEach = 16) {
  const cache = createDescriptorCache({ pairs, budgetBytes })
  for (const [a, b] of pairs) {
    for (const u of [a.uuid, b.uuid]) {
      if (cache.has(u)) cache.get(u)
      else cache.set(u, Promise.resolve(desc(bytesEach / 4)))
    }
    await settle()
    cache.release(a.uuid)
    cache.release(b.uuid)
  }
  return cache.stats()
}

const exhaustive = (n) => {
  const ims = Array.from({ length: n }, (_, i) => img(`i${i}`))
  const pairs = []
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pairs.push([ims[i], ims[j]])
  return pairs
}

it('drops an image after its last pair', async () => {
  const a = img('a'),
    b = img('b'),
    c = img('c')
  const cache = createDescriptorCache({
    pairs: [
      [a, b],
      [a, c],
    ],
  })
  cache.set('a', Promise.resolve(desc(4)))
  cache.set('b', Promise.resolve(desc(4)))
  await settle()
  cache.release('a')
  cache.release('b')
  expect(cache.has('a')).toBe(true) // a still has the (a, c) pair
  expect(cache.has('b')).toBe(false) // b is done
  cache.release('a')
  expect(cache.has('a')).toBe(false)
  expect(cache.stats().residentBytes).toBe(0)
})

it('evicts the entry used furthest ahead, where least recently used would cost a load more', async () => {
  // Two rows of an exhaustive sweep, room for three images. At (x, c) the cache holds
  // x, a, b: a is next needed at (y, a), b only at (y, b), so b goes (least recently
  // used would drop a, then a and b both come back). Loads: x a b c y b = 6 (LRU: 7).
  const [x, y, a, b, c] = ['x', 'y', 'a', 'b', 'c'].map(img)
  const pairs = [
    [x, a],
    [x, b],
    [x, c],
    [y, a],
    [y, b],
    [y, c],
  ]
  const s = await drive(pairs, 3 * 16)
  expect(s.loads).toBe(6)
  expect(s.peakBytes).toBeLessThanOrEqual(4 * 16) // over by the one that just landed
})

it('loads each image once when the budget holds the block, and the minimum when it holds two', async () => {
  const pairs = exhaustive(12)
  expect((await drive(pairs, 12 * 16)).loads).toBe(12)
  // Room for two, the least a pair needs: its first pair loads 2, each next pair in a
  // row 1 (the row's image kept), each new row 2 but the last ((10, 11) finds 11 from
  // (9, 11)): 2 + 65 + 9 = 76, the fewest any rule could do with two slots.
  expect((await drive(pairs, 2 * 16)).loads).toBe(76)
})

it('a sweep that outgrows the budget reloads far less than least recently used would', async () => {
  // 12 images, room for 6: LRU reloads the row's partners every row once the tail of
  // the row is larger than the cache (a cyclic access pattern); Belady keeps a fixed
  // part of the tail. Counted by an independent LRU model for the same drive.
  const pairs = exhaustive(12)
  const belady = (await drive(pairs, 6 * 16)).loads
  const lru = (() => {
    const resident = [] // LRU first
    const left = new Map()
    for (const [a, b] of pairs) for (const u of [a.uuid, b.uuid]) left.set(u, (left.get(u) ?? 0) + 1)
    let loads = 0
    for (const [a, b] of pairs) {
      for (const u of [a.uuid, b.uuid]) {
        const k = resident.indexOf(u)
        if (k >= 0) resident.splice(k, 1)
        else loads++
        resident.push(u)
        while (resident.length > 6) resident.shift()
      }
      for (const u of [a.uuid, b.uuid]) {
        left.set(u, left.get(u) - 1)
        if (!left.get(u)) resident.splice(resident.indexOf(u), 1)
      }
    }
    return loads
  })()
  expect(belady).toBeLessThan(lru)
  expect(belady).toBeGreaterThanOrEqual(12) // every image at least once
})

it('keeps derived entries (gate samples) over full descriptors, and releases them with their image', async () => {
  const [a, b, c] = ['a', 'b', 'c'].map(img)
  const cache = createDescriptorCache({
    pairs: [
      [a, b],
      [b, c],
      [a, c],
    ],
    budgetBytes: 40,
  })
  cache.set('a@gate', Promise.resolve(desc(2)), { owner: 'a' }) // 8 bytes, a used last
  cache.set('b', Promise.resolve(desc(4))) // 16
  cache.set('c', Promise.resolve(desc(4))) // 16
  await settle()
  expect(cache.stats().residentBytes).toBe(40)
  cache.set('d', Promise.resolve(desc(1))) // not in the pair list: used never, goes first
  await settle()
  expect(cache.has('d')).toBe(false)
  cache.set('c2', Promise.resolve(desc(4)), { owner: 'c' }) // derived, 16: over by 16
  await settle()
  // A full set goes before any derived entry, even one whose image is needed sooner.
  expect(cache.has('a@gate')).toBe(true)
  expect(cache.has('c2')).toBe(true)
  expect(cache.has('b') && cache.has('c')).toBe(false)
  expect(cache.stats().loads).toBe(3) // b, c, d: derived entries are not loads
  cache.release('a')
  cache.release('a')
  expect(cache.has('a@gate')).toBe(false)
})

it('never evicts an entry still loading', async () => {
  const cache = createDescriptorCache({ budgetBytes: 2 * 16 })
  cache.set('a', Promise.resolve(desc(4)))
  let finish
  cache.set(
    'loading',
    new Promise((r) => {
      finish = r
    }),
  )
  cache.set('b', Promise.resolve(desc(4)))
  cache.set('c', Promise.resolve(desc(4)))
  await settle()
  expect(cache.has('loading')).toBe(true)
  expect(cache.stats().residentBytes).toBeLessThanOrEqual(2 * 16)
  finish(desc(4))
  await settle()
  expect(cache.stats().residentBytes).toBeLessThanOrEqual(2 * 16)
})
