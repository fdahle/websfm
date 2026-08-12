// Mesh generation (screened Poisson) — pure, no Vue/Pinia/OPFS/DOM. A products-stage
// concern like dem.js / ortho.js. Takes the flat dense cloud (pos/col/nrm), runs the
// wasm Poisson solver (injected — the worker wires the real one; tests pass a stub),
// parses its flat byte buffer, and transfers colour from the dense cloud onto the new
// Poisson vertices. Everything stays flat typed arrays (no per-vertex objects).

import { MESH_DEFAULTS } from '../defaults.user.js'
import { MESH_TUNING } from '../tuning.js'

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
// Returns { col:Uint8Array(3·nVerts), misses }.
export function transferVertexColors(meshPos, dense, cell, opts = {}) {
  const { searchRadius = MESH_TUNING.colorSearchRadius, grayFallback = MESH_TUNING.grayFallback } = opts
  const nVerts = meshPos.length / 3
  const col = new Uint8Array(nVerts * 3)
  const dpos = dense.pos
  const dcol = dense.col
  if (!dpos || !dcol || !(cell > 0)) {
    for (let i = 0; i < nVerts; i++) { col[i*3] = grayFallback[0]; col[i*3+1] = grayFallback[1]; col[i*3+2] = grayFallback[2] }
    return { col, misses: nVerts }
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
    else { col[o] = grayFallback[0]; col[o+1] = grayFallback[1]; col[o+2] = grayFallback[2]; misses++ }
  }
  return { col, misses }
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
// into one averaged position + renormalised averaged normal (matches the fusion merge).
// Colour is intentionally dropped — mesh vertex colour is transferred from the FULL dense
// cloud afterwards, so it isn't needed here. Returns { pos:Float32Array, nrm:Float32Array }.
// `cell <= 0` passes the input arrays through unchanged.
export function subsampleForMesh(pos, nrm, cell) {
  if (!(cell > 0)) return { pos, nrm }
  const inv = 1 / cell
  const n = pos.length / 3
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
    a.x += x; a.y += y; a.z += z
    a.nx += nrm[i * 3]; a.ny += nrm[i * 3 + 1]; a.nz += nrm[i * 3 + 2]
    a.n++
  }
  const m = cells.size
  const outPos = new Float32Array(m * 3)
  const outNrm = new Float32Array(m * 3)
  let j = 0
  for (const a of cells.values()) {
    const k = 1 / a.n
    outPos[j * 3] = a.x * k; outPos[j * 3 + 1] = a.y * k; outPos[j * 3 + 2] = a.z * k
    const mag = Math.hypot(a.nx, a.ny, a.nz)
    if (mag > 1e-9) { outNrm[j * 3] = a.nx / mag; outNrm[j * 3 + 1] = a.ny / mag; outNrm[j * 3 + 2] = a.nz / mag }
    else { outNrm[j * 3 + 2] = 1 }
    j++
  }
  return { pos: outPos, nrm: outNrm }
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

// Generate a triangle mesh from a flat dense cloud via screened Poisson. `poissonFn`
// is the wasm `poisson_mesh(pos, nrm, depth, screening, trimDist)` (injected). `dense`
// is { count, pos:Float32Array(3N), col?:Uint8Array(3N), nrm:Float32Array(3N) }. The
// merge cell (dense GSD) sizes both the trim radius and the colour-transfer grid.
// Returns { nVerts, count /* triangles */, pos, idx, col }. Errors loudly if nrm is
// missing — Poisson needs oriented normals; the user must re-run densify.
export function generateMesh(dense, poissonFn, settings = {}, onLog = () => {}) {
  if (!dense || !dense.pos || !(dense.count > 0)) throw new Error('generateMesh: empty dense cloud')
  if (!dense.nrm || dense.nrm.length < dense.count * 3) {
    throw new Error('generateMesh: dense cloud has no per-point normals — re-run Densify to compute normals')
  }
  const cfg = { ...MESH_DEFAULTS, ...MESH_TUNING, ...settings }
  const mergeCell = settings.mergeCell > 0 ? settings.mergeCell : 1
  const depth = cfg.depth >>> 0
  // Screened Poisson is closed before trimming. Keeping it untrimmed is the
  // reliable hole-fill mode; distance trimming is useful for removing unsupported
  // extrapolation, but can reopen boundaries and gaps.
  const trimDist = cfg.fillHoles ? 0 : (cfg.trimFactor > 0 ? cfg.trimFactor * mergeCell : 0)

  // Flag a depth that's high for this point count (mostly builds empty octree cells).
  const recDepth = recommendMeshDepth(dense.count)
  if (depth > recDepth) {
    onLog(`Mesh: depth ${depth} is high for ${dense.count.toLocaleString()} points `
      + `(recommended ≤ ${recDepth}) — the solve may be slow with little detail gain`, 'warn', 'Products')
  }

  // Downsample the Poisson INPUT to ~one point per octree leaf cell — the solve can't
  // resolve finer than that, so a denser cloud is wasted work. Only thins when it would
  // actually reduce the cloud (input denser than a leaf cell). Colour transfer below
  // still uses the full dense cloud, so this costs no quality.
  const inCell = meshInputCell(dense.pos, depth, cfg.inputLeafCellsPerPoint)
  let inPos = dense.pos, inNrm = dense.nrm
  if (inCell > mergeCell * 1.01) {
    const sub = subsampleForMesh(dense.pos, dense.nrm, inCell)
    if (sub.pos.length / 3 < dense.count) {
      inPos = sub.pos; inNrm = sub.nrm
      onLog(`Mesh: subsampled input ${dense.count.toLocaleString()} → ${(inPos.length / 3).toLocaleString()} points `
        + `(≈1 per leaf cell, ${inCell.toExponential(2)}) — colour still from the full cloud`, 'info', 'Products')
    }
  }
  const inCount = inPos.length / 3

  onLog(`Mesh: Poisson over ${inCount.toLocaleString()} points — depth ${depth}, screening ${cfg.screening}, `
    + `trim ${trimDist > 0 ? `${trimDist.toExponential(2)} (${cfg.trimFactor}× cell)` : 'off'}`, 'info', 'Products')

  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now())
  const bytes = poissonFn(inPos, inNrm, depth, cfg.screening, trimDist)
  const { nVerts, nTris, pos, idx } = parseMeshBuffer(bytes)
  const solveMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0
  onLog(`Mesh: solve produced ${nVerts} verts / ${nTris} tris in ${(solveMs / 1000).toFixed(1)}s`,
    nVerts > 0 ? 'success' : 'warn', 'Products')
  if (nVerts === 0 || nTris === 0) {
    return { nVerts: 0, count: 0, pos: new Float32Array(0), idx: new Uint32Array(0), col: null }
  }

  let col = null
  if (cfg.colorize && dense.col) {
    const { col: vcol, misses } = transferVertexColors(pos, dense, mergeCell, cfg)
    col = vcol
    onLog(`Mesh: coloured ${nVerts - misses}/${nVerts} vertices from the dense cloud`
      + (misses ? ` (${misses} gray fallback — no dense point within ${cfg.colorSearchRadius} cell(s))` : ''),
      misses ? 'debug' : 'info', 'Products')
  }

  return { nVerts, count: nTris, pos, idx, col }
}
