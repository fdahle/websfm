// The finished slabs of a fusion run joined into one dense cloud, in slab order (so a
// run is deterministic for a given plan). Pure.
//
// The cloud goes into shared memory where the page is cross-origin isolated
// (core/bigArray.js sharedArrays, from LOCAL_MIN_BYTES): a worker that later reads it
// (the level-of-detail octree, Build Mesh, the orthophoto) is handed a view, not a copy of
// the whole cloud, and it stays out of the tab's ArrayBuffer pool. Elsewhere it is plain
// arrays, as before.
import { sharedArrays } from '../bigArray.js'

// parts: [{ count, pos: Float32Array(3n), col: Uint8Array(3n), nrm: Float32Array(3n) }]
// → { count, pos, col, nrm }. A single part is returned as it is. Each part is dropped
// from `parts` once copied, so it can be collected while the rest are joined.
export function joinCloudParts(parts) {
  if (parts.length === 1) return parts[0]
  const n = parts.reduce((s, p) => s + p.count, 0)
  const [pos, col, nrm] = sharedArrays([
    [Float32Array, 3 * n],
    [Uint8Array, 3 * n],
    [Float32Array, 3 * n],
  ])
  let o = 0
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    pos.set(p.pos.subarray(0, 3 * p.count), 3 * o)
    col.set(p.col.subarray(0, 3 * p.count), 3 * o)
    nrm.set(p.nrm.subarray(0, 3 * p.count), 3 * o)
    o += p.count
    parts[i] = null
  }
  return { count: n, pos, col, nrm }
}
