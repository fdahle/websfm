// Sets and Maps past V8's per-collection cap. A Set or Map holds at most 2²⁴
// (16,777,216) entries and throws "RangeError: Set/Map maximum size exceeded" past it,
// whatever memory is free. A cloud of 25 M points voxel-downsampled at its own spacing
// has more occupied cells than that.
//
// bigSet(expected) / bigMap(expected) take an upper bound on the number of keys (a
// point count is one). Up to the cap they return a plain Set / Map, so the common case
// costs nothing. Past it the keys are spread by hash over enough plain shards that each
// one stays far below the cap. The shards answer has/get/set/add/delete/size and
// iteration like the plain collection. Numeric keys are hashed as numbers and never
// stringified; string keys get an FNV-1a hash.

export const COLLECTION_LIMIT = 2 ** 24

// 32-bit mix of a number (an integer up to 2⁵³, or any finite number: it only has to
// be deterministic). Its top bits pick the shard.
function hashNumber(k) {
  const lo = k | 0,
    hi = (k / 4294967296) | 0
  let h = Math.imul(lo ^ Math.imul(hi, 0x85ebca6b), 0x9e3779b1)
  h ^= h >>> 16
  return Math.imul(h, 0x2c1b3c6d)
}

function hashString(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  h ^= h >>> 16
  return Math.imul(h, 0x2c1b3c6d)
}

// Shards so that `expected` keys fill each to about half of `capacity`: a power of two.
function shardBits(expected, capacity) {
  let bits = 1
  while (expected / 2 ** bits > capacity / 2 && bits < 16) bits++
  return bits
}

class Sharded {
  constructor(Kind, bits) {
    this.shift = 32 - bits
    this.shards = Array.from({ length: 2 ** bits }, () => new Kind())
  }
  shardOf(k) {
    return this.shards[(typeof k === 'number' ? hashNumber(k) : hashString(String(k))) >>> this.shift]
  }
  has(k) {
    return this.shardOf(k).has(k)
  }
  delete(k) {
    return this.shardOf(k).delete(k)
  }
  clear() {
    for (const s of this.shards) s.clear()
  }
  get size() {
    let n = 0
    for (const s of this.shards) n += s.size
    return n
  }
  *keys() {
    for (const s of this.shards) yield* s.keys()
  }
  *values() {
    for (const s of this.shards) yield* s.values()
  }
  *entries() {
    for (const s of this.shards) yield* s.entries()
  }
  forEach(fn, thisArg) {
    for (const s of this.shards) s.forEach((v, k) => fn.call(thisArg, v, k, this))
  }
}

class ShardedSet extends Sharded {
  constructor(bits) {
    super(Set, bits)
  }
  add(k) {
    this.shardOf(k).add(k)
    return this
  }
  [Symbol.iterator]() {
    return this.keys()
  }
}

class ShardedMap extends Sharded {
  constructor(bits) {
    super(Map, bits)
  }
  get(k) {
    return this.shardOf(k).get(k)
  }
  set(k, v) {
    this.shardOf(k).set(k, v)
    return this
  }
  [Symbol.iterator]() {
    return this.entries()
  }
}

/** A Set for at most `expected` keys: a plain Set up to the cap, sharded past it.
 *  `capacity` (per shard) is for tests. */
export function bigSet(expected, { capacity = COLLECTION_LIMIT } = {}) {
  return expected <= capacity ? new Set() : new ShardedSet(shardBits(expected, capacity))
}

/** A Map for at most `expected` keys: a plain Map up to the cap, sharded past it. */
export function bigMap(expected, { capacity = COLLECTION_LIMIT } = {}) {
  return expected <= capacity ? new Map() : new ShardedMap(shardBits(expected, capacity))
}
