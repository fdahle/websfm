// Screened Poisson in tiles, for a scene too large for one solve's heap (plan D5,
// dev/planning/plan-dense-past-one-tab.md). Pure: plain arrays in and out.
//
// Every tile is solved on the scene's own leaf grid (crates/mesh `build_on_grid`, the
// grid the untiled solve would use: poissonGrid), so marching cubes puts each tile's
// vertices on the same lattice edges. A tile solves its core plus an overlap and keeps
// the triangles whose centroid's cell lies in its core: every lattice cell belongs to
// one tile. Across a seam, the two tiles' vertices on a shared lattice edge are the same
// edge, found exactly from the position (two coordinates on the lattice), and are welded
// into one (their positions averaged). The overlap keeps both tiles' implicit functions
// alike near the seam: it is wider than the support field's reach (2√3 leaves), so the
// trim near a seam sees the same samples in both tiles.
//
// Tiles are cut on a 2-D grid over the scene's two longest axes (an aerial scene's ground
// plane, a facade's face), by sample count, so each tile's solve fits `heapTarget`.

import { createCellIndex } from './cellIndex.js'

// The leaf grid the crate builds for `pos` at `depth` (crates/mesh PoissonBuilder::new):
// the samples' box loosened by one leaf, the leaf the largest extent / 2^depth. Computed
// in doubles from the same f32 samples, so it is the crate's grid exactly.
export function poissonGrid(pos, depth) {
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = pos[i + k]
      if (v < lo[k]) lo[k] = v
      if (v > hi[k]) hi[k] = v
    }
  }
  const ext = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])
  const leaf = ext / Math.pow(2, depth)
  return { origin: [lo[0] - leaf, lo[1] - leaf, lo[2] - leaf], leaf, lo, hi }
}

const cellOf = (v, o, leaf) => Math.floor((v - o) / leaf)

// Cut points along one axis that split `cells` (sorted cell indices) into `k` parts of
// about equal count, as cell boundaries (a part is [cut[i], cut[i+1])).
function quantileCuts(cells, k) {
  const cuts = []
  for (let i = 1; i < k; i++) {
    const c = cells[Math.floor((i * cells.length) / k)]
    if (cuts.length === 0 || c > cuts[cuts.length - 1]) cuts.push(c)
  }
  return [-Infinity, ...cuts, Infinity]
}

/**
 * The tiles for `pos` (samples, relative coordinates) at `depth` on `grid`, or null when
 * one solve fits: `heapFor(samples, depth)` (bytes) above `oneSolveBytes` tiles, each tile
 * planned to `heapTarget` with its overlap. `overlapCells` is the least overlap.
 * Returns { axes: [a, b], overlap, tiles: [{ core: { a0, a1, b0, b1 }, samples }] }.
 */
