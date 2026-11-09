// Packed voxel-cell key → int value, in typed arrays (open addressing, linear probing,
// grows at half load). It exists because a JS Map stops at 2^24 entries ("Map maximum
// size exceeded") and keeps every entry on the V8 heap: a dense cloud of 29 M points
// indexed per merge cell is past both (the fusion accumulator hit the same wall).
//
// Keys are the non-negative, float64-exact packed cell numbers of mesh.js `cellKey`
// (`(dix·ny + diy)·nz + diz`, < 2^53); -1 marks an empty slot. Values are int32. The
// keys are filled through fillArray: Chrome leaves a 2^28-slot Float64Array unfilled,
// and with no empty slot the probe loop never ends.
import { fillArray } from '../bigArray.js'

const EMPTY = -1

// A 32-bit hash of a non-negative integer key below 2^53 in which every bit of the key
// moves the low bits, the ones a power-of-two table keeps (murmur3's finaliser). A plain
// `key × odd constant` keeps only the key's own low bits there: packed cells a multiple
// of 2^k apart (a grid whose ny·nz has 2^k in it) then land in a few slots, and linear
// probing walks one run for every insert (2^16 apart: twice the keys took four times as
// long).
export function mixKey(key) {
  const lo = key % 4294967296,
    hi = (key - lo) / 4294967296
  let h = lo ^ Math.imul(hi, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}

export function createCellIndex(capacityHint = 1024) {
  let cap = 1024
  while (cap < 2 * capacityHint) cap *= 2
  let keys = fillArray(new Float64Array(cap), EMPTY)
  let vals = new Int32Array(cap)
  let size = 0

  function slotOf(key) {
    const mask = cap - 1
    // Eight consecutive keys (neighbours along z) share one 64-byte line of `keys`;
    // the rest of the key is mixed. Faster than mixing it all on a cloud's cells.
    const q = Math.floor(key / 8)
    let s = (((mixKey(q) << 3) | (key - 8 * q)) >>> 0) & mask
    while (keys[s] !== EMPTY && keys[s] !== key) s = (s + 1) & mask
    return s
  }
  function grow() {
    const oldKeys = keys,
      oldVals = vals
    cap *= 2
    keys = fillArray(new Float64Array(cap), EMPTY)
    vals = new Int32Array(cap)
    for (let i = 0; i < oldKeys.length; i++) {
      if (oldKeys[i] === EMPTY) continue
      const s = slotOf(oldKeys[i])
      keys[s] = oldKeys[i]
      vals[s] = oldVals[i]
    }
  }
  return {
    get size() {
      return size
    },
    // Insert or overwrite.
    set(key, value) {
      let s = slotOf(key)
      if (keys[s] === EMPTY) {
        if (2 * (size + 1) > cap) {
          grow()
          s = slotOf(key)
        }
        keys[s] = key
        size++
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
