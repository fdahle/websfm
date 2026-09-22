// Compact reconstruction-input match list. A large project can contain millions
// of [keypointA,keypointB] tuples; structured-cloning those nested arrays duplicates
// hundreds of MB before SfM even starts. Uint32PairList keeps the Array-like read
// surface used by the solver while storing exactly 8 bytes per match.

export class Uint32PairList {
  constructor(data) { this.data = data }
  get length() { return this.data.length >>> 1 }
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

export function packMatchPairs(matches) {
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
