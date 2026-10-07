// Mesh generation (screened Poisson) — pure, no Vue/Pinia/OPFS/DOM. A products-stage
// concern like dem.js / ortho.js. Takes the flat dense cloud (pos/col/nrm), runs the
// wasm Poisson solver (injected — the worker wires the real one; tests pass a stub),
// parses its flat byte buffer, and transfers colour from the dense cloud onto the new
// Poisson vertices. Everything stays flat typed arrays (no per-vertex objects).

import { MESH_DEFAULTS } from '../defaults.user.js'
import { MESH_TUNING } from '../tuning.js'
import { removeIsolated } from './cloudEdit.js'

// Parse the wasm byte buffer into typed arrays. Layout (little-endian):
//   header [u32 nVerts, u32 nTris] + f32 positions (3·nVerts) + u32 indices (3·nTris).
// Returns { nVerts, nTris, pos:Float32Array(3·nVerts), idx:Uint32Array(3·nTris) }.
// Byte offsets are 4-aligned throughout, so typed-array views over the buffer are safe.
export function parseMeshBuffer(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (u8.byteLength < 8) return { nVerts: 0, nTris: 0, pos: new Float32Array(0), idx: new Uint32Array(0) }
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  const nVerts = dv.getUint32(0, true)
  const nTris = dv.getUint32(4, true)
  const posStart = u8.byteOffset + 8
  const idxStart = posStart + nVerts * 3 * 4
  // Copy out (slice) so the returned arrays own their memory independent of `bytes`.
  const pos = new Float32Array(u8.buffer.slice(posStart, posStart + nVerts * 3 * 4))
  const idx = new Uint32Array(u8.buffer.slice(idxStart, idxStart + nTris * 3 * 4))
  return { nVerts, nTris, pos, idx }
}

// Cell-grid geometry of a flat position buffer at `cell`, for numeric key packing —
// `{ bx, by, bz, nx, ny, nz, packed }`: the base cell index per axis and the per-axis
// cell counts the `(dix·ny+diy)·nz+diz` packing multiplies by. One cell of padding each
// side means a coordinate just past the measured bound still packs to a unique in-range
// key. `packed` is false when the cell count product would exceed float64's exact
// integer range (an enormous extent against a tiny cell) — the callers then fall back
// to string keys, since a silently-colliding key is worse than a slow one.
function packingFor(pos, cell) {
  const inv = 1 / cell
  const n = pos.length / 3
  if (!(n > 0)) return { bx: 0, by: 0, bz: 0, nx: 1, ny: 1, nz: 1, packed: true }
  let ix0 = Infinity, iy0 = Infinity, iz0 = Infinity
  let ix1 = -Infinity, iy1 = -Infinity, iz1 = -Infinity
  for (let i = 0; i < n; i++) {
    const kx = Math.floor(pos[i * 3] * inv)
    const ky = Math.floor(pos[i * 3 + 1] * inv)
    const kz = Math.floor(pos[i * 3 + 2] * inv)
    if (kx < ix0) ix0 = kx; if (kx > ix1) ix1 = kx
    if (ky < iy0) iy0 = ky; if (ky > iy1) iy1 = ky
    if (kz < iz0) iz0 = kz; if (kz > iz1) iz1 = kz
  }
  const nx = (ix1 - ix0) + 3, ny = (iy1 - iy0) + 3, nz = (iz1 - iz0) + 3
  return {
    bx: ix0 - 1, by: iy0 - 1, bz: iz0 - 1,
    nx, ny, nz,
    packed: Number.isFinite(nx * ny * nz) && nx * ny * nz <= Number.MAX_SAFE_INTEGER,
  }
}

// Cell key for `pack`: the packed number, or the legacy string when packing would not
// stay float64-exact. `dix/diy/diz` are offsets already rebased by `bx/by/bz`.
function cellKey(pack, dix, diy, diz) {
  return pack.packed ? (dix * pack.ny + diy) * pack.nz + diz : `${dix},${diy},${diz}`
}

