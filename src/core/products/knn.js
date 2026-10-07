// Nearest-neighbour queries over a flat point cloud — the ONE index behind normal
// estimation, cloud-to-cloud distance and ICP. Pure, no Vue/Pinia/OPFS/DOM.
//
// A static k-d tree, not a uniform grid. The outlier filters' grid
// (core/products/cloudEdit.js `buildSpatialGrid`) answers "who is near me" for a
// point OF the cloud; these tools also query points that are far from it — another
// epoch's cloud, a flyer, the unaligned start of an ICP — and a grid shell-walk
// costs the volume it crosses, while the tree costs O(log n) wherever the query is.
//
// Layout is implicit and typed-array only (dense-scale rule: never an object per
// point): a permutation of point indices, and per tree node a split axis + value in
// heap order. A node owns perm[lo, hi) with its split at the range midpoint, so the
// ranges are recomputed during descent and never stored.
//
// Distances are computed in double precision relative to the query, so survey
// coordinates (~1e6) lose nothing even from a Float32 position buffer.

const LEAF = 12

/**
 * Build a k-NN index over `cloud` ({ count, pos }).
 * @returns {{ pos, tpos:Float64Array, count, perm:Int32Array, axis:Uint8Array, split:Float64Array }}
 */
export function buildKnnIndex(cloud) {
  const count = cloud.count ?? Math.floor(cloud.pos.length / 3)
  const { pos } = cloud
  const perm = new Int32Array(count)
  for (let i = 0; i < count; i++) perm[i] = i
  // Node count of a midpoint-split tree with leaves ≤ LEAF: < 2·count/LEAF·2.
  let depth = 0
  while ((count >> depth) > LEAF) depth++
  const nodes = (1 << (depth + 1)) - 1
  const axis = new Uint8Array(Math.max(1, nodes)).fill(255) // 255 = leaf
  const split = new Float64Array(Math.max(1, nodes))

  // Iterative build: [node, lo, hi] stack. Split axis = widest extent of the range
  // (a cycled axis degenerates on the flat clouds aerial surveys produce).
  const stack = [0, 0, count]
  while (stack.length) {
    const hi = stack.pop(), lo = stack.pop(), node = stack.pop()
    if (hi - lo <= LEAF || node >= nodes) continue
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
    for (let s = lo; s < hi; s++) {
      const p = perm[s] * 3
      const x = pos[p], y = pos[p + 1], z = pos[p + 2]
      if (x < minX) minX = x; if (x > maxX) maxX = x
      if (y < minY) minY = y; if (y > maxY) maxY = y
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
    }
    const ex = maxX - minX, ey = maxY - minY, ez = maxZ - minZ
    const a = ex >= ey && ex >= ez ? 0 : (ey >= ez ? 1 : 2)
    const mid = (lo + hi) >> 1
    select(perm, pos, a, lo, hi - 1, mid)
    axis[node] = a
    split[node] = pos[perm[mid] * 3 + a]
    stack.push(2 * node + 1, lo, mid, 2 * node + 2, mid, hi)
  }
  // Positions copied in tree order: a leaf scan then reads one contiguous run
  // instead of chasing perm[] across the whole buffer (24 B/point while the index
  // lives, for markedly faster queries on multi-million clouds).
  const tpos = new Float64Array(count * 3)
  for (let s = 0; s < count; s++) {
    const p = perm[s] * 3
    tpos[s * 3] = pos[p]; tpos[s * 3 + 1] = pos[p + 1]; tpos[s * 3 + 2] = pos[p + 2]
  }
  return { pos, tpos, count, perm, axis, split }
}

// Hoare-partition quickselect: put the element of rank k (by coordinate `a`) at
// perm[k], smaller-or-equal to its left, greater-or-equal to its right.
function select(perm, pos, a, lo, hi, k) {
  while (hi > lo) {
    const pivot = pos[perm[(lo + hi) >> 1] * 3 + a]
    let i = lo, j = hi
    while (i <= j) {
      while (pos[perm[i] * 3 + a] < pivot) i++
      while (pos[perm[j] * 3 + a] > pivot) j--
      if (i <= j) { const t = perm[i]; perm[i] = perm[j]; perm[j] = t; i++; j-- }
    }
    if (k <= j) hi = j
    else if (k >= i) lo = i
    else return
  }
}

