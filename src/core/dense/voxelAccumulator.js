// World-space voxel merge of fused points: the one-shot mergePointsSpatial, the
// streaming createVoxelAccumulator fusion feeds pixel by pixel, the float64-exact
// packed-key guard (boundsCellProduct / clampCellForBounds) and the mix32 hash the
// accumulator's index and fusion's cell estimate share. Cells are origin-anchored,
// Math.floor(coord / cell), everywhere.

import { DENSE_TUNING } from '../tuning.js'

/**
 * Spatial (voxel) merge of a fused point set: collapse points that fall in the same
 * world-space cell into a single averaged point (position + colour). Order-independent,
 * so it's the principled way to kill the per-source-pixel "duplicate shells" a
 * multi-view fusion emits — the same surface point reconstructed from several views
 * lands in one cell and becomes one point. `cellSize` is in world units (≈ one
 * ground-sample-distance ⇒ one point per ground pixel-footprint: dedupes overlap while
 * preserving resolution). `cellSize <= 0` disables the merge (returns the input).
 */
export function mergePointsSpatial(points, cellSize) {
  if (!(cellSize > 0) || points.length === 0) return points
  const inv = 1 / cellSize
  const cells = new Map()
  for (const p of points) {
    const key = `${Math.floor(p.x * inv)},${Math.floor(p.y * inv)},${Math.floor(p.z * inv)}`
    let acc = cells.get(key)
    if (!acc) { acc = { x: 0, y: 0, z: 0, r: 0, g: 0, b: 0, nx: 0, ny: 0, nz: 0, n: 0 }; cells.set(key, acc) }
    acc.x += p.x; acc.y += p.y; acc.z += p.z
    acc.r += p.color[0]; acc.g += p.color[1]; acc.b += p.color[2]
    if (p.normal) { acc.nx += p.normal[0]; acc.ny += p.normal[1]; acc.nz += p.normal[2] }
    acc.n++
  }
  const out = []
  for (const a of cells.values()) {
    const k = 1 / a.n
    const o = {
      x: a.x * k, y: a.y * k, z: a.z * k,
      color: [Math.round(a.r * k), Math.round(a.g * k), Math.round(a.b * k)],
    }
    // Renormalized averaged normal (matches finalizeNormals); (0,0,1) fallback.
    const mag = Math.hypot(a.nx, a.ny, a.nz)
    o.normal = mag > 1e-9 ? [a.nx / mag, a.ny / mag, a.nz / mag] : [0, 0, 1]
    out.push(o)
  }
  return out
}

// murmur3's 32-bit finalizer: a bijective avalanche mix of an int32 (→ uint32). The
// voxel accumulator's index and the fusion cell-count estimate hash with it.
export function mix32(h) {
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}