// Build a voxel hash of a flat dense cloud at `cell`: numeric packed key → index of a
// representative point in that cell (last writer wins; colour is averaged upstream by
// fusion, so any occupant is fine). Same floor(coord/cell) anchoring as the fusion
// accumulator, and the same numeric `(dix·ny+diy)·nz+diz` key packing — a dense cloud
// is millions of points, and a template-string key allocates a string per point.
function buildColorGrid(pos, cell, pack) {
  const inv = 1 / cell
  const { bx, by, bz } = pack
  const grid = new Map()
  const n = pos.length / 3
  for (let i = 0; i < n; i++) {
    const dix = Math.floor(pos[i * 3] * inv) - bx
    const diy = Math.floor(pos[i * 3 + 1] * inv) - by
    const diz = Math.floor(pos[i * 3 + 2] * inv) - bz
    grid.set(cellKey(pack, dix, diy, diz), i)
  }
  return grid
}

// Colour each mesh vertex from the nearest occupied dense-cloud cell. For each vertex
// we scan a (2r+1)³ neighbourhood of cells and pick the nearest dense point by true
// distance; a vertex with no dense point in range gets the gray fallback (counted).
// Returns { col:Uint8Array(3·nVerts), misses, missed:Uint8Array(nVerts) } (1 = gray fallback).
export function transferVertexColors(meshPos, dense, cell, opts = {}) {
  const { searchRadius = MESH_TUNING.colorSearchRadius, grayFallback = MESH_TUNING.grayFallback } = opts
  const nVerts = meshPos.length / 3
  const col = new Uint8Array(nVerts * 3)
  const missed = new Uint8Array(nVerts)
  const dpos = dense.pos
  const dcol = dense.col
  if (!dpos || !dcol || !(cell > 0)) {
    for (let i = 0; i < nVerts; i++) { col[i*3] = grayFallback[0]; col[i*3+1] = grayFallback[1]; col[i*3+2] = grayFallback[2] }
    return { col, misses: nVerts, missed: missed.fill(1) }
  }
  const pack = packingFor(dpos, cell)
  const { bx, by, bz, nx, ny, nz } = pack
  const grid = buildColorGrid(dpos, cell, pack)
  const inv = 1 / cell
  let misses = 0
  for (let v = 0; v < nVerts; v++) {
    const vx = meshPos[v * 3], vy = meshPos[v * 3 + 1], vz = meshPos[v * 3 + 2]
    const cx = Math.floor(vx * inv), cy = Math.floor(vy * inv), cz = Math.floor(vz * inv)
    let bestI = -1, bestD2 = Infinity
    for (let dz = -searchRadius; dz <= searchRadius; dz++) {
      const diz = cz + dz - bz
      if (diz < 0 || diz >= nz) continue
      for (let dy = -searchRadius; dy <= searchRadius; dy++) {
        const diy = cy + dy - by
        if (diy < 0 || diy >= ny) continue
        for (let dx = -searchRadius; dx <= searchRadius; dx++) {
          // Poisson extrapolates past the cloud, so a mesh vertex can sit outside the
          // packed range. Skip rather than let the key alias onto an unrelated cell —
          // out of range genuinely means "no dense point here".
          const dix = cx + dx - bx
          if (dix < 0 || dix >= nx) continue
          const idx = grid.get(cellKey(pack, dix, diy, diz))
          if (idx === undefined) continue
          const ex = dpos[idx*3] - vx, ey = dpos[idx*3+1] - vy, ez = dpos[idx*3+2] - vz
          const d2 = ex*ex + ey*ey + ez*ez
          if (d2 < bestD2) { bestD2 = d2; bestI = idx }
        }
      }
    }
    const o = v * 3
    if (bestI >= 0) { col[o] = dcol[bestI*3]; col[o+1] = dcol[bestI*3+1]; col[o+2] = dcol[bestI*3+2] }
    else { col[o] = grayFallback[0]; col[o+1] = grayFallback[1]; col[o+2] = grayFallback[2]; misses++; missed[v] = 1 }
  }
  return { col, misses, missed }
}

// Bounding-box max extent of a flat position buffer (world units). 0 for an empty/flat
// cloud. Used to size the octree leaf cell and the input downsample.
function maxExtent(pos) {
  const n = pos.length / 3
  if (n === 0) return 0
  let minx = Infinity, miny = Infinity, minz = Infinity
  let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2]
    if (x < minx) minx = x; if (x > maxx) maxx = x
    if (y < miny) miny = y; if (y > maxy) maxy = y
    if (z < minz) minz = z; if (z > maxz) maxz = z
  }
  return Math.max(maxx - minx, maxy - miny, maxz - minz)
}

