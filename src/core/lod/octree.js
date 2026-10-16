// Level-of-detail octree for point clouds (dev/planning/plan-lod.md ▸ L1). Pure: no
// Vue, Pinia, OPFS or DOM; plain typed arrays in and out.
//
// The cube around the cloud is split recursively. A node holds a subsample of the
// points in its cube: per cell of a G³ grid over the node, the point nearest the
// cell's centre. The rest go to its children, so the root is a coarse overview of the
// whole cloud, the spacing halves per level, and every point lives in exactly one node
// (Potree 2 / COPC). A node with at most `leafMax` points keeps them all.
//
// Points are given as `pts = { pos: Float64Array(3n) (relative to the cube's min
// corner or any fixed origin), count }`; nodes refer to them by index. A node is
// { key: [level, x, y, z], idx: Uint32Array } with integer x, y, z in [0, 2^level).
//
// The out-of-core build (L2) splits a big cloud into chunk cubes at a fixed level,
// builds each chunk's subtree here (`buildSubtree`), then makes the levels above the
// chunks by lifting a subsample of their roots' points up (`liftLevels`), removing the
// lifted points from the nodes they came from.

export const GRID = 128          // cells per axis in a node's subsample grid
export const LEAF_MAX = 32768    // a node with at most this many points is a leaf
export const MAX_LEVEL = 24      // guard: never split below this

/** The cube of node `key` inside a root cube { min: [x,y,z], size }. */
export function nodeCube(root, [level, x, y, z]) {
  const size = root.size / 2 ** level
  return { min: [root.min[0] + x * size, root.min[1] + y * size, root.min[2] + z * size], size }
}

/** The cube around bounds { min, max }: their largest extent, from their min corner, a hair larger. */
export function rootCube(min, max) {
  const size = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) * (1 + 1e-9) || 1
  return { min: [...min], size }
}

export const keyString = ([l, x, y, z]) => `${l}-${x}-${y}-${z}`
export const childKey = ([l, x, y, z], o) => [l + 1, 2 * x + (o & 1), 2 * y + ((o >> 1) & 1), 2 * z + ((o >> 2) & 1)]

// An open-addressing table cell id → (best point, its squared distance to the cell
// centre). Sized for `n` insertions; reused across nodes of similar size.
function makeCellTable(n) {
  let cap = 16
  while (cap < 2 * n) cap <<= 1
  return { cap, keys: new Int32Array(cap).fill(-1), best: new Uint32Array(cap), dist: new Float64Array(cap), used: new Int32Array(Math.min(cap, n + 1)), nUsed: 0 }
}

/**
 * Grid-subsample the points `idx` inside `cube`: per occupied cell, the point nearest
 * the cell centre. → { picked: Uint32Array, rest: Uint32Array } (both in input order).
 */
export function subsample(pts, idx, cube, grid = GRID) {
  const n = idx.length
  const t = makeCellTable(n)
  const { pos } = pts
  const cs = cube.size / grid, [mx, my, mz] = cube.min
  const mask = t.cap - 1
  const cellOf = new Int32Array(n)
  for (let k = 0; k < n; k++) {
    const i = idx[k]
    const fx = (pos[3 * i] - mx) / cs, fy = (pos[3 * i + 1] - my) / cs, fz = (pos[3 * i + 2] - mz) / cs
    const cx = Math.min(grid - 1, Math.max(0, Math.floor(fx)))
    const cy = Math.min(grid - 1, Math.max(0, Math.floor(fy)))
    const cz = Math.min(grid - 1, Math.max(0, Math.floor(fz)))
    const cell = cx + grid * (cy + grid * cz)
    cellOf[k] = cell
    const dx = fx - cx - 0.5, dy = fy - cy - 0.5, dz = fz - cz - 0.5
    const d = dx * dx + dy * dy + dz * dz
    let h = Math.imul(cell, 0x9e3779b1) & mask
    while (t.keys[h] !== -1 && t.keys[h] !== cell) h = (h + 1) & mask
    if (t.keys[h] === -1) { t.keys[h] = cell; t.best[h] = k; t.dist[h] = d }
    else if (d < t.dist[h]) { t.best[h] = k; t.dist[h] = d }
  }
  const take = new Uint8Array(n)
  let np = 0
  for (let h = 0; h < t.cap; h++) if (t.keys[h] !== -1) { take[t.best[h]] = 1; np++ }
  const picked = new Uint32Array(np), rest = new Uint32Array(n - np)
  let a = 0, b = 0
  for (let k = 0; k < n; k++) (take[k] ? (picked[a++] = idx[k]) : (rest[b++] = idx[k]))
  return { picked, rest }
}

/** Split point indices by octant of `cube`. → Uint32Array[8] */
export function splitOctants(pts, idx, cube) {
  const { pos } = pts
  const half = cube.size / 2
  const cx = cube.min[0] + half, cy = cube.min[1] + half, cz = cube.min[2] + half
  const oct = new Uint8Array(idx.length), counts = new Int32Array(8)
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k]
    const o = (pos[3 * i] >= cx ? 1 : 0) | (pos[3 * i + 1] >= cy ? 2 : 0) | (pos[3 * i + 2] >= cz ? 4 : 0)
    oct[k] = o; counts[o]++
  }
  const out = Array.from({ length: 8 }, (_, o) => new Uint32Array(counts[o]))
  const fill = new Int32Array(8)
  for (let k = 0; k < idx.length; k++) out[oct[k]][fill[oct[k]]++] = idx[k]
  return out
}