export function planMeshTiles(pos, depth, grid, { heapFor, oneSolveBytes, heapTarget, overlapCells = 8 }) {
  const n = pos.length / 3
  if (!(n > 0) || heapFor(n, depth) <= oneSolveBytes) return null
  const ext = [0, 1, 2].map((k) => grid.hi[k] - grid.lo[k])
  const order = [0, 1, 2].sort((p, q) => ext[q] - ext[p])
  const [a, b] = [order[0], order[1]]
  const { origin, leaf } = grid
  const ca = new Int32Array(n),
    cb = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    ca[i] = cellOf(pos[3 * i + a], origin[a], leaf)
    cb[i] = cellOf(pos[3 * i + b], origin[b], leaf)
  }
  const sortedA = Int32Array.from(ca).sort()
  for (let tiles = Math.ceil(heapFor(n, depth) / heapTarget); tiles <= 4096; tiles = Math.ceil(tiles * 1.5)) {
    const na = Math.max(1, Math.round(Math.sqrt((tiles * ext[a]) / Math.max(ext[b], 1e-12))))
    const nb = Math.max(1, Math.ceil(tiles / na))
    const cutsA = quantileCuts(sortedA, na)
    const out = []
    const overlap = (span) => Math.max(overlapCells, Math.ceil(0.05 * span))
    let fits = true
    for (let i = 0; i + 1 < cutsA.length && fits; i++) {
      const [a0, a1] = [cutsA[i], cutsA[i + 1]]
      const inStrip = []
      for (let s = 0; s < n; s++) if (ca[s] >= a0 && ca[s] < a1) inStrip.push(cb[s])
      const cutsB = quantileCuts(
        inStrip.sort((p, q) => p - q),
        nb,
      )
      for (let j = 0; j + 1 < cutsB.length; j++) {
        const core = { a0, a1, b0: cutsB[j], b1: cutsB[j + 1] }
        out.push({ core, samples: 0 })
      }
    }
    // The overlap from each tile's own span (in cells), at least `overlapCells`.
    const spanA = (sortedA[n - 1] - sortedA[0] + 1) / na
    const ov = overlap(spanA)
    for (const t of out) {
      const { a0, a1, b0, b1 } = t.core
      for (let s = 0; s < n; s++)
        if (ca[s] >= a0 - ov && ca[s] < a1 + ov && cb[s] >= b0 - ov && cb[s] < b1 + ov) t.samples++
      if (heapFor(t.samples, depth) > heapTarget) fits = false
    }
    if (fits) return { axes: [a, b], overlap: ov, tiles: out.filter((t) => t.samples > 0) }
  }
  return null
}

// The density trim's cell: crates/mesh TRIM_DENSITY_BACKOFF, two levels above the leaf.
export const TRIM_DENSITY_BACKOFF = 2

/**
 * The median support over all samples, as crates/mesh `SupportDensity::median_at` computes
 * it for one solve: each sample's weight splatted trilinearly onto a lattice of `cell`
 * (origin 0), the field evaluated trilinearly at every sample, the median taken. The
 * crate's density trim is relative to it; a tile alone would take its own samples'
 * median (quarry, 16 tiles: 790 to 2,099), so neighbours trimmed differently at a seam.
 * `weights` null = all 1; a weight that is not positive and finite splats nothing.
 */
export function supportMedian(pos, weights, cell) {
  const n = pos.length / 3
  if (!n) return 0
  const inv = 1 / cell
  let lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < n; i++)
    for (let k = 0; k < 3; k++) {
      const g = Math.floor(pos[3 * i + k] * inv)
      if (g < lo[k]) lo[k] = g
      if (g > hi[k]) hi[k] = g
    }
  lo = lo.map((v) => v - 1)
  const dim = [0, 1, 2].map((k) => hi[k] - lo[k] + 3)
  const key = (bx, by, bz) => ((bx - lo[0]) * dim[1] + (by - lo[1])) * dim[2] + (bz - lo[2])
  const slotOf = createCellIndex(2 * n)
  let sums = new Float64Array(Math.max(1024, 2 * n)),
    used = 0
  const corner = (f, d) => (d ? f : 1 - f)
  for (let i = 0; i < n; i++) {
    const w = weights ? (Number.isFinite(weights[i]) && weights[i] > 0 ? weights[i] : 0) : 1
    if (w <= 0) continue
    const g = [pos[3 * i] * inv, pos[3 * i + 1] * inv, pos[3 * i + 2] * inv]
    const b = g.map(Math.floor),
      f = [g[0] - b[0], g[1] - b[1], g[2] - b[2]]
    for (let c = 0; c < 8; c++) {
      const [dx, dy, dz] = [c & 1, (c >> 1) & 1, (c >> 2) & 1]
      const k = corner(f[0], dx) * corner(f[1], dy) * corner(f[2], dz)
      if (!(k > 0)) continue
      const kk = key(b[0] + dx, b[1] + dy, b[2] + dz)
      let slot = slotOf.get(kk, -1)
      if (slot < 0) {
        if (used === sums.length) {
          const grown = new Float64Array(2 * sums.length)
          grown.set(sums)
          sums = grown
        }
        slot = used++
        slotOf.set(kk, slot)
      }
      sums[slot] += w * k
    }
  }
  const at = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const g = [pos[3 * i] * inv, pos[3 * i + 1] * inv, pos[3 * i + 2] * inv]
    const b = g.map(Math.floor),
      f = [g[0] - b[0], g[1] - b[1], g[2] - b[2]]
    let v = 0
    for (let c = 0; c < 8; c++) {
      const [dx, dy, dz] = [c & 1, (c >> 1) & 1, (c >> 2) & 1]
      const slot = slotOf.get(key(b[0] + dx, b[1] + dy, b[2] + dz), -1)
      if (slot >= 0) v += sums[slot] * corner(f[0], dx) * corner(f[1], dy) * corner(f[2], dz)
    }
    at[i] = v
  }
  // The crate's select_nth at len/2: the upper median.
  return at.sort()[n >> 1]
}