// World-unit voxel cell for the Poisson INPUT downsample at a given octree `depth`. A
// depth-D octree resolves nothing finer than one leaf cell (extent / 2^D), so we thin the
// input to ≈ `leafCellsPerPoint` leaf cells per point. Returns 0 (⇒ no downsample) for a
// degenerate cloud or non-positive depth.
export function meshInputCell(pos, depth, leafCellsPerPoint = 1) {
  const extent = maxExtent(pos)
  if (!(extent > 0) || !(depth > 0)) return 0
  const leaf = extent / Math.pow(2, depth)
  return leaf * Math.max(1, leafCellsPerPoint)
}

// Voxel-subsample the Poisson input: collapse points sharing a `cell`-sized world cell
// into one averaged position + renormalised averaged normal (matches the fusion merge),
// and record how many raw points each sample stands for — its **support weight**, which
// the crate's trim and floater filter read (a 30-point surface voxel and a 1-point stray
// voxel must not look alike after thinning). Colour is dropped: mesh vertex colour is
// transferred from the FULL dense cloud afterwards. Positions come out relative to
// `origin` (Float32 — an imported cloud's absolute projected coordinates would lose
// decimetres in f32), accumulated in doubles. Returns { pos, nrm, wgt } (Float32Array).
// `cell <= 0` keeps every point (wgt all 1), still re-expressed relative to `origin`.
export function subsampleForMesh(pos, nrm, cell, origin = [0, 0, 0]) {
  const n = pos.length / 3
  const [ox, oy, oz] = origin
  if (!(cell > 0)) {
    const rel = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      rel[i * 3] = pos[i * 3] - ox; rel[i * 3 + 1] = pos[i * 3 + 1] - oy; rel[i * 3 + 2] = pos[i * 3 + 2] - oz
    }
    return { pos: rel, nrm, wgt: new Float32Array(n).fill(1) }
  }
  const inv = 1 / cell
  // Numeric packed cell keys, as in the fusion accumulator — this runs over the whole
  // dense cloud (millions of points), where a template-string key allocates a string
  // per point.
  const pack = packingFor(pos, cell)
  const { bx, by, bz } = pack
  const cells = new Map()
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2]
    const dix = Math.floor(x * inv) - bx
    const diy = Math.floor(y * inv) - by
    const diz = Math.floor(z * inv) - bz
    const key = cellKey(pack, dix, diy, diz)
    let a = cells.get(key)
    if (!a) { a = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, n: 0 }; cells.set(key, a) }
    a.x += x - ox; a.y += y - oy; a.z += z - oz
    a.nx += nrm[i * 3]; a.ny += nrm[i * 3 + 1]; a.nz += nrm[i * 3 + 2]
    a.n++
  }
  const m = cells.size
  const outPos = new Float32Array(m * 3)
  const outNrm = new Float32Array(m * 3)
  const wgt = new Float32Array(m)
  let j = 0
  for (const a of cells.values()) {
    const k = 1 / a.n
    outPos[j * 3] = a.x * k; outPos[j * 3 + 1] = a.y * k; outPos[j * 3 + 2] = a.z * k
    const mag = Math.hypot(a.nx, a.ny, a.nz)
    if (mag > 1e-9) { outNrm[j * 3] = a.nx / mag; outNrm[j * 3 + 1] = a.ny / mag; outNrm[j * 3 + 2] = a.nz / mag }
    else { outNrm[j * 3 + 2] = 1 }
    wgt[j] = a.n
    j++
  }
  return { pos: outPos, nrm: outNrm, wgt }
}

// The box the solve spans: the per-axis `[lo, hi]` quantile range of a strided position
// sample, grown on every side by `margin` × the box's LARGEST side (a thin axis — a near-
// planar scene's z — must not get a margin of its own thinness, or its legitimate noise
// would fall outside). Returns { min:[3], max:[3] }.
export function robustBox(pos, { quantiles = [0.01, 0.99], margin = 0.25, sampleMax = 200000 } = {}) {
  const n = pos.length / 3
  const stride = Math.max(1, Math.ceil(n / sampleMax))
  const m = Math.ceil(n / stride)
  const lo = [0, 0, 0], hi = [0, 0, 0]
  const axis = new Float64Array(m)
  for (let d = 0; d < 3; d++) {
    let c = 0
    for (let i = 0; i < n; i += stride) axis[c++] = pos[i * 3 + d]
    const s = axis.subarray(0, c).sort()
    lo[d] = s[Math.min(c - 1, Math.floor(quantiles[0] * (c - 1)))]
    hi[d] = s[Math.min(c - 1, Math.ceil(quantiles[1] * (c - 1)))]
  }
  const grow = margin * Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])
  return { min: lo.map((v) => v - grow), max: hi.map((v) => v + grow) }
}

