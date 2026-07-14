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

// Build a voxel hash of a flat dense cloud at `cell`: numeric packed key → index of a
// representative point in that cell (last writer wins; colour is averaged upstream by
// fusion, so any occupant is fine). Same floor(coord/cell) anchoring as the fusion
// accumulator. Keys are plain JS strings (correctness over speed; the cloud is one-time).
function buildColorGrid(pos, cell) {
  const inv = 1 / cell
  const grid = new Map()
  const n = pos.length / 3
  for (let i = 0; i < n; i++) {
    const kx = Math.floor(pos[i * 3] * inv)
    const ky = Math.floor(pos[i * 3 + 1] * inv)
    const kz = Math.floor(pos[i * 3 + 2] * inv)
    grid.set(`${kx},${ky},${kz}`, i)
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
  const grid = buildColorGrid(dpos, cell)
  const inv = 1 / cell
  let misses = 0
  for (let v = 0; v < nVerts; v++) {
    const vx = meshPos[v * 3], vy = meshPos[v * 3 + 1], vz = meshPos[v * 3 + 2]
    const cx = Math.floor(vx * inv), cy = Math.floor(vy * inv), cz = Math.floor(vz * inv)
    let bestI = -1, bestD2 = Infinity
    for (let dz = -searchRadius; dz <= searchRadius; dz++) {
      for (let dy = -searchRadius; dy <= searchRadius; dy++) {
        for (let dx = -searchRadius; dx <= searchRadius; dx++) {
          const idx = grid.get(`${cx+dx},${cy+dy},${cz+dz}`)
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
  const trimDist = cfg.trimFactor > 0 ? cfg.trimFactor * mergeCell : 0

  onLog(`Mesh: Poisson over ${dense.count} points — depth ${cfg.depth}, screening ${cfg.screening}, `
    + `trim ${trimDist > 0 ? `${trimDist.toExponential(2)} (${cfg.trimFactor}× cell)` : 'off'}`, 'info', 'Products')

  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now())
  const bytes = poissonFn(dense.pos, dense.nrm, cfg.depth >>> 0, cfg.screening, trimDist)
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