// Streaming voxel accumulator: the fusion loop feeds kept pixels **one at a time**
// into this, so the raw per-source-pixel point list — the fusion OOM (25–30 M boxed
// {x,y,z,color} objects ≈ 3 GB on a 50-image set) — never materializes. It's the
// spatial merge of `mergePointsSpatial` done incrementally: cells are anchored at
// the world origin (`floor(coord/cell)`), identical to that function, so the merged
// cells/averages match exactly. Storage is an open-addressing hash of numeric keys
// → slot idx plus parallel typed-array sums (60 B per *merged cell* ≈ one ground
// pixel, + ≤ 16 B of index; memBudget.js DENSIFY_CELL_BYTES). Cell keys are packed
// numerically — `(dix·ny+diy)·nz+diz`
// — from per-axis offsets/counts derived from `bounds`; the caller keeps the product
// < 2^53 (float64-exact) via clampCellForBounds. `bounds` may be a coarse estimate
// (fusion samples every 16th pixel): a point outside the packed grid goes to a small
// string-keyed **overflow** map with the same origin-anchored cell, so the merge stays
// exact for every input. Clamping it into the border cell instead collapsed thin, tall
// features the stride sampling missed (a pole's top 16 px all averaged into one cell).
// Exact bounds are not the alternative: one far sky flyer would stretch the box, and
// clampCellForBounds would then coarsen the merge cell for the whole scene.
// The index is NOT a JS Map: V8 caps a Map at 2^24 (16,777,216) entries and throws
// "Map maximum size exceeded" past it, which a large fused cloud reaches, and every
// Map entry lives on the ~4 GB V8 heap. Colour sums are Uint32 (exact for integer
// channels, as every caller passes) and normal sums Float32 (renormalized on output).
// `capacity` presizes the slot arrays and the table (fusion passes its measured cell
// count), so a run that stays within it never reallocates.
export function createVoxelAccumulator(cellSize, bounds, { capacity = 1024 } = {}) {
  const inv = 1 / cellSize
  const ix0 = Math.floor(bounds.minX * inv), iy0 = Math.floor(bounds.minY * inv), iz0 = Math.floor(bounds.minZ * inv)
  const ix1 = Math.floor(bounds.maxX * inv), iy1 = Math.floor(bounds.maxY * inv), iz1 = Math.floor(bounds.maxZ * inv)
  // Pad one cell each side so a point just past a coarse-estimated bound still packs
  // to a unique in-range key instead of aliasing onto the opposite face.
  const bx = ix0 - 1, by = iy0 - 1, bz = iz0 - 1
  const nx = (ix1 - ix0) + 3, ny = (iy1 - iy0) + 3, nz = (iz1 - iz0) + 3
  // Cells outside the packed grid, keyed `${dix},${diy},${diz}` in the same grid-relative
  // indices (negative or ≥ n* there). Empty for callers that pass exact bounds.
  const overflow = new Map()
  const inGrid = (dix, diy, diz) => dix >= 0 && dix < nx && diy >= 0 && diy < ny && diz >= 0 && diz < nz
  let cap = Math.max(16, Math.ceil(capacity)), n = 0, nGrid = 0
  // keyOf[s]: the packed key of an in-grid slot, −1 for an overflow slot.
  let keyOf = new Float64Array(cap)
  let sx = new Float64Array(cap), sy = new Float64Array(cap), sz = new Float64Array(cap)
  let sr = new Uint32Array(cap), sg = new Uint32Array(cap), sb = new Uint32Array(cap)
  // World-space normal sums (Phase: Poisson meshing). Averaging unit normals then
  // renormalizing is a valid orientation estimate; the k coincident shell points a
  // surface produces all carry ~the same normal, so the sum stays well-conditioned.
  let snx = new Float32Array(cap), sny = new Float32Array(cap), snz = new Float32Array(cap)
  let cnt = new Uint32Array(cap)
  let removed = 0 // cells zeroed by filterIsolated (WS4); excluded from count + finalize
  // Open-addressing index (linear probing): table[i] = slot, −1 = empty. Power-of-two
  // size, load kept ≤ ½.
  let tsize = 1
  while (tsize < 2 * cap) tsize *= 2
  let table = new Int32Array(tsize).fill(-1), tmask = tsize - 1
  // Table position holding `key`, or −1 − (the empty position where it belongs).
  const find = (key) => {
    const hi = Math.floor(key / 4294967296)
    let i = mix32(mix32(hi) ^ (key - hi * 4294967296)) & tmask
    for (;;) {
      const s = table[i]
      if (s === -1) return -1 - i
      if (keyOf[s] === key) return i
      i = (i + 1) & tmask
    }
  }
  const growTable = () => {
    tsize *= 2; table = new Int32Array(tsize).fill(-1); tmask = tsize - 1
    for (let s = 0; s < n; s++) if (keyOf[s] >= 0) table[-1 - find(keyOf[s])] = s
  }
  const lookup = (key) => { const i = find(key); return i >= 0 ? table[i] : undefined }
  const slotAt = (dix, diy, diz) => (inGrid(dix, diy, diz) ? lookup((dix * ny + diy) * nz + diz)
    : overflow.size ? overflow.get(`${dix},${diy},${diz}`) : undefined)
  const grow = () => {
    cap *= 2
    const g = (a, T) => { const b = new T(cap); b.set(a); return b } // tail zero-filled
    keyOf = g(keyOf, Float64Array)
    sx = g(sx, Float64Array); sy = g(sy, Float64Array); sz = g(sz, Float64Array)
    sr = g(sr, Uint32Array); sg = g(sg, Uint32Array); sb = g(sb, Uint32Array)
    snx = g(snx, Float32Array); sny = g(sny, Float32Array); snz = g(snz, Float32Array)
    cnt = g(cnt, Uint32Array)
  }
  // Occupied 26-neighbours of a cell, stopping at `need` (filterIsolated's probe).
  const neighbours = (dix, diy, diz, radius, need) => {
    let neigh = 0
    for (let ddx = -radius; ddx <= radius; ddx++) {
      for (let ddy = -radius; ddy <= radius; ddy++) {
        for (let ddz = -radius; ddz <= radius; ddz++) {
          if (ddx === 0 && ddy === 0 && ddz === 0) continue
          const ns = slotAt(dix + ddx, diy + ddy, diz + ddz)
          if (ns !== undefined && cnt[ns] > 0 && ++neigh >= need) return neigh
        }
      }
    }
    return neigh
  }
  // Slot → origin-anchored cell index along `axis` (0 x, 1 y, 2 z), the same
  // floor(coord/cell) the slot was keyed by. Overflow slots decode their string key
  // (reverse map built on first use; overflow is the rare thin-feature spill).
  let overflowKeyOf = null
  const cellIndex = (s, axis) => {
    const key = keyOf[s]
    let d
    if (key >= 0) d = axis === 0 ? Math.floor(key / (nz * ny)) : axis === 1 ? Math.floor(key / nz) % ny : key % nz
    else {
      if (!overflowKeyOf || overflowKeyOf.size !== overflow.size) overflowKeyOf = new Map([...overflow].map(([k, v]) => [v, k]))
      d = Number(overflowKeyOf.get(s).split(',')[axis])
    }
    return d + (axis === 0 ? bx : axis === 1 ? by : bz)
  }
  const inRange = (s, { axis, lo, hi }) => { const a = cellIndex(s, axis); return a >= lo && a < hi }
  return {
    // Normals (nx,ny,nz) are optional (world-space, unit) — omitted callers still
    // get the exact same cells/averages for the 6-float wire format.
    add(x, y, z, r, g, b, nx_ = 0, ny_ = 0, nz_ = 0) {
      const dix = Math.floor(x * inv) - bx
      const diy = Math.floor(y * inv) - by
      const diz = Math.floor(z * inv) - bz
      let s
      if (inGrid(dix, diy, diz)) {
        const key = (dix * ny + diy) * nz + diz
        const i = find(key)
        if (i >= 0) s = table[i]
        else { // fresh slot is zeroed
          if (n === cap) grow()
          s = n++; keyOf[s] = key; table[-1 - i] = s
          if (2 * ++nGrid > tsize) growTable()
        }
      } else {
        const key = `${dix},${diy},${diz}`
        s = overflow.get(key)
        if (s === undefined) { if (n === cap) grow(); s = n++; keyOf[s] = -1; overflow.set(key, s) }
      }
      sx[s] += x; sy[s] += y; sz[s] += z
      sr[s] += r; sg[s] += g; sb[s] += b
      snx[s] += nx_; sny[s] += ny_; snz[s] += nz_
      cnt[s]++
    },
    get count() { return n - removed },
    // Cells that fell outside `bounds` (kept exact in the overflow map). Non-zero means
    // the caller's bounds estimate missed real points — worth a log line, not an error.
    get overflowCells() { return overflow.size },
    // Bytes the accumulator holds (slot arrays at capacity + the index table) — the
    // figure fusion logs against its pre-flight projection.
    get bytes() { return cap * 60 + tsize * 4 },
    // Post-fusion isolated-cell removal (WS4): a real surface cell has occupied
    // neighbours; a lone low-support cell is fusion noise (a sky/vegetation flyer that
    // slipped the consistency gate). Only *low-support* cells (cnt ≤ maxSupport) are
    // tested — a ≥3-pixel cell is never a floater — so this stays O(noise tail), not
    // O(all cells). For each tested cell, probe the 26 (radius 1) neighbour keys
    // arithmetically; if fewer than `minNeighbors` are occupied, zero its count so the
    // finalizers skip it. Cell indices are recovered from the packed key (or parsed
    // from an overflow key; neighbours straddle the two maps). Returns the number removed.
    // Every verdict is taken against the unfiltered occupancy and applied afterwards, so
    // the result does not depend on cell order. That is what lets a tile decide its
    // own cells exactly from a one-cell halo (tiled fusion): a sequential pass let a
    // cell zeroed earlier change a later cell's verdict, a chain no fixed halo bounds.
    // `within` ({ axis, lo, hi }) tests only the cells in that cell-index range; the
    // rest still count as neighbours.
    filterIsolated({ radius = 1, minNeighbors = 2, maxSupport = 2, within = null } = {}) {
      const drop = []
      for (let s = 0; s < n; s++) {
        const key = keyOf[s]
        if (key < 0 || cnt[s] === 0 || cnt[s] > maxSupport || (within && !inRange(s, within))) continue
        const diz = key % nz
        const diy = Math.floor(key / nz) % ny
        const dix = Math.floor(key / (nz * ny))
        if (neighbours(dix, diy, diz, radius, minNeighbors) < minNeighbors) drop.push(s)
      }
      for (const [key, s] of overflow) {
        if (cnt[s] === 0 || cnt[s] > maxSupport || (within && !inRange(s, within))) continue
        const [dix, diy, diz] = key.split(',').map(Number)
        if (neighbours(dix, diy, diz, radius, minNeighbors) < minNeighbors) drop.push(s)
      }
      for (const s of drop) cnt[s] = 0
      removed += drop.length
      return drop.length
    },
    // Occupied cells inside `within` ({ axis, lo, hi } in origin-anchored cell indices).
    countWithin(within) {
      let c = 0
      for (let s = 0; s < n; s++) if (cnt[s] > 0 && inRange(s, within)) c++
      return c
    },
    // Drop every cell outside `within` (a tile's halo, once it has served as
    // neighbours), so `count` and the finalizers see the tile's own cells only.
    restrict(within) {
      let c = 0
      for (let s = 0; s < n; s++) if (cnt[s] > 0 && !inRange(s, within)) { cnt[s] = 0; c++ }
      removed += c
      return c
    },
    // Finalize into the dense cloud's own layout: Float32 position, Uint8 colour and
    // Float32 unit normal per merged cell, 27 B, the same values finalizeFlat and
    // finalizeNormals give. The accumulator is released while it goes (the index and
    // keys first, then each sum as soon as its output is written), so the finished
    // cloud never sits beside a whole accumulator: finishing peaks below what
    // accumulating already held. The accumulator is spent afterwards.
    // Returns { count, pos, col, nrm, degenerate }.
    finalizeCloud() {
      const m = n - removed
      table = null; keyOf = null; overflow.clear()
      const pos = new Float32Array(3 * m)
      for (let s = 0, o = 0; s < n; s++) {
        if (cnt[s] === 0) continue
        const k = 1 / cnt[s]
        pos[o] = sx[s] * k; pos[o + 1] = sy[s] * k; pos[o + 2] = sz[s] * k
        o += 3
      }
      sx = sy = sz = null
      const col = new Uint8Array(3 * m)
      for (let s = 0, o = 0; s < n; s++) {
        if (cnt[s] === 0) continue
        const k = 1 / cnt[s]
        col[o] = Math.round(sr[s] * k); col[o + 1] = Math.round(sg[s] * k); col[o + 2] = Math.round(sb[s] * k)
        o += 3
      }
      sr = sg = sb = null
      const nrm = new Float32Array(3 * m)
      let degenerate = 0
      for (let s = 0, o = 0; s < n; s++) {
        if (cnt[s] === 0) continue
        const ax = snx[s], ay = sny[s], az = snz[s]
        const mag = Math.hypot(ax, ay, az)
        if (mag > 1e-9) { nrm[o] = ax / mag; nrm[o + 1] = ay / mag; nrm[o + 2] = az / mag }
        else { nrm[o] = 0; nrm[o + 1] = 0; nrm[o + 2] = 1; degenerate++ }
        o += 3
      }
      snx = sny = snz = null; cnt = null
      return { count: m, pos, col, nrm, degenerate }
    },
    // Finalize straight into the wire format the densify op returns: a flat
    // Float32Array of [x,y,z,r,g,b] per merged cell (no intermediate objects). Cells
    // zeroed by filterIsolated (cnt === 0) are skipped and the output is compacted.
    finalizeFlat() {
      const out = new Float32Array((n - removed) * 6)
      let o = 0
      for (let s = 0; s < n; s++) {
        if (cnt[s] === 0) continue
        const k = 1 / cnt[s]
        out[o] = sx[s] * k; out[o + 1] = sy[s] * k; out[o + 2] = sz[s] * k
        out[o + 3] = Math.round(sr[s] * k); out[o + 4] = Math.round(sg[s] * k); out[o + 5] = Math.round(sb[s] * k)
        o += 6
      }
      return out
    },
    // Averaged, renormalized world-space normals as a flat Float32Array(3N) — the
    // Poisson solver's oriented-normal input. Cells whose contributors cancelled to
    // a near-zero vector (disagreeing views) fall back to (0,0,1); count returned.
    // Iterates in the SAME order as finalizeFlat (skipping cnt === 0), so the two
    // arrays stay row-aligned.
    finalizeNormals() {
      const out = new Float32Array((n - removed) * 3)
      let degenerate = 0, o = 0
      for (let s = 0; s < n; s++) {
        if (cnt[s] === 0) continue
        const ax = snx[s], ay = sny[s], az = snz[s]
        const mag = Math.hypot(ax, ay, az)
        if (mag > 1e-9) { out[o] = ax / mag; out[o + 1] = ay / mag; out[o + 2] = az / mag }
        else { out[o] = 0; out[o + 1] = 0; out[o + 2] = 1; degenerate++ }
        o += 3
      }
      return { nrm: out, degenerate }
    },
  }
}

// Packed-key cell count for `bounds` at `cell` (matches createVoxelAccumulator's
// nx·ny·nz). Used to keep the key float64-exact.
function boundsCellProduct(bounds, cell) {
  const inv = 1 / cell
  const nx = Math.floor(bounds.maxX * inv) - Math.floor(bounds.minX * inv) + 3
  const ny = Math.floor(bounds.maxY * inv) - Math.floor(bounds.minY * inv) + 3
  const nz = Math.floor(bounds.maxZ * inv) - Math.floor(bounds.minZ * inv) + 3
  return nx * ny * nz
}

// Clamp a requested cell size UP until the packed cell key stays exact in float64
// (product < fuseMaxCells). A degenerate/huge scene (or a near-zero requested cell)
// would otherwise overflow 2^53 and alias distinct cells together.
export function clampCellForBounds(bounds, cell) {
  let c = cell > 0 ? cell : 1e-6
  let iter = 0
  while (boundsCellProduct(bounds, c) > DENSE_TUNING.fuseMaxCells && iter++ < 64) c *= 2
  return c
}