// Median nearest-neighbour distance over a strided sample of ≤ `sampleMax` points — the
// input spacing, for a cloud that has no fusion merge cell (an imported cloud). A chained
// voxel hash at a trial cell; the cell doubles until most samples find a neighbour within
// their 27-cell neighbourhood. Zero-distance duplicates are skipped. 0 for < 2 points.
export function estimatePointSpacing(pos, sampleMax = 20000) {
  const n = pos.length / 3
  if (n < 2) return 0
  let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2]
    if (x < minx) minx = x; if (x > maxx) maxx = x
    if (y < miny) miny = y; if (y > maxy) maxy = y
    if (z < minz) minz = z; if (z > maxz) maxz = z
  }
  // Surface assumption: N points over the two largest extents' area.
  const ext = [maxx - minx, maxy - miny, maxz - minz].sort((a, b) => b - a)
  let cell = Math.sqrt(Math.max(ext[0] * ext[1], ext[0] * ext[0] * 1e-12) / n)
  if (!(cell > 0)) return 0
  const stride = Math.max(1, Math.floor(n / sampleMax))
  for (let attempt = 0; attempt < 8; attempt++, cell *= 2) {
    const pack = packingFor(pos, cell)
    const inv = 1 / cell
    const head = new Map()
    const next = new Int32Array(n)
    const keyOf = (i) => cellKey(pack, Math.floor(pos[i * 3] * inv) - pack.bx,
      Math.floor(pos[i * 3 + 1] * inv) - pack.by, Math.floor(pos[i * 3 + 2] * inv) - pack.bz)
    for (let i = 0; i < n; i++) {
      const k = keyOf(i)
      const h = head.get(k)
      next[i] = h === undefined ? -1 : h
      head.set(k, i)
    }
    const found = []
    let sampled = 0
    for (let i = 0; i < n; i += stride) {
      sampled++
      const cx = Math.floor(pos[i * 3] * inv) - pack.bx
      const cy = Math.floor(pos[i * 3 + 1] * inv) - pack.by
      const cz = Math.floor(pos[i * 3 + 2] * inv) - pack.bz
      let best = Infinity
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const ix = cx + dx, iy = cy + dy, iz = cz + dz
        if (ix < 0 || iy < 0 || iz < 0 || ix >= pack.nx || iy >= pack.ny || iz >= pack.nz) continue
        for (let j = head.get(cellKey(pack, ix, iy, iz)) ?? -1; j >= 0; j = next[j]) {
          if (j === i) continue
          const ex = pos[j * 3] - pos[i * 3], ey = pos[j * 3 + 1] - pos[i * 3 + 1], ez = pos[j * 3 + 2] - pos[i * 3 + 2]
          const d2 = ex * ex + ey * ey + ez * ez
          if (d2 > 0 && d2 < best) best = d2
        }
      }
      // Only a neighbour within one cell is guaranteed to be the true nearest.
      if (best <= cell * cell) found.push(Math.sqrt(best))
    }
    if (found.length >= 0.8 * sampled) {
      found.sort((a, b) => a - b)
      return found[found.length >> 1]
    }
  }
  return cell
}

// The octree depth actually solved: the requested one, lowered when its leaves would be
// finer than `minLeafSpacings` input spacings (they resolve nothing and each extra level
// costs ~4× the solve), never below `minDepth` (or the request, if that is lower).
// Returns { depth, needed } — `needed` is the depth the spacing supports.
export function resolveMeshDepth(requested, extent, spacing, { minLeafSpacings = 1, minDepth = 5 } = {}) {
  const req = requested >>> 0
  if (!(extent > 0) || !(spacing > 0)) return { depth: req, needed: req }
  const needed = Math.max(1, Math.ceil(Math.log2(extent / (minLeafSpacings * spacing))))
  return { depth: Math.max(Math.min(req, needed), Math.min(req, minDepth)), needed }
}