/**
 * The subtree of the points `idx` in the node `key` (cube from `root`). → nodes
 * [{ key, idx }], parents before children. Empty children are left out.
 */
export function buildSubtree(pts, idx, root, key = [0, 0, 0, 0], opts = {}) {
  const { leafMax = LEAF_MAX, grid = GRID, maxLevel = MAX_LEVEL } = opts
  const nodes = []
  const stack = [[key, idx]]
  while (stack.length) {
    const [k, ix] = stack.pop()
    if (!ix.length) continue
    if (ix.length <= leafMax || k[0] >= maxLevel) { nodes.push({ key: k, idx: ix }); continue }
    const cube = nodeCube(root, k)
    const { picked, rest } = subsample(pts, ix, cube, grid)
    nodes.push({ key: k, idx: picked })
    const parts = splitOctants(pts, rest, cube)
    for (let o = 7; o >= 0; o--) if (parts[o].length) stack.push([childKey(k, o), parts[o]])
  }
  return nodes
}

/**
 * Make the levels above the chunk roots: every parent takes a grid subsample of its
 * children's points, and those points leave the children. `nodes` is a Map
 * keyString → { key, idx } of the chunk roots only (disjoint cubes, any levels, not
 * their descendants); the parents are added to it. A child the lift empties stays,
 * with no points: the caller drops it when it has no children of its own. Bottom-up,
 * one level at a time, so each lift only sees the level directly below.
 */
export function liftLevels(pts, nodes, root, opts = {}) {
  const { grid = GRID } = opts
  const lifted = new Uint8Array(pts.count) // marks, cleared after each parent
  let deepest = 0
  for (const n of nodes.values()) deepest = Math.max(deepest, n.key[0])
  for (let level = deepest; level > 0; level--) {
    // Children at `level`, grouped by parent.
    const byParent = new Map()
    for (const n of nodes.values()) {
      if (n.key[0] !== level) continue
      const pk = [level - 1, n.key[1] >> 1, n.key[2] >> 1, n.key[3] >> 1]
      const s = keyString(pk)
      if (!byParent.has(s)) byParent.set(s, { key: pk, children: [] })
      byParent.get(s).children.push(n)
    }
    for (const [s, { key, children }] of byParent) {
      let total = 0
      for (const c of children) total += c.idx.length
      const all = new Uint32Array(total)
      let o = 0
      for (const c of children) { all.set(c.idx, o); o += c.idx.length }
      const { picked } = subsample(pts, all, nodeCube(root, key), grid)
      for (const i of picked) lifted[i] = 1
      for (const c of children) c.idx = c.idx.filter((i) => !lifted[i])
      for (const i of picked) lifted[i] = 0
      const existing = nodes.get(s)
      if (existing) {
        const merged = new Uint32Array(existing.idx.length + picked.length)
        merged.set(existing.idx); merged.set(picked, existing.idx.length)
        existing.idx = merged
      } else nodes.set(s, { key, idx: picked })
    }
  }
  return nodes
}

/** Whether any child of `key` is in `nodes` (a Map keyString → node). */
export function hasChild(nodes, key) {
  for (let o = 0; o < 8; o++) if (nodes.has(keyString(childKey(key, o)))) return true
  return false
}

/**
 * The whole octree of an in-memory cloud, chunked at `chunkLevel` as the out-of-core
 * build does (0 = one chunk). → Map keyString → { key, idx }; a node the lift emptied
 * is kept only when it has children.
 */
export function buildOctree(pts, root, opts = {}) {
  const { chunkLevel = 0 } = opts
  const all = Uint32Array.from({ length: pts.count }, (_, i) => i)
  const nodes = new Map()
  if (chunkLevel === 0) {
    for (const n of buildSubtree(pts, all, root, [0, 0, 0, 0], opts)) nodes.set(keyString(n.key), n)
    return nodes
  }
  // Points into chunk cubes at chunkLevel, a subtree per chunk, then lift.
  const per = 2 ** chunkLevel, cs = root.size / per
  const chunks = new Map()
  for (let i = 0; i < pts.count; i++) {
    const cx = Math.min(per - 1, Math.floor((pts.pos[3 * i] - root.min[0]) / cs))
    const cy = Math.min(per - 1, Math.floor((pts.pos[3 * i + 1] - root.min[1]) / cs))
    const cz = Math.min(per - 1, Math.floor((pts.pos[3 * i + 2] - root.min[2]) / cs))
    const s = `${cx},${cy},${cz}`
    if (!chunks.has(s)) chunks.set(s, { key: [chunkLevel, cx, cy, cz], idx: [] })
    chunks.get(s).idx.push(i)
  }
  const roots = new Map()
  for (const { key, idx } of chunks.values()) {
    const sub = buildSubtree(pts, Uint32Array.from(idx), root, key, opts)
    roots.set(keyString(sub[0].key), sub[0]) // parents first: [0] is the chunk root
    for (const n of sub) nodes.set(keyString(n.key), n)
  }
  liftLevels(pts, roots, root, opts)
  for (const [s, n] of roots) nodes.set(s, n)
  for (const [s, n] of nodes) if (!n.idx.length && !hasChild(nodes, n.key)) nodes.delete(s)
  return nodes
}