// The samples of `tile` with its overlap, as the solver takes them.
export function tileInput(sub, plan, tile, grid) {
  const [a, b] = plan.axes,
    ov = plan.overlap
  const { a0, a1, b0, b1 } = tile.core
  const { origin, leaf } = grid
  const n = sub.pos.length / 3
  const keep = []
  for (let i = 0; i < n; i++) {
    const ia = cellOf(sub.pos[3 * i + a], origin[a], leaf),
      ib = cellOf(sub.pos[3 * i + b], origin[b], leaf)
    if (ia >= a0 - ov && ia < a1 + ov && ib >= b0 - ov && ib < b1 + ov) keep.push(i)
  }
  const pos = new Float32Array(keep.length * 3),
    nrm = new Float32Array(keep.length * 3),
    wgt = new Float32Array(keep.length)
  keep.forEach((s, j) => {
    for (let k = 0; k < 3; k++) {
      pos[3 * j + k] = sub.pos[3 * s + k]
      nrm[3 * j + k] = sub.nrm[3 * s + k]
    }
    wgt[j] = sub.wgt ? sub.wgt[s] : 1
  })
  return { pos, nrm, wgt }
}

// The triangles of one tile's mesh ({ pos, idx }, relative coordinates) whose centroid's
// cell lies in the tile's core, with their vertices renumbered.
export function cutToCore(mesh, plan, tile, grid) {
  const [a, b] = plan.axes
  const { a0, a1, b0, b1 } = tile.core
  const { origin, leaf } = grid
  const { pos, idx } = mesh
  const remap = new Int32Array(pos.length / 3).fill(-1)
  const outIdx = []
  let nv = 0
  for (let t = 0; t < idx.length; t += 3) {
    const [p, q, r] = [idx[t], idx[t + 1], idx[t + 2]]
    const ca = cellOf((pos[3 * p + a] + pos[3 * q + a] + pos[3 * r + a]) / 3, origin[a], leaf)
    const cb = cellOf((pos[3 * p + b] + pos[3 * q + b] + pos[3 * r + b]) / 3, origin[b], leaf)
    if (ca < a0 || ca >= a1 || cb < b0 || cb >= b1) continue
    for (const v of [p, q, r]) {
      if (remap[v] < 0) remap[v] = nv++
      outIdx.push(remap[v])
    }
  }
  const outPos = new Float32Array(nv * 3)
  for (let v = 0; v < remap.length; v++)
    if (remap[v] >= 0) for (let k = 0; k < 3; k++) outPos[3 * remap[v] + k] = pos[3 * v + k]
  return { pos: outPos, idx: Uint32Array.from(outIdx) }
}

// The lattice edge (or corner) a marching-cubes vertex lies on, as a number, or -1 when
// the position is on no lattice edge. Two coordinates sit on the lattice (to `tol` of a
// leaf; the positions are f32), the third between two lattice values. `dims` bounds the
// indices for the packing.
function edgeKey(x, y, z, grid, dims) {
  const { origin, leaf } = grid
  const f = [(x - origin[0]) / leaf, (y - origin[1]) / leaf, (z - origin[2]) / leaf]
  const tol = 1e-3
  let off = -1,
    offs = 0
  const ix = [0, 0, 0]
  for (let k = 0; k < 3; k++) {
    const r = Math.round(f[k])
    if (Math.abs(f[k] - r) < tol) ix[k] = r
    else {
      off = k
      offs++
      ix[k] = Math.floor(f[k])
    }
  }
  if (offs > 1) return -1
  const axis = off < 0 ? 3 : off
  return ((axis * dims + ix[0] + 1) * dims + ix[1] + 1) * dims + ix[2] + 1
}