// Reused descent stack (node, lo, hi, boundD2) — queries are synchronous, so one
// module-level buffer serves every call without per-query allocation. 64 levels ×
// 2 pending entries × 4 fields covers any count a typed array can index.
let stackBuf = new Float64Array(8 * 64)

/**
 * The k nearest indexed points to (x, y, z), within `maxD2` (squared distance).
 * Writes up to k results into `outIdx`/`outD2` in ascending squared distance and
 * returns how many were found. `exclude` skips one index — the query point itself
 * when a cloud is queried against its own index.
 */
export function knnQuery(index, x, y, z, k, outIdx, outD2, exclude = -1, maxD2 = Infinity) {
  const { tpos, perm, axis, split, count } = index
  if (!count || k <= 0) return 0
  let found = 0
  let worst = maxD2
  const st = stackBuf
  const nodes = axis.length
  let sp = 0
  st[sp++] = 0; st[sp++] = 0; st[sp++] = count; st[sp++] = 0
  while (sp) {
    const bound = st[--sp], hi = st[--sp], lo = st[--sp], node = st[--sp]
    if (bound >= worst) continue
    const a = node < nodes ? axis[node] : 255
    if (a === 255) {
      for (let s = lo; s < hi; s++) {
        const j = perm[s]
        if (j === exclude) continue
        const dx = tpos[s * 3] - x, dy = tpos[s * 3 + 1] - y, dz = tpos[s * 3 + 2] - z
        const d2 = dx * dx + dy * dy + dz * dz
        if (d2 >= worst) continue
        // Insertion into a sorted bounded list — k is small, so this beats a heap.
        let p = found < k ? found++ : k - 1
        while (p > 0 && outD2[p - 1] > d2) { outD2[p] = outD2[p - 1]; outIdx[p] = outIdx[p - 1]; p-- }
        outD2[p] = d2; outIdx[p] = j
        if (found === k && outD2[k - 1] < worst) worst = outD2[k - 1]
      }
      continue
    }
    const mid = (lo + hi) >> 1
    const d = (a === 0 ? x : (a === 1 ? y : z)) - split[node]
    const far = d * d > bound ? d * d : bound
    // Far child first onto the stack so the near child is popped (searched) first.
    if (d < 0) {
      st[sp++] = 2 * node + 2; st[sp++] = mid; st[sp++] = hi; st[sp++] = far
      st[sp++] = 2 * node + 1; st[sp++] = lo; st[sp++] = mid; st[sp++] = bound
    } else {
      st[sp++] = 2 * node + 1; st[sp++] = lo; st[sp++] = mid; st[sp++] = far
      st[sp++] = 2 * node + 2; st[sp++] = mid; st[sp++] = hi; st[sp++] = bound
    }
  }
  return found
}

/**
 * Nearest indexed point for every point of `query` ({ count, pos }), optionally
 * only within `maxDist`.
 * @returns {{ index: Int32Array, dist: Float64Array }} — −1 / NaN where nothing was
 *   within reach (or the index is empty).
 */
export function nearestNeighbors(index, query, { maxDist = Infinity, onProgress } = {}) {
  const n = query.count ?? Math.floor(query.pos.length / 3)
  const outIdx = new Int32Array(n).fill(-1)
  const dist = new Float64Array(n).fill(NaN)
  if (!index.count) return { index: outIdx, dist }
  const maxD2 = Number.isFinite(maxDist) ? maxDist * maxDist : Infinity
  const qi = new Int32Array(1), qd = new Float64Array(1)
  const { pos } = query
  const tick = Math.max(1, Math.floor(n / 50))
  for (let i = 0; i < n; i++) {
    if (knnQuery(index, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], 1, qi, qd, -1, maxD2)) {
      outIdx[i] = qi[0]
      dist[i] = Math.sqrt(qd[0])
    }
    if (onProgress && i % tick === 0) onProgress(i / n)
  }
  return { index: outIdx, dist }
}