// The crate's cleanup statistics (`MeshStats::to_vec` order) as named fields; null in,
// null out.
export function parseMeshStats(v) {
  if (!v || v.length < 11) return null
  return {
    extractedTris: v[0], distanceRemovedTris: v[1], densityRemovedTris: v[2],
    holesFilled: v[3], holeTris: v[4], components: v[5], componentsDropped: v[6],
    componentDroppedTris: v[7], keptTris: v[8], medianSupport: v[9], leafWidth: v[10],
  }
}

// A sensible max octree depth for a cloud of `pointCount` points. Surface points fill
// ≈ (2^depth)² occupied leaf cells (a surface is a 2-manifold), so useful depth ≈
// ½·log₂(N). Clamped to [6, 12]. The modal warns when the chosen depth exceeds this (a
// too-high depth mostly builds empty octree cells — slow and RAM-hungry with no detail
// gain); core only logs the recommendation, never overrides the user's choice.
export function recommendMeshDepth(pointCount) {
  if (!(pointCount > 0)) return 8
  return Math.min(12, Math.max(6, Math.round(0.5 * Math.log2(pointCount))))
}


const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
const fmt = (v) => (Math.abs(v) >= 1e-2 && Math.abs(v) < 1e4 ? v.toFixed(3) : v.toExponential(2))

