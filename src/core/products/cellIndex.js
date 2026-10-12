// Packed voxel-cell key → int value, in typed arrays (open addressing, linear probing,
// grows at half load). It exists because a JS Map stops at 2^24 entries ("Map maximum
// size exceeded") and keeps every entry on the V8 heap: a dense cloud of 29 M points
// indexed per merge cell is past both (the fusion accumulator hit the same wall).
//
// Keys are the non-negative, float64-exact packed cell numbers of mesh.js `cellKey`
// (`(dix·ny + diy)·nz + diz`, < 2^53); -1 marks an empty slot. Values are int32.
const EMPTY = -1

function hashOf(key, mask) {
  const lo = key % 4294967296, hi = (key - lo) / 4294967296
  return (Math.imul(lo | 0, 0x9e3779b1) ^ Math.imul(hi | 0, 0x85ebca77)) & mask
}

export function createCellIndex(capacityHint = 1024) {
  let cap = 1024
  while (cap < 2 * capacityHint) cap *= 2
  let keys = new Float64Array(cap).fill(EMPTY)
  let vals = new Int32Array(cap)
  let size = 0

  function slotOf(key) {
    const mask = cap - 1
    let s = hashOf(key, mask)
    while (keys[s] !== EMPTY && keys[s] !== key) s = (s + 1) & mask
    return s
  }
  function grow() {
    const oldKeys = keys, oldVals = vals
    cap *= 2
    keys = new Float64Array(cap).fill(EMPTY)
    vals = new Int32Array(cap)
    for (let i = 0; i < oldKeys.length; i++) {
      if (oldKeys[i] === EMPTY) continue
      const s = slotOf(oldKeys[i])
      keys[s] = oldKeys[i]; vals[s] = oldVals[i]
    }
  }
  return {
    get size() { return size },
    // Insert or overwrite.
    set(key, value) {
      let s = slotOf(key)
      if (keys[s] === EMPTY) {
        if (2 * (size + 1) > cap) { grow(); s = slotOf(key) }
        keys[s] = key; size++
      }
      vals[s] = value
    },
    // Overwrite only when the key is present (a fixed key set filled by a stream).
    update(key, value) {
      const s = slotOf(key)
      if (keys[s] === EMPTY) return false
      vals[s] = value
      return true
    },
    // The value, or `missing` when absent.
    get(key, missing = undefined) {
      const s = slotOf(key)
      return keys[s] === EMPTY ? missing : vals[s]
    },
  }
}