/**
 * Join the tiles' cut meshes ([{ pos, idx }], relative coordinates) into one: vertices
 * within a cell of a tile's core border are welded by lattice edge across tiles (their
 * positions averaged), triangles that collapse are dropped. Returns { pos, idx,
 * seamEdges, openSeamEdges }: the edges between welded seam vertices, and how many of them
 * only one triangle uses (a crack along a seam; 0 when the tiles agree there).
 */
export function stitchTiles(parts, plan, grid) {
  const [a, b] = plan.axes
  const { origin, leaf } = grid
  const dims = Math.ceil(Math.max(...[0, 1, 2].map((k) => (grid.hi[k] - origin[k]) / leaf))) + 4
  const total = parts.reduce((s, p) => s + p.pos.length / 3, 0)
  const sum = new Float64Array(total * 3),
    cnt = new Uint32Array(total)
  const seam = new Uint8Array(total)
  const byKey = new Map()
  const idxAll = []
  let nv = 0
  parts.forEach((part, pi) => {
    const { a0, a1, b0, b1 } = plan.tiles[pi].core
    // A vertex a tile shares with its neighbour lies on the face between their cells, at
    // the border's lattice value; within one cell of it is the seam.
    const near = (c, lo, hi) =>
      (Number.isFinite(lo) && Math.abs(c - lo) <= 1) || (Number.isFinite(hi) && Math.abs(c - hi) <= 1)
    const local = new Int32Array(part.pos.length / 3)
    for (let v = 0; v < local.length; v++) {
      const [x, y, z] = [part.pos[3 * v], part.pos[3 * v + 1], part.pos[3 * v + 2]]
      const p = [x, y, z]
      const ca = Math.round((p[a] - origin[a]) / leaf),
        cb = Math.round((p[b] - origin[b]) / leaf)
      const onSeam = near(ca, a0, a1) || near(cb, b0, b1)
      const key = onSeam ? edgeKey(x, y, z, grid, dims) : -1
      let g = key >= 0 ? byKey.get(key) : undefined
      if (g === undefined) {
        g = nv++
        if (key >= 0) byKey.set(key, g)
      }
      if (onSeam) seam[g] = 1
      sum[3 * g] += x
      sum[3 * g + 1] += y
      sum[3 * g + 2] += z
      cnt[g]++
      local[v] = g
    }
    for (let t = 0; t < part.idx.length; t += 3) {
      const [p, q, r] = [local[part.idx[t]], local[part.idx[t + 1]], local[part.idx[t + 2]]]
      if (p !== q && q !== r && p !== r) idxAll.push(p, q, r)
    }
  })
  const pos = new Float32Array(nv * 3)
  for (let g = 0; g < nv; g++) for (let k = 0; k < 3; k++) pos[3 * g + k] = sum[3 * g + k] / cnt[g]
  // Seam edges and the open ones among them.
  const uses = new Map()
  for (let t = 0; t < idxAll.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const p = idxAll[t + e],
        q = idxAll[t + ((e + 1) % 3)]
      if (!seam[p] || !seam[q]) continue
      const k = p < q ? p * nv + q : q * nv + p
      uses.set(k, (uses.get(k) ?? 0) + 1)
    }
  }
  let openSeamEdges = 0
  for (const c of uses.values()) if (c === 1) openSeamEdges++
  return { pos, idx: Uint32Array.from(idxAll), seamEdges: uses.size, openSeamEdges }
}

/** Drop the connected pieces that explain less than `minShare` of the best-supported
 *  piece's support: the floater removal, run on the stitched mesh (a piece a tile border
 *  cut is no floater). As crates/mesh `drop_small_components`, a piece's support is the
 *  summed weight of the samples (`samples`, `weights`; relative coordinates) whose nearest
 *  vertex within `reach` lies on it — evidence, not area: Poisson inflates a 20-point
 *  speck into a ball a few cells across. Returns { pos, idx, pieces, dropped, droppedTris }. */
