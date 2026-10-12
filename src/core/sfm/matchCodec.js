// Compact reconstruction-input match list. A large project can contain millions
// of [keypointA,keypointB] tuples; structured-cloning those nested arrays duplicates
// hundreds of MB before SfM even starts. Uint32PairList keeps the Array-like read
// surface used by the solver while storing exactly 8 bytes per match.

export class Uint32PairList {
  constructor(data) { this.data = data }
  get length() { return this.data.length >>> 1 }
  // Hot loops read the packed indices directly: no [a, b] array per match.
  a(i) { return this.data[2 * i] }
  b(i) { return this.data[2 * i + 1] }
  at(index) {
    const i = index < 0 ? this.length + index : index
    return i >= 0 && i < this.length ? [this.data[i * 2], this.data[i * 2 + 1]] : undefined
  }
  *[Symbol.iterator]() {
    for (let i = 0; i < this.data.length; i += 2) yield [this.data[i], this.data[i + 1]]
  }
  map(callback, thisArg) {
    const out = new Array(this.length)
    let i = 0
    for (const value of this) out[i] = callback.call(thisArg, value, i++, this)
    return out
  }
  filter(callback, thisArg) {
    const out = []
    let i = 0
    for (const value of this) if (callback.call(thisArg, value, i++, this)) out.push(value)
    return out
  }
}

// A pair's matches as a Uint32PairList: packed input is wrapped, a plain
// [[a, b], …] list (tests, older callers) is packed once.
export function asPairList(matches) {
  if (matches instanceof Uint32PairList) return matches
  if (matches instanceof Uint32Array) return new Uint32PairList(matches)
  if (matches?.data instanceof Uint32Array) return new Uint32PairList(matches.data)
  return new Uint32PairList(packMatchPairs(matches))
}

// A fresh flat [a0, b0, a1, b1, …] buffer: a copy of an already-flat Uint32Array (the
// store's own shape), or a packed [[a, b], …] list.
export function packMatchPairs(matches) {
  if (matches instanceof Uint32Array) return matches.slice()
  const data = new Uint32Array((matches?.length ?? 0) * 2)
  let i = 0
  for (const pair of (matches || [])) {
    data[i++] = pair[0]
    data[i++] = pair[1]
  }
  return data
}

export function wrapPackedMatches(pairs) {
  for (const pair of (pairs || [])) {
    if (pair.matches instanceof Uint32Array) pair.matches = new Uint32PairList(pair.matches)
    // structuredClone preserves the typed array but not the class prototype.
    else if (pair.matches?.data instanceof Uint32Array) pair.matches = new Uint32PairList(pair.matches.data)
  }
  return pairs
}

// A packed [ia0, ib0, ia1, ib1, …] match list with the two images' roles swapped:
// [ib0, ia0, ib1, ia1, …]. A new array; the input is not touched.
export function swapMatchRoles(matches) {
  const out = new Uint32Array(matches.length)
  for (let i = 0; i < matches.length; i += 2) { out[i] = matches[i + 1]; out[i + 1] = matches[i] }
  return out
}

// The fundamental matrix of the swapped pair: x_B·F·x_A = 0 ⇔ x_A·Fᵀ·x_B = 0.
// Row-major nested 3×3, as verify.js returns it.
export function transposeF(F) {
  return [0, 1, 2].map((r) => [0, 1, 2].map((c) => F[c][r]))
}