// Generate a triangle mesh from a flat dense cloud via screened Poisson. `poissonFn` is
// the injected solver: `poissonFn({ pos, nrm, wgt, depth, screening, trimDist,
// densityRatio, holeAreaRatio, minComponentShare }) → { bytes, stats }` (the worker wires
// the staged wasm `PoissonMesher`; tests pass a stub). `dense` is { count, pos (Float32 or
// Float64, 3N), col?, nrm (3N) }. `settings.mergeCell` is the fusion merge cell — the
// cloud's sample spacing — when the cloud has one; otherwise it is estimated.
//
// Input conditioning, in order, each step logged with its inputs:
//   1. spacing (merge cell, or the median nearest-neighbour distance);
//   2. robust extent — stragglers far outside the object leave the solve, so they can't
//      coarsen every octree leaf;
//   3. depth — the requested depth, lowered when its leaves would be finer than the
//      spacing (a wasted ~4× per level);
//   4. stray-point pre-filter at two leaves (each lone stray costs ~125 octree nodes);
//   5. voxel subsample to ~one sample per leaf, carrying each sample's support count,
//      relative to a local origin (an imported cloud's projected coordinates would lose
//      decimetres in f32).
// The solve then trims unsupported surface, refills small holes and drops floating
// pieces (crates/mesh `MeshOptions`). Returns { nVerts, count /* triangles */, pos, idx,
// col, summary } — `pos` keeps the source's precision (Float64 in ⇒ Float64 out) and
// `summary` is the run record persisted with the mesh. Errors loudly if nrm is missing.
export function generateMesh(dense, poissonFn, settings = {}, onLog = () => {}) {
  if (!dense || !dense.pos || !(dense.count > 0)) throw new Error('generateMesh: empty dense cloud')
  if (!dense.nrm || dense.nrm.length < dense.count * 3) {
    throw new Error('generateMesh: dense cloud has no per-point normals — re-run Densify to compute normals')
  }
  const cfg = { ...MESH_DEFAULTS, ...MESH_TUNING, ...settings }
  const t0 = now()
  const n0 = dense.count

  // 1. Spacing.
  let spacing = settings.mergeCell > 0 ? settings.mergeCell : 0
  let spacingSource = 'merge cell'
  if (!spacing) {
    spacing = estimatePointSpacing(dense.pos, cfg.spacingSampleMax)
    spacingSource = 'estimated'
    onLog(`Mesh: input spacing ${fmt(spacing)} — median nearest-neighbour distance over ≤ `
      + `${cfg.spacingSampleMax.toLocaleString()} points (this cloud has no fusion merge cell)`, 'info', 'Products')
  }
  if (!(spacing > 0)) {
    spacing = 1
    spacingSource = 'fallback'
    onLog('Mesh: could not estimate the input spacing — using 1 world unit', 'warn', 'Products')
  }

  // 2. Robust extent.
  const box = robustBox(dense.pos, {
    quantiles: cfg.robustQuantiles, margin: cfg.robustMargin, sampleMax: cfg.robustSampleMax,
  })
  let src = { count: n0, pos: dense.pos, nrm: dense.nrm }
  {
    const keep = new Uint8Array(n0)
    let kept = 0
    for (let i = 0; i < n0; i++) {
      const x = dense.pos[i * 3], y = dense.pos[i * 3 + 1], z = dense.pos[i * 3 + 2]
      if (x >= box.min[0] && x <= box.max[0] && y >= box.min[1] && y <= box.max[1]
        && z >= box.min[2] && z <= box.max[2]) { keep[i] = 1; kept++ }
    }
    if (kept < n0) {
      const pos = new (dense.pos.constructor)(kept * 3)
      const nrm = new Float32Array(kept * 3)
      for (let i = 0, o = 0; i < n0; i++) {
        if (!keep[i]) continue
        for (let d = 0; d < 3; d++) { pos[o * 3 + d] = dense.pos[i * 3 + d]; nrm[o * 3 + d] = dense.nrm[i * 3 + d] }
        o++
      }
      src = { count: kept, pos, nrm }
      onLog(`Mesh: left ${(n0 - kept).toLocaleString()} far stragglers out of the solve — outside the `
        + `${cfg.robustQuantiles.map((q) => `${q * 100}`).join('–')} % box grown by ${cfg.robustMargin * 100} %`,
      'info', 'Products')
    }
  }
  const extent = maxExtent(src.pos)

  // 3. Depth.
  const { depth, needed } = resolveMeshDepth(cfg.depth, extent, spacing, cfg)
  if (depth < (cfg.depth >>> 0)) {
    onLog(`Mesh: octree depth ${cfg.depth} → ${depth} — leaves at depth ${cfg.depth} would be finer than the `
      + `input spacing (${fmt(extent)} extent / ${fmt(spacing)} spacing supports depth ${needed})`, 'info', 'Products')
  }
  const recDepth = recommendMeshDepth(n0)
  if (depth > recDepth) {
    onLog(`Mesh: depth ${depth} is high for ${n0.toLocaleString()} points `
      + `(recommended ≤ ${recDepth}) — the solve may be slow with little detail gain`, 'warn', 'Products')
  }
  const leaf = extent > 0 ? extent / Math.pow(2, depth) : 0

  // 4. Stray-point pre-filter.
  if (cfg.isolatedCellLeaves > 0 && leaf > 0 && src.count > 0) {
    const before = src.count
    const f = removeIsolated(src, { cell: leaf * cfg.isolatedCellLeaves })
    if (f.count < before && f.count > 0) {
      src = { count: f.count, pos: f.pos, nrm: f.nrm }
      onLog(`Mesh: removed ${(before - f.count).toLocaleString()} isolated points before the solve `
        + `(cells of ${cfg.isolatedCellLeaves} leaves, ${fmt(leaf * cfg.isolatedCellLeaves)})`, 'info', 'Products')
    }
  }

  // 5. Subsample with support weights, relative to a local origin.
  const origin = [0, 0, 0]
  {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < src.count; i++) {
      for (let d = 0; d < 3; d++) {
        const v = src.pos[i * 3 + d]
        if (v < mn[d]) mn[d] = v
        if (v > mx[d]) mx[d] = v
      }
    }
    for (let d = 0; d < 3; d++) origin[d] = (mn[d] + mx[d]) / 2
  }
  const inCell = meshInputCell(src.pos, depth, cfg.inputLeafCellsPerPoint)
  const thin = inCell > spacing * 1.01
  const sub = subsampleForMesh(src.pos, src.nrm, thin ? inCell : 0, origin)
  const inCount = sub.pos.length / 3
  if (thin && inCount < src.count) {
    onLog(`Mesh: subsampled input ${src.count.toLocaleString()} → ${inCount.toLocaleString()} points `
      + `(≈1 per leaf cell, ${fmt(inCell)}; each carries its point count as support) — colour still from the `
      + 'full cloud', 'info', 'Products')
  }

  // Cleanup parameters. The distance trim's proximity set IS the subsampled input, so its
  // radius scales with that input's spacing, not the dense GSD.
  const sampleCell = thin ? Math.max(spacing, inCell) : spacing
  const densityRatio = cfg.trimRatio?.[cfg.trim] ?? 0
  const holeAreaRatio = cfg.fillHoles && densityRatio > 0 ? cfg.holeAreaRatio : 0
  const minComponentShare = cfg.removeFloaters ? Math.max(0, cfg.minPiecePct) / 100 : 0
  const trimDist = cfg.distanceTrim > 0 ? cfg.distanceTrim * sampleCell : 0
  onLog(`Mesh: Poisson over ${inCount.toLocaleString()} points — depth ${depth} (leaf ${fmt(leaf)}), `
    + `screening ${cfg.screening}; trim ${cfg.trim}${densityRatio ? ` (support < ${densityRatio} × median)` : ''}, `
    + `fill holes ${holeAreaRatio ? `≤ ${holeAreaRatio * 100} % of the surrounding piece` : 'off'}, `
    + `floaters ${minComponentShare ? `< ${cfg.minPiecePct} % of the main support` : 'kept'}`
    + (trimDist ? `, distance trim ${fmt(trimDist)}` : ''), 'info', 'Products')

  const tSolve = now()
  const out = poissonFn({
    pos: sub.pos, nrm: sub.nrm, wgt: sub.wgt, depth, screening: cfg.screening,
    trimDist, densityRatio, holeAreaRatio, minComponentShare,
  })
  const { nVerts, nTris, pos: rel, idx } = parseMeshBuffer(out?.bytes ?? out)
  const stats = parseMeshStats(out?.stats)
  const solveMs = now() - tSolve
  onLog(`Mesh: solve produced ${nVerts.toLocaleString()} verts / ${nTris.toLocaleString()} tris in `
    + `${(solveMs / 1000).toFixed(1)}s`, nVerts > 0 ? 'success' : 'warn', 'Products')
  if (stats) {
    onLog(`Mesh: cleanup — extracted ${stats.extractedTris.toLocaleString()} tris; trimmed `
      + `${stats.densityRemovedTris.toLocaleString()} unsupported`
      + (stats.distanceRemovedTris ? ` + ${stats.distanceRemovedTris.toLocaleString()} far` : '')
      + `; refilled ${stats.holesFilled} hole(s) (${stats.holeTris.toLocaleString()} tris); dropped `
      + `${stats.componentsDropped} of ${stats.components} piece(s) (${stats.componentDroppedTris.toLocaleString()} tris)`,
    'info', 'Products')
  }

  const summary = {
    sourceCount: n0, inputCount: inCount, spacing, spacingSource,
    requestedDepth: cfg.depth >>> 0, depth, leaf, screening: cfg.screening,
    trim: cfg.trim, densityRatio, holeAreaRatio, minComponentShare, trimDist,
    stats, solveMs: Math.round(solveMs), totalMs: 0,
  }
  if (nVerts === 0 || nTris === 0) {
    summary.totalMs = Math.round(now() - t0)
    return { nVerts: 0, count: 0, pos: new Float32Array(0), idx: new Uint32Array(0), col: null, summary }
  }

  // Back to the source frame, at the source's precision.
  const pos = new (dense.pos instanceof Float64Array ? Float64Array : Float32Array)(nVerts * 3)
  for (let v = 0; v < nVerts; v++) {
    pos[v * 3] = rel[v * 3] + origin[0]; pos[v * 3 + 1] = rel[v * 3 + 1] + origin[1]; pos[v * 3 + 2] = rel[v * 3 + 2] + origin[2]
  }

  let col = null
  if (cfg.colorize && dense.col) {
    // Nearest dense point within ±1 merge cell first; a vertex further out (a refilled
    // hole, a smoothed crease) retries on a leaf-sized grid before falling back to gray.
    const fine = transferVertexColors(pos, dense, spacing, cfg)
    col = fine.col
    let misses = fine.misses
    if (misses && leaf > spacing) {
      const coarse = transferVertexColors(pos, dense, leaf, cfg)
      misses = 0
      for (let v = 0; v < nVerts; v++) {
        if (!fine.missed[v]) continue
        if (coarse.missed[v]) { misses++; continue }
        col[v * 3] = coarse.col[v * 3]; col[v * 3 + 1] = coarse.col[v * 3 + 1]; col[v * 3 + 2] = coarse.col[v * 3 + 2]
      }
    }
    onLog(`Mesh: coloured ${(nVerts - misses).toLocaleString()}/${nVerts.toLocaleString()} vertices from the dense cloud`
      + (misses ? ` (${misses.toLocaleString()} gray fallback — no dense point nearby)` : ''),
    misses ? 'debug' : 'info', 'Products')
  }

  summary.totalMs = Math.round(now() - t0)
  return { nVerts, count: nTris, pos, idx, col, summary }
}