export function dropSmallPieces(pos, idx, minShare, { samples, weights = null, reach }) {
  const nv = pos.length / 3
  const parent = new Int32Array(nv).map((_, i) => i)
  const find = (x) => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]]
    return x
  }
  for (let t = 0; t < idx.length; t += 3) {
    const r = find(idx[t])
    parent[find(idx[t + 1])] = r
    parent[find(idx[t + 2])] = r
  }
  // Vertices hashed on a `reach` grid (a typed index: a Map stops at 2^24 entries, fewer
  // than a large mesh has vertices); each sample credits the piece of its nearest vertex.
  const inv = 1 / reach
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity]
  for (const arr of [pos, samples])
    for (let i = 0; i < arr.length; i += 3)
      for (let k = 0; k < 3; k++) {
        if (arr[i + k] < lo[k]) lo[k] = arr[i + k]
        if (arr[i + k] > hi[k]) hi[k] = arr[i + k]
      }
  const dim = [0, 1, 2].map((k) => Math.floor((hi[k] - lo[k]) * inv) + 1)
  const cellKey = (cx, cy, cz) =>
    cx < 0 || cy < 0 || cz < 0 || cx >= dim[0] || cy >= dim[1] || cz >= dim[2] ? -1 : (cx * dim[1] + cy) * dim[2] + cz
  const at = (x, k) => Math.floor((x - lo[k]) * inv)
  const head = createCellIndex(nv)
  const next = new Int32Array(nv)
  for (let v = 0; v < nv; v++) {
    const key = cellKey(at(pos[3 * v], 0), at(pos[3 * v + 1], 1), at(pos[3 * v + 2], 2))
    next[v] = head.get(key, -1)
    head.set(key, v)
  }
  const support = new Map()
  const r2 = reach * reach
  for (let s = 0; s < samples.length / 3; s++) {
    const [x, y, z] = [samples[3 * s], samples[3 * s + 1], samples[3 * s + 2]]
    const [cx, cy, cz] = [at(x, 0), at(y, 1), at(z, 2)]
    let best = -1,
      bestD = r2
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const key = cellKey(cx + dx, cy + dy, cz + dz)
          for (let v = key < 0 ? -1 : head.get(key, -1); v >= 0; v = next[v]) {
            const d = (pos[3 * v] - x) ** 2 + (pos[3 * v + 1] - y) ** 2 + (pos[3 * v + 2] - z) ** 2
            if (d <= bestD) {
              bestD = d
              best = v
            }
          }
        }
    if (best >= 0) {
      const r = find(best)
      support.set(r, (support.get(r) ?? 0) + (weights ? weights[s] : 1))
    }
  }
  const roots = new Set()
  for (let t = 0; t < idx.length; t += 3) roots.add(find(idx[t]))
  const most = Math.max(0, ...support.values())
  const keepRoot = (r) => (support.get(r) ?? 0) >= minShare * most
  const remap = new Int32Array(nv).fill(-1)
  const outIdx = []
  let n = 0,
    droppedTris = 0
  for (let t = 0; t < idx.length; t += 3) {
    if (!keepRoot(find(idx[t]))) {
      droppedTris++
      continue
    }
    for (let e = 0; e < 3; e++) {
      const v = idx[t + e]
      if (remap[v] < 0) remap[v] = n++
      outIdx.push(remap[v])
    }
  }
  const outPos = new Float32Array(n * 3)
  for (let v = 0; v < nv; v++) if (remap[v] >= 0) for (let k = 0; k < 3; k++) outPos[3 * remap[v] + k] = pos[3 * v + k]
  let dropped = 0
  for (const r of roots) if (!keepRoot(r)) dropped++
  return { pos: outPos, idx: Uint32Array.from(outIdx), pieces: roots.size, dropped, droppedTris }
}
