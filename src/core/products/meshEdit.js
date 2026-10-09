// Pure triangle-mesh editing: cleanup, hole filling, smoothing, crop, surface
// sampling and measurement. No Vue/Pinia/OPFS/DOM — plain data in, plain data out,
// side effects via an injected `onLog(message, level, 'Products')`.
//
// Scope: the app's `kind:'mesh'` cloud — `{ nVerts, count /* triangles */,
// pos:Float64Array|Float32Array(3·nVerts), idx:Uint32Array(3·count),
// col:Uint8Array(3·nVerts)|null }`. Every function returns a NEW mesh and never
// mutates its input, so the store can add the result alongside the source (the same
// non-destructive contract as cloudEdit.js). Output meshes always carry Float64 `pos`
// (survey coordinates stay exact), Uint32 `idx`, and `col` only when the input had it.
//
// Mesh-scale invariant, as for dense clouds: a Poisson mesh is millions of triangles,
// so nothing here materializes a per-vertex or per-triangle object, and every
// adjacency structure is a typed array built by counting sort (O(n)). Edge identity
// comes from a two-pass stable counting sort of half-edges by (lo, hi) vertex, not a
// Map keyed by edge.
//
// Precision: survey coordinates are ~1e6 (UTM / polar stereographic). Lengths,
// areas and volumes are computed from coordinate DIFFERENCES or relative to a local
// origin, never as products of absolute coordinates.

// ── Shared helpers ───────────────────────────────────────────────────────────

/** Triangle count of a mesh (tolerates a missing `count`). */
export function meshTriangleCount(mesh) {
  if (!mesh?.idx) return 0
  return mesh.count ?? Math.floor(mesh.idx.length / 3)
}

/** Vertex count of a mesh (tolerates a missing `nVerts`). */
export function meshVertexCount(mesh) {
  if (!mesh?.pos) return 0
  return mesh.nVerts ?? Math.floor(mesh.pos.length / 3)
}

function emptyMesh(hasCol) {
  return { nVerts: 0, count: 0, pos: new Float64Array(0), idx: new Uint32Array(0), col: hasCol ? new Uint8Array(0) : null }
}

/**
 * Copy of the mesh keeping only the triangles flagged in `keep` (`kept` = its
 * popcount). Vertices are carried over unchanged — orphans included — so indices need
 * no remap; `compactMesh` is the step that drops unreferenced vertices.
 */
function selectTriangles(mesh, keep, kept) {
  const nV = meshVertexCount(mesh), nT = meshTriangleCount(mesh)
  const pos = new Float64Array(nV * 3)
  pos.set(mesh.pos.subarray(0, nV * 3))
  const col = mesh.col ? mesh.col.slice(0, nV * 3) : null
  const src = mesh.idx
  const idx = new Uint32Array(kept * 3)
  let o = 0
  for (let t = 0; t < nT; t++) {
    if (!keep[t]) continue
    const s = t * 3
    idx[o] = src[s]; idx[o + 1] = src[s + 1]; idx[o + 2] = src[s + 2]
    o += 3
  }
  return { nVerts: nV, count: kept, pos, idx, col }
}

/** A triangle whose corner indices repeat or fall outside the vertex array. */
function badIndices(a, b, c, nV) {
  return a === b || b === c || a === c || !(a < nV) || !(b < nV) || !(c < nV)
}

// Union-find over vertex ids with path halving + union by rank. Typed arrays only.
function makeUnionFind(n) {
  const parent = new Int32Array(n)
  for (let i = 0; i < n; i++) parent[i] = i
  const rank = new Uint8Array(n)
  const find = (x) => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] }
    return x
  }
  const union = (a, b) => {
    let ra = find(a), rb = find(b)
    if (ra === rb) return
    if (rank[ra] < rank[rb]) { const t = ra; ra = rb; rb = t }
    parent[rb] = ra
    if (rank[ra] === rank[rb]) rank[ra]++
  }
  return { find, union }
}

/**
 * Connected components of the triangles, connectivity through shared vertices.
 * Returns { compOfTri:Int32Array(nT), compTris:Uint32Array(nComp), nComp }.
 * Triangles with out-of-range indices get component -1 and join nothing.
 */
function triangleComponents(mesh) {
  const nV = meshVertexCount(mesh), nT = meshTriangleCount(mesh)
  const idx = mesh.idx
  const uf = makeUnionFind(nV)
  for (let t = 0; t < nT; t++) {
    const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2]
    if (!(a < nV) || !(b < nV) || !(c < nV)) continue
    uf.union(a, b); uf.union(a, c)
  }
  const compOfRoot = new Int32Array(nV).fill(-1)
  const compOfTri = new Int32Array(nT)
  let nComp = 0
  for (let t = 0; t < nT; t++) {
    const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2]
    if (!(a < nV) || !(b < nV) || !(c < nV)) { compOfTri[t] = -1; continue }
    const r = uf.find(a)
    if (compOfRoot[r] < 0) compOfRoot[r] = nComp++
    compOfTri[t] = compOfRoot[r]
  }
  const compTris = new Uint32Array(nComp)
  for (let t = 0; t < nT; t++) if (compOfTri[t] >= 0) compTris[compOfTri[t]]++
  return { compOfTri, compTris, nComp }
}

// ── Topology ─────────────────────────────────────────────────────────────────

/**
 * Edge topology of a mesh. Half-edge h = 3·t + k runs from `idx[h]` to the next corner
 * of triangle t (`idx[3t + (k+1) % 3]`), i.e. in the triangle's winding direction.
 * Undirected edges are found by a stable two-pass counting sort of the half-edges by
 * (hi, then lo) vertex — O(n), no hashing — so a run of equal (lo, hi) is one edge.
 * Triangles with a repeated or out-of-range index contribute no edges at all.
 *
 * Returns typed arrays (E = unique undirected edges):
 *   - `edgeLo`/`edgeHi`  Uint32Array(E) — endpoints, lo < hi
 *   - `incidence`        Uint32Array(E) — incident half-edges (1 = boundary, 2 = manifold
 *                        interior, >2 = non-manifold)
 *   - `forward`          Uint32Array(E) — how many of those run lo→hi; a 2-incidence edge
 *                        is consistently oriented exactly when this is 1
 *   - `firstHalf`        Int32Array(E)  — one half-edge of the edge (THE half-edge for a
 *                        boundary edge, so its direction gives the boundary orientation)
 *   - `edgeOfHalf`       Int32Array(3·count) — edge id of each half-edge, or -1
 * plus the counts `edges`, `boundaryEdges`, `nonManifoldEdges`, `inconsistentEdges`.
 */
export function meshTopology(mesh) {
  const nV = meshVertexCount(mesh), nT = meshTriangleCount(mesh)
  const idx = mesh.idx
  const H = nT * 3
  const valid = new Uint8Array(nT)
  let nHalf = 0
  for (let t = 0; t < nT; t++) {
    if (badIndices(idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2], nV)) continue
    valid[t] = 1; nHalf += 3
  }
  const endOf = (h) => idx[h % 3 === 2 ? h - 2 : h + 1]

  // Pass 1: counting sort of valid half-edges by hi vertex.
  const bucket = new Uint32Array(nV + 1)
  for (let h = 0; h < H; h++) {
    if (!valid[(h / 3) | 0]) continue
    const a = idx[h], b = endOf(h)
    bucket[(a > b ? a : b) + 1]++
  }
  for (let v = 0; v < nV; v++) bucket[v + 1] += bucket[v]
  const byHi = new Int32Array(nHalf)
  for (let h = 0; h < H; h++) {
    if (!valid[(h / 3) | 0]) continue
    const a = idx[h], b = endOf(h)
    byHi[bucket[a > b ? a : b]++] = h
  }
  // Pass 2: stable counting sort by lo — within one lo bucket, hi stays ascending.
  bucket.fill(0)
  for (let i = 0; i < nHalf; i++) {
    const h = byHi[i], a = idx[h], b = endOf(h)
    bucket[(a < b ? a : b) + 1]++
  }
  for (let v = 0; v < nV; v++) bucket[v + 1] += bucket[v]
  const sorted = new Int32Array(nHalf)
  for (let i = 0; i < nHalf; i++) {
    const h = byHi[i], a = idx[h], b = endOf(h)
    sorted[bucket[a < b ? a : b]++] = h
  }

  // Scan runs of equal (lo, hi).
  const edgeOfHalf = new Int32Array(H).fill(-1)
  const loBuf = new Uint32Array(nHalf), hiBuf = new Uint32Array(nHalf)
  const incBuf = new Uint32Array(nHalf), fwdBuf = new Uint32Array(nHalf)
  const firstBuf = new Int32Array(nHalf)
  let E = -1, pLo = -1, pHi = -1
  for (let i = 0; i < nHalf; i++) {
    const h = sorted[i], a = idx[h], b = endOf(h)
    const lo = a < b ? a : b, hi = a < b ? b : a
    if (lo !== pLo || hi !== pHi) {
      E++; pLo = lo; pHi = hi
      loBuf[E] = lo; hiBuf[E] = hi; firstBuf[E] = h
    }
    incBuf[E]++
    if (a === lo) fwdBuf[E]++
    edgeOfHalf[h] = E
  }
  E++
  let boundaryEdges = 0, nonManifoldEdges = 0, inconsistentEdges = 0
  for (let e = 0; e < E; e++) {
    const k = incBuf[e]
    if (k === 1) boundaryEdges++
    else if (k > 2) nonManifoldEdges++
    else if (fwdBuf[e] !== 1) inconsistentEdges++
  }
  return {
    edges: E,
    edgeLo: loBuf.slice(0, E), edgeHi: hiBuf.slice(0, E),
    incidence: incBuf.slice(0, E), forward: fwdBuf.slice(0, E), firstHalf: firstBuf.slice(0, E),
    edgeOfHalf, boundaryEdges, nonManifoldEdges, inconsistentEdges,
  }
}

// ── Weld ─────────────────────────────────────────────────────────────────────

// Default weld tolerance, as two scale-free fractions; the smaller wins. The bbox
// term keeps a coarse mesh in a big extent from merging real vertices; the edge term
// keeps a fine mesh in a big extent (a detailed object in survey coordinates) safe.
// Both sit far below any real vertex spacing and far above the rounding an ASCII STL
// or a float32 round-trip leaves between copies of one corner.
export const WELD_REL_BBOX = 1e-6
export const WELD_REL_EDGE = 1e-2

// Upper bound on the edge-length sample the median is taken from: a typed-array sort
// of 1 M doubles is ~100 ms, and the median of a 1 M sample is exact to well under 1%.
const MEDIAN_SAMPLE = 1 << 20

/**
 * Median length of the mesh's edges, from a deterministic strided sample of at most
 * ~1 M half-edges. Triangles with bad indices are skipped; 0 when there are none.
 */
function medianEdgeLength(mesh) {
  const nV = meshVertexCount(mesh), nT = meshTriangleCount(mesh)
  const { pos, idx } = mesh
  const H = nT * 3
  // Deterministic strided sample; a stride divisible by 3 would only see one corner.
  let stride = Math.max(1, Math.ceil(H / MEDIAN_SAMPLE))
  if (stride > 1 && stride % 3 === 0) stride++
  const sample = new Float64Array(Math.ceil(H / stride))
  let m = 0
  for (let h = 0; h < H; h += stride) {
    const t = (h / 3) | 0
    if (badIndices(idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2], nV)) continue
    const a = idx[h], b = idx[h % 3 === 2 ? h - 2 : h + 1]
    const dx = pos[b * 3] - pos[a * 3], dy = pos[b * 3 + 1] - pos[a * 3 + 1], dz = pos[b * 3 + 2] - pos[a * 3 + 2]
    const d2 = dx * dx + dy * dy + dz * dz
    if (d2 === d2) sample[m++] = d2 // NaN-free
  }
  const s = sample.subarray(0, m).sort()
  return m ? Math.sqrt(s[m >> 1]) : 0
}

function weldStep(mesh, { epsilon = null, relBbox = WELD_REL_BBOX, relEdge = WELD_REL_EDGE } = {}) {
  const nV = meshVertexCount(mesh), nT = meshTriangleCount(mesh)
  const { pos, idx } = mesh
  const hasCol = !!mesh.col
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let v = 0; v < nV; v++) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2]
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
  }
  const diagonal = minX <= maxX ? Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) : 0
  const medianEdge = medianEdgeLength(mesh)
  let eps, epsilonSource = 'auto'
  if (epsilon != null && epsilon >= 0) { eps = epsilon; epsilonSource = 'given' }
  else {
    const byBox = relBbox * diagonal
    // Zero-length edges are exactly the corners a weld is for: an all-duplicate median
    // says nothing about spacing, so the bbox term alone decides then.
    eps = medianEdge > 0 ? Math.min(byBox, relEdge * medianEdge) : byBox
  }
  // Grid cell ≥ ε, so every vertex within ε of a point lies in its 27-cell block. With
  // ε = 0 the weld is exact-coincidence only; any positive cell then works.
  const cell = eps > 0 ? eps : (diagonal > 0 ? diagonal : 1)
  const eps2 = eps * eps

  // Chained spatial hash over REPRESENTATIVE vertices only (typed arrays, no Map).
  // A collision between two cells costs a distance test, never a wrong merge.
  let size = 1
  while (size < nV * 2) size <<= 1
  const mask = size - 1
  const head = new Int32Array(size).fill(-1)
  const next = new Int32Array(nV)
  const hash = (ix, iy, iz) => (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) & mask
  // Representatives: their own ORIGINAL position (never averaged — exact coordinates
  // stay exact), new ids in first-appearance order so the result diffs to its source.
  const newId = new Int32Array(nV)
  const repOf = new Int32Array(nV) // new id → original vertex index
  let m = 0
  for (let v = 0; v < nV; v++) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2]
    const fx = (x - minX) / cell, fy = (y - minY) / cell, fz = (z - minZ) / cell
    if (!(Number.isFinite(fx) && Number.isFinite(fy) && Number.isFinite(fz))) {
      newId[v] = m; repOf[m++] = v // a NaN corner welds to nothing
      continue
    }
    const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz)
    let best = -1, bestD2 = Infinity
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      for (let r = head[hash(ix + dx, iy + dy, iz + dz)]; r >= 0; r = next[r]) {
        const o = repOf[r] * 3
        const ex = pos[o] - x, ey = pos[o + 1] - y, ez = pos[o + 2] - z
        const d2 = ex * ex + ey * ey + ez * ez
        // Nearest representative; ties go to the earlier one (lower new id).
        if (d2 <= eps2 && (d2 < bestD2 || (d2 === bestD2 && r < best))) { best = r; bestD2 = d2 }
      }
    }
    if (best >= 0) { newId[v] = best; continue }
    newId[v] = m; repOf[m] = v
    const h = hash(ix, iy, iz)
    next[m] = head[h]; head[h] = m
    m++
  }

  const outPos = new Float64Array(m * 3)
  const outCol = hasCol ? new Uint8Array(m * 3) : null
  for (let r = 0; r < m; r++) {
    const o = repOf[r] * 3, d = r * 3
    outPos[d] = pos[o]; outPos[d + 1] = pos[o + 1]; outPos[d + 2] = pos[o + 2]
    if (outCol) { outCol[d] = mesh.col[o]; outCol[d + 1] = mesh.col[o + 1]; outCol[d + 2] = mesh.col[o + 2] }
  }
  const outIdx = new Uint32Array(nT * 3)
  let collapsed = 0
  for (let t = 0; t < nT; t++) {
    const s = t * 3
    for (let k = 0; k < 3; k++) {
      const v = idx[s + k]
      // An out-of-range index stays out of range (still "bad" downstream), never aliased.
      outIdx[s + k] = v < nV ? newId[v] : m + (v - nV)
    }
    if (!badIndices(idx[s], idx[s + 1], idx[s + 2], nV)
        && badIndices(outIdx[s], outIdx[s + 1], outIdx[s + 2], m)) collapsed++
  }
  return {
    mesh: { nVerts: m, count: nT, pos: outPos, idx: outIdx, col: outCol },
    merged: nV - m, collapsedTriangles: collapsed, epsilon: eps, epsilonSource, diagonal, medianEdge,
  }
}

const weldLine = (r, opts) => `ε ${r.epsilon.toPrecision(3)} (`
  + (r.epsilonSource === 'given' ? 'given' : `min of ${opts.relBbox ?? WELD_REL_BBOX} × bbox diagonal`)
  + ` ${r.diagonal.toPrecision(4)}; ${r.epsilonSource === 'given' ? 'median edge' : `${opts.relEdge ?? WELD_REL_EDGE} × median edge`}`
  + ` ${r.medianEdge.toPrecision(4)}) → merged ${r.merged.toLocaleString()} duplicate vertices`
  + (r.collapsedTriangles ? `, ${r.collapsedTriangles.toLocaleString()} triangles collapsed` : '')

/**
 * Merge vertices closer than ε, so a mesh whose triangles each carry their own
 * corners (STL, many OBJ/PLY exporters) gets shared vertices — the topology every
 * other step here reads. Without it every edge counts as a boundary.
 *
 * ε defaults to min(WELD_REL_BBOX × bbox diagonal, WELD_REL_EDGE × median edge
 * length), both scale-free; `opts.epsilon` overrides it (0 = exact coincidence only).
 * Each vertex joins the nearest representative within ε (vertices are visited in
 * order, the first of a cluster becomes its representative and keeps its own position
 * and colour — never an average, so survey coordinates stay exact). Distance is to
 * the representative, never chained, so a row of points ε apart does not zip up.
 * Chained spatial hash on a grid of cell ε, typed arrays only — O(n).
 * Triangles whose corners collapse together are kept (compact drops them).
 *
 * Returns `{ mesh, merged, collapsedTriangles, epsilon, epsilonSource, diagonal, medianEdge }`
 * (`epsilonSource` 'auto' | 'given').
 * opts: { epsilon?, relBbox = WELD_REL_BBOX, relEdge = WELD_REL_EDGE }
 */
export function weldVertices(mesh, opts = {}, onLog) {
  const r = weldStep(mesh, opts)
  onLog?.(`Mesh weld: ${weldLine(r, opts)}`, 'info', 'Products')
  return r
}

// ── Compact ──────────────────────────────────────────────────────────────────

// A triangle counts as zero-area when |cross| ≤ ZERO_AREA_REL · (longest edge)², i.e.
// collinear to ~1e-12 of its own scale (scale-free, so it works at any unit).
const ZERO_AREA_REL = 1e-12

function compactStep(mesh) {
  const nV = meshVertexCount(mesh), nT = meshTriangleCount(mesh)
  const hasCol = !!mesh.col
  if (!nT) return { mesh: emptyMesh(hasCol), removedTriangles: 0, removedVertices: nV }
  const { pos, idx } = mesh
  const keep = new Uint8Array(nT)
  const remap = new Int32Array(nV).fill(-1)
  let kept = 0
  for (let t = 0; t < nT; t++) {
    const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2]
    if (badIndices(a, b, c, nV)) continue
    const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2]
    const vx = pos[c * 3] - pos[a * 3], vy = pos[c * 3 + 1] - pos[a * 3 + 1], vz = pos[c * 3 + 2] - pos[a * 3 + 2]
    const wx = vx - ux, wy = vy - uy, wz = vz - uz
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx
    const cross2 = cx * cx + cy * cy + cz * cz
    const maxE2 = Math.max(ux * ux + uy * uy + uz * uz, vx * vx + vy * vy + vz * vz, wx * wx + wy * wy + wz * wz)
    if (!(cross2 > ZERO_AREA_REL * ZERO_AREA_REL * maxE2 * maxE2)) continue // also rejects NaN
    keep[t] = 1; kept++
    remap[a] = 0; remap[b] = 0; remap[c] = 0
  }
  // New ids in original vertex order, so a compacted mesh stays diffable to its source.
  let m = 0
  for (let v = 0; v < nV; v++) if (remap[v] === 0) remap[v] = m++
  const outPos = new Float64Array(m * 3)
  const outCol = hasCol ? new Uint8Array(m * 3) : null
  for (let v = 0; v < nV; v++) {
    const d = remap[v]
    if (d < 0) continue
    outPos[d * 3] = pos[v * 3]; outPos[d * 3 + 1] = pos[v * 3 + 1]; outPos[d * 3 + 2] = pos[v * 3 + 2]
    if (outCol) { outCol[d * 3] = mesh.col[v * 3]; outCol[d * 3 + 1] = mesh.col[v * 3 + 1]; outCol[d * 3 + 2] = mesh.col[v * 3 + 2] }
  }
  const outIdx = new Uint32Array(kept * 3)
  let o = 0
  for (let t = 0; t < nT; t++) {
    if (!keep[t]) continue
    outIdx[o++] = remap[idx[t * 3]]; outIdx[o++] = remap[idx[t * 3 + 1]]; outIdx[o++] = remap[idx[t * 3 + 2]]
  }
  return {
    mesh: { nVerts: m, count: kept, pos: outPos, idx: outIdx, col: outCol },
    removedTriangles: nT - kept, removedVertices: nV - m,
  }
}

/**
 * Drop degenerate triangles (a repeated or out-of-range vertex index, or zero area)
 * and every vertex no remaining triangle references; indices are remapped, surviving
 * vertices keep their relative order. Does NOT weld coincident vertices.
 */
export function compactMesh(mesh, onLog) {
  const r = compactStep(mesh)
  onLog?.(`Mesh compact: removed ${r.removedTriangles.toLocaleString()} degenerate triangles, `
    + `${r.removedVertices.toLocaleString()} unreferenced vertices`, 'info', 'Products')
  return r.mesh
}

// ── Small components ─────────────────────────────────────────────────────────

function componentsStep(mesh, { minTriangles = 0, minFraction = 0 } = {}) {
  const nT = meshTriangleCount(mesh)
  if (!nT) return { mesh: selectTriangles(mesh, new Uint8Array(0), 0), components: 0, removedComponents: 0, removedTriangles: 0, threshold: 0 }
  const { compOfTri, compTris, nComp } = triangleComponents(mesh)
  let largest = 0
  for (let c = 0; c < nComp; c++) if (compTris[c] > largest) largest = compTris[c]
  const threshold = Math.max(Number(minTriangles) || 0, (Number(minFraction) || 0) * largest)
  const keepComp = new Uint8Array(nComp)
  let removedComponents = 0
  for (let c = 0; c < nComp; c++) {
    if (compTris[c] >= threshold) keepComp[c] = 1
    else removedComponents++
  }
  const keep = new Uint8Array(nT)
  let kept = 0
  for (let t = 0; t < nT; t++) {
    const c = compOfTri[t]
    if (c >= 0 && keepComp[c]) { keep[t] = 1; kept++ }
  }
  return { mesh: selectTriangles(mesh, keep, kept), components: nComp, removedComponents, removedTriangles: nT - kept, threshold }
}

/**
 * Remove connected components (connectivity through shared vertices) with fewer than
 * `max(minTriangles, minFraction × largest component's triangles)` triangles — the
 * floating specks Poisson inflates around stray samples. Vertices are kept (run
 * `compactMesh` to drop the orphans).
 *
 * opts: { minTriangles = 0, minFraction = 0 }
 */
export function removeSmallComponents(mesh, opts = {}, onLog) {
  const r = componentsStep(mesh, opts)
  onLog?.(`Mesh components: ${r.components.toLocaleString()} found, threshold ${Math.ceil(r.threshold).toLocaleString()} triangles → `
    + `removed ${r.removedComponents.toLocaleString()} components (${r.removedTriangles.toLocaleString()} triangles)`, 'info', 'Products')
  return r.mesh
}

// ── Long edges ───────────────────────────────────────────────────────────────

function longEdgesStep(mesh, { maxEdgeFactor = 4 } = {}) {
  const nV = meshVertexCount(mesh), nT = meshTriangleCount(mesh)
  const { pos, idx } = mesh
  const len2 = (h) => {
    const a = idx[h], b = idx[h % 3 === 2 ? h - 2 : h + 1]
    const dx = pos[b * 3] - pos[a * 3], dy = pos[b * 3 + 1] - pos[a * 3 + 1], dz = pos[b * 3 + 2] - pos[a * 3 + 2]
    return dx * dx + dy * dy + dz * dz
  }
  const validTri = (t) => !badIndices(idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2], nV)
  const median = medianEdgeLength(mesh)
  const median2 = median * median
  if (!(median2 > 0) || !(maxEdgeFactor > 0)) {
    return { mesh: selectTriangles(mesh, new Uint8Array(nT).fill(1), nT), removedTriangles: 0, median, limit: Infinity }
  }
  const limit2 = maxEdgeFactor * maxEdgeFactor * median2
  const keep = new Uint8Array(nT)
  let kept = 0
  for (let t = 0; t < nT; t++) {
    if (validTri(t) && (len2(t * 3) > limit2 || len2(t * 3 + 1) > limit2 || len2(t * 3 + 2) > limit2)) continue
    keep[t] = 1; kept++
  }
  return { mesh: selectTriangles(mesh, keep, kept), removedTriangles: nT - kept, median, limit: Math.sqrt(limit2) }
}

/**
 * Drop triangles with any edge longer than `maxEdgeFactor × median edge length` —
 * the stretched "bridge" triangles screened Poisson spans across data gaps. The
 * median comes from a deterministic sample of at most ~1 M half-edges. A degenerate
 * (all zero-length) mesh or `maxEdgeFactor <= 0` removes nothing.
 *
 * opts: { maxEdgeFactor = 4 }
 */
export function removeLongEdges(mesh, opts = {}, onLog) {
  const r = longEdgesStep(mesh, opts)
  onLog?.(`Mesh long edges: median edge ${r.median.toPrecision(4)}, limit ${r.limit.toPrecision(4)} → `
    + `removed ${r.removedTriangles.toLocaleString()} triangles`, 'info', 'Products')
  return r.mesh
}

// ── Hole filling ─────────────────────────────────────────────────────────────

function holesStep(mesh, { maxHoleEdges = 64 } = {}) {
  const nV = meshVertexCount(mesh), nT = meshTriangleCount(mesh)
  const { pos, idx } = mesh
  const limit = Number.isFinite(maxHoleEdges) && maxHoleEdges > 0 ? maxHoleEdges : Infinity
  const topo = meshTopology(mesh)
  const { edgeOfHalf, incidence } = topo
  const H = nT * 3
  const endOf = (h) => idx[h % 3 === 2 ? h - 2 : h + 1]

  // Boundary half-edges, indexed by their start vertex (CSR), plus in/out degrees.
  const outCnt = new Uint32Array(nV), inCnt = new Uint32Array(nV)
  let nb = 0
  for (let h = 0; h < H; h++) {
    const e = edgeOfHalf[h]
    if (e < 0 || incidence[e] !== 1) continue
    outCnt[idx[h]]++; inCnt[endOf(h)]++; nb++
  }
  const outStart = new Uint32Array(nV + 1)
  for (let v = 0; v < nV; v++) outStart[v + 1] = outStart[v] + outCnt[v]
  const fillAt = outStart.slice(0, nV)
  const outList = new Int32Array(nb)
  for (let h = 0; h < H; h++) {
    const e = edgeOfHalf[h]
    if (e < 0 || incidence[e] !== 1) continue
    outList[fillAt[idx[h]]++] = h
  }

  // Worst case: every boundary edge gets one fan triangle; one centroid per loop (≥ 4 edges).
  const addIdx = new Uint32Array(nb * 3)
  const addPos = new Float64Array(Math.floor(nb / 4) * 3 + 3)
  const hasCol = !!mesh.col
  const addCol = hasCol ? new Uint8Array(addPos.length) : null
  const loopV = new Uint32Array(nb), loopH = new Int32Array(nb)
  const visited = new Uint8Array(H)
  let nAddT = 0, nAddV = 0, filled = 0, skipped = 0, tooLarge = 0

  for (let i = 0; i < nb; i++) {
    const h0 = outList[i]
    if (visited[h0]) continue
    // Walk the chain in half-edge direction. A vertex with boundary in/out degree ≠ 1
    // (a bowtie / non-manifold vertex) makes the continuation ambiguous: abandon it.
    let h = h0, len = 0, ok = true
    for (;;) {
      visited[h] = 1
      loopV[len] = idx[h]; loopH[len] = h; len++
      const v = endOf(h)
      if (outCnt[v] !== 1 || inCnt[v] !== 1) { ok = false; break }
      h = outList[outStart[v]]
      if (h === h0) break
      if (visited[h]) { ok = false; break }
    }
    if (!ok) { skipped++; continue }
    if (len > limit) { tooLarge++; continue }
    // A lone triangle's own rim is a 3-loop; capping it would glue a back face onto it.
    if (len === 3 && ((loopH[0] / 3) | 0) === ((loopH[1] / 3) | 0) && ((loopH[1] / 3) | 0) === ((loopH[2] / 3) | 0)) {
      skipped++; continue
    }
    // The existing triangles run each boundary edge a→b, so the cap must run it b→a.
    if (len === 3) {
      addIdx[nAddT * 3] = loopV[0]; addIdx[nAddT * 3 + 1] = loopV[2]; addIdx[nAddT * 3 + 2] = loopV[1]
      nAddT++
    } else {
      // Centroid fan, centroid accumulated relative to the first loop vertex.
      const o = loopV[0] * 3
      let sx = 0, sy = 0, sz = 0, r = 0, g = 0, b = 0
      for (let k = 0; k < len; k++) {
        const p = loopV[k] * 3
        sx += pos[p] - pos[o]; sy += pos[p + 1] - pos[o + 1]; sz += pos[p + 2] - pos[o + 2]
        if (hasCol) { r += mesh.col[p]; g += mesh.col[p + 1]; b += mesh.col[p + 2] }
      }
      const d = nAddV * 3
      addPos[d] = pos[o] + sx / len; addPos[d + 1] = pos[o + 1] + sy / len; addPos[d + 2] = pos[o + 2] + sz / len
      if (hasCol) { addCol[d] = Math.round(r / len); addCol[d + 1] = Math.round(g / len); addCol[d + 2] = Math.round(b / len) }
      const c = nV + nAddV
      nAddV++
      for (let k = 0; k < len; k++) {
        const a = loopV[k], bb = loopV[k + 1 === len ? 0 : k + 1]
        addIdx[nAddT * 3] = bb; addIdx[nAddT * 3 + 1] = a; addIdx[nAddT * 3 + 2] = c
        nAddT++
      }
    }
    filled++
  }

  const outPos = new Float64Array((nV + nAddV) * 3)
  outPos.set(pos.subarray(0, nV * 3))
  outPos.set(addPos.subarray(0, nAddV * 3), nV * 3)
  let outCol = null
  if (hasCol) {
    outCol = new Uint8Array((nV + nAddV) * 3)
    outCol.set(mesh.col.subarray(0, nV * 3))
    outCol.set(addCol.subarray(0, nAddV * 3), nV * 3)
  }
  const outIdx = new Uint32Array((nT + nAddT) * 3)
  outIdx.set(idx.subarray(0, nT * 3))
  outIdx.set(addIdx.subarray(0, nAddT * 3), nT * 3)
  return {
    mesh: { nVerts: nV + nAddV, count: nT + nAddT, pos: outPos, idx: outIdx, col: outCol },
    filled, skipped, tooLarge, addedTriangles: nAddT, addedVertices: nAddV,
  }
}

/**
 * Close boundary loops. Boundary edges (incidence 1) are chained into closed loops by
 * following each one's half-edge direction, which is the adjacent triangle's winding;
 * the cap runs every loop edge the OTHER way, so the fill's normals agree with the
 * surface and the seam is a proper 2-manifold edge. A 3-edge loop gets one triangle;
 * a longer loop gets one centroid vertex (colour = mean of the loop's colours) and a
 * fan — robust and watertight, though a strongly non-convex hole can fold.
 *
 * Note the outer rim of an open surface is itself a loop: `maxHoleEdges` is what keeps
 * a terrain mesh open. 0 or Infinity fills every loop.
 *
 * Returns `{ mesh, filled, skipped, tooLarge, addedTriangles, addedVertices }`:
 *   - `skipped`  boundary chains abandoned because they pass through a vertex with
 *                more than one boundary edge in or out (a bowtie / non-manifold vertex
 *                — no unambiguous chaining), plus lone triangles (a 3-loop that IS a
 *                triangle; capping would glue a back face onto it). One tangled region
 *                may count more than once.
 *   - `tooLarge` closed loops with more than `maxHoleEdges` edges, left open.
 *
 * opts: { maxHoleEdges = 64 }
 */
export function fillHoles(mesh, opts = {}, onLog) {
  const r = holesStep(mesh, opts)
  onLog?.(`Mesh holes: filled ${r.filled.toLocaleString()} (+${r.addedTriangles.toLocaleString()} triangles), `
    + `left ${r.tooLarge.toLocaleString()} above ${opts.maxHoleEdges ?? 64} edges, `
    + `skipped ${r.skipped.toLocaleString()} non-manifold chains`, r.skipped ? 'warn' : 'info', 'Products')
  return r
}

// ── Clean pipeline ───────────────────────────────────────────────────────────

const CLEAN_STEPS = ['weld', 'components', 'longEdges', 'holes', 'compact']

/**
 * Cleanup dispatch — one entry point for the worker op and the modal. Unlike
 * `filterCloud`, the ORDER is fixed regardless of the `methods` list:
 * weld → components → longEdges → holes → compact. Welding first gives an unwelded
 * import (STL: every triangle its own corners) the shared vertices every later step
 * reads — without it each triangle is its own piece and every edge a boundary.
 * Removing bridges before filling means a gap Poisson bridged becomes a hole the
 * filler can judge by size; compacting last drops every vertex the earlier steps
 * orphaned (and the triangles a weld collapsed).
 *
 * Returns `{ mesh, stats }`, stats = { inputTriangles, outputTriangles, outputVertices,
 *   weld?: { merged, collapsedTriangles, epsilon, epsilonSource, diagonal, medianEdge },
 *   components?: { components, removedComponents, removedTriangles, threshold },
 *   longEdges?: { removedTriangles, median, limit },
 *   holes?: { filled, skipped, tooLarge, addedTriangles, addedVertices },
 *   compact?: { removedTriangles, removedVertices } } — a key only when its step ran.
 *
 * opts: { methods = ['weld','components','longEdges','holes','compact'], weldEpsilon?,
 *         minTriangles, minFraction, maxEdgeFactor, maxHoleEdges }
 */
export function cleanMesh(mesh, opts = {}, onLog) {
  const methods = new Set(opts.methods ?? CLEAN_STEPS)
  for (const m of methods) {
    if (!CLEAN_STEPS.includes(m))
      onLog?.(`Mesh clean: unknown method "${m}" — skipped`, 'warn', 'Products')
  }
  const stats = { inputTriangles: meshTriangleCount(mesh) }
  let out = mesh
  if (methods.has('weld')) {
    const r = weldStep(out, { epsilon: opts.weldEpsilon ?? null })
    out = r.mesh
    stats.weld = { merged: r.merged, collapsedTriangles: r.collapsedTriangles, epsilon: r.epsilon,
      epsilonSource: r.epsilonSource, diagonal: r.diagonal, medianEdge: r.medianEdge }
    onLog?.(`Mesh clean (weld): ${weldLine(r, {})}`, 'info', 'Products')
  }
  if (methods.has('components')) {
    const r = componentsStep(out, { minTriangles: opts.minTriangles, minFraction: opts.minFraction })
    out = r.mesh
    stats.components = { components: r.components, removedComponents: r.removedComponents, removedTriangles: r.removedTriangles, threshold: r.threshold }
    onLog?.(`Mesh clean (components): removed ${r.removedComponents.toLocaleString()} of ${r.components.toLocaleString()} components `
      + `(${r.removedTriangles.toLocaleString()} triangles, threshold ${Math.ceil(r.threshold).toLocaleString()})`, 'info', 'Products')
  }
  if (methods.has('longEdges')) {
    const r = longEdgesStep(out, { maxEdgeFactor: opts.maxEdgeFactor ?? 4 })
    out = r.mesh
    stats.longEdges = { removedTriangles: r.removedTriangles, median: r.median, limit: r.limit }
    onLog?.(`Mesh clean (long edges): median ${r.median.toPrecision(4)}, limit ${r.limit.toPrecision(4)} → `
      + `removed ${r.removedTriangles.toLocaleString()} triangles`, 'info', 'Products')
  }
  if (methods.has('holes')) {
    const r = holesStep(out, { maxHoleEdges: opts.maxHoleEdges ?? 64 })
    out = r.mesh
    stats.holes = { filled: r.filled, skipped: r.skipped, tooLarge: r.tooLarge, addedTriangles: r.addedTriangles, addedVertices: r.addedVertices }
    onLog?.(`Mesh clean (holes): filled ${r.filled.toLocaleString()}, left ${r.tooLarge.toLocaleString()} too large, `
      + `skipped ${r.skipped.toLocaleString()} non-manifold chains`, r.skipped ? 'warn' : 'info', 'Products')
  }
  if (methods.has('compact')) {
    const r = compactStep(out)
    out = r.mesh
    stats.compact = { removedTriangles: r.removedTriangles, removedVertices: r.removedVertices }
    onLog?.(`Mesh clean (compact): removed ${r.removedTriangles.toLocaleString()} degenerate triangles, `
      + `${r.removedVertices.toLocaleString()} unreferenced vertices`, 'info', 'Products')
  }
  // Never hand back the input itself — it would alias the source's buffers.
  if (out === mesh) out = selectTriangles(mesh, new Uint8Array(meshTriangleCount(mesh)).fill(1), meshTriangleCount(mesh))
  stats.outputTriangles = out.count
  stats.outputVertices = out.nVerts
  onLog?.(`Mesh clean: ${stats.inputTriangles.toLocaleString()} → ${out.count.toLocaleString()} triangles`, 'success', 'Products')
  return { mesh: out, stats }
}

// ── Smoothing ────────────────────────────────────────────────────────────────

/**
 * Taubin λ/μ smoothing (Taubin 1995): alternating a shrinking Laplacian step (λ > 0)
 * with an inflating one (μ < −λ), a low-pass filter that removes surface noise without
 * the volume loss of plain Laplacian smoothing. One iteration = one λ pass + one μ pass.
 * The Laplacian is the uniform umbrella operator over the vertex one-ring (CSR from
 * the unique edges). With `fixBoundary`, every vertex on a boundary or non-manifold
 * edge stays put, so an open terrain mesh keeps its rim. Topology and colour unchanged.
 *
 * opts: { iterations = 10, lambda = 0.5, mu = -0.53, fixBoundary = true }
 */
export function taubinSmooth(mesh, { iterations = 10, lambda = 0.5, mu = -0.53, fixBoundary = true } = {}, onLog) {
  const nV = meshVertexCount(mesh), nT = meshTriangleCount(mesh)
  const out = selectTriangles(mesh, new Uint8Array(nT).fill(1), nT)
  const iters = Math.max(0, Math.floor(iterations) || 0)
  if (!nV || !nT || !iters) return out
  const topo = meshTopology(mesh)
  const { edges: E, edgeLo, edgeHi, incidence } = topo
  const start = new Uint32Array(nV + 1)
  for (let e = 0; e < E; e++) { start[edgeLo[e] + 1]++; start[edgeHi[e] + 1]++ }
  for (let v = 0; v < nV; v++) start[v + 1] += start[v]
  const fillAt = start.slice(0, nV)
  const nbr = new Uint32Array(E * 2)
  const fixed = new Uint8Array(nV)
  for (let e = 0; e < E; e++) {
    const a = edgeLo[e], b = edgeHi[e]
    nbr[fillAt[a]++] = b; nbr[fillAt[b]++] = a
    if (fixBoundary && incidence[e] !== 2) { fixed[a] = 1; fixed[b] = 1 }
  }
  // Work relative to the first vertex: averaging ~1e6 coordinates is exact enough in
  // Float64, but the subtraction keeps the per-pass deltas at full relative precision.
  const ox = out.pos[0], oy = out.pos[1], oz = out.pos[2]
  let cur = new Float64Array(nV * 3)
  for (let v = 0; v < nV; v++) {
    cur[v * 3] = out.pos[v * 3] - ox; cur[v * 3 + 1] = out.pos[v * 3 + 1] - oy; cur[v * 3 + 2] = out.pos[v * 3 + 2] - oz
  }
  let nxt = new Float64Array(nV * 3)
  for (let pass = 0; pass < iters * 2; pass++) {
    const f = pass % 2 === 0 ? lambda : mu
    for (let v = 0; v < nV; v++) {
      const s = start[v], e = start[v + 1], p = v * 3
      if (e === s || fixed[v]) { nxt[p] = cur[p]; nxt[p + 1] = cur[p + 1]; nxt[p + 2] = cur[p + 2]; continue }
      let mx = 0, my = 0, mz = 0
      for (let k = s; k < e; k++) { const q = nbr[k] * 3; mx += cur[q]; my += cur[q + 1]; mz += cur[q + 2] }
      const inv = 1 / (e - s)
      nxt[p] = cur[p] + f * (mx * inv - cur[p])
      nxt[p + 1] = cur[p + 1] + f * (my * inv - cur[p + 1])
      nxt[p + 2] = cur[p + 2] + f * (mz * inv - cur[p + 2])
    }
    const t = cur; cur = nxt; nxt = t
  }
  let maxMove2 = 0, nFixed = 0
  for (let v = 0; v < nV; v++) {
    const p = v * 3
    const x = cur[p] + ox, y = cur[p + 1] + oy, z = cur[p + 2] + oz
    const dx = x - out.pos[p], dy = y - out.pos[p + 1], dz = z - out.pos[p + 2]
    const d2 = dx * dx + dy * dy + dz * dz
    if (d2 > maxMove2) maxMove2 = d2
    out.pos[p] = x; out.pos[p + 1] = y; out.pos[p + 2] = z
    nFixed += fixed[v]
  }
  onLog?.(`Mesh smooth (Taubin λ=${lambda}, μ=${mu}, ${iters} iterations): ${nV.toLocaleString()} vertices, `
    + `${nFixed.toLocaleString()} fixed on the boundary, max displacement ${Math.sqrt(maxMove2).toPrecision(4)}`, 'info', 'Products')
  return out
}

// ── Crop ─────────────────────────────────────────────────────────────────────

/**
 * Keep the triangles whose three vertices all lie inside an axis-aligned box — or,
 * with `invert`, the triangles with ANY vertex outside it (so a mesh split by the two
 * calls shares no triangle). Bounds are inclusive; a null/undefined/non-finite
 * component is unbounded on that side, exactly as `cropCloud`. The result is compacted.
 *
 * opts: { min: [x,y,z], max: [x,y,z], invert = false }
 */
export function cropMesh(mesh, { min = [], max = [], invert = false } = {}, onLog) {
  const nV = meshVertexCount(mesh), nT = meshTriangleCount(mesh)
  const lo = [0, 1, 2].map((i) => (Number.isFinite(min?.[i]) ? min[i] : -Infinity))
  const hi = [0, 1, 2].map((i) => (Number.isFinite(max?.[i]) ? max[i] : Infinity))
  const { pos, idx } = mesh
  const inside = new Uint8Array(nV)
  for (let v = 0; v < nV; v++) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2]
    if (x >= lo[0] && x <= hi[0] && y >= lo[1] && y <= hi[1] && z >= lo[2] && z <= hi[2]) inside[v] = 1
  }
  const keep = new Uint8Array(nT)
  let kept = 0
  for (let t = 0; t < nT; t++) {
    const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2]
    const all = inside[a] === 1 && inside[b] === 1 && inside[c] === 1
    if (all !== invert) { keep[t] = 1; kept++ }
  }
  const out = compactStep(selectTriangles(mesh, keep, kept)).mesh
  onLog?.(`Mesh crop: kept ${out.count.toLocaleString()} of ${nT.toLocaleString()} triangles`
    + `${invert ? ' (outside box)' : ''}`, 'info', 'Products')
  return out
}

// ── Surface sampling ─────────────────────────────────────────────────────────

/** mulberry32: a tiny, fast, deterministic 32-bit PRNG returning [0, 1). */
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Area-weighted uniform random sampling of the surface into a dense cloud
 * `{ count, pos:Float64Array(3N), col:Uint8Array(3N)|null, nrm:Float32Array(3N) }`.
 * A triangle is picked by binary search in the cumulative-area table, the point by the
 * square-root barycentric trick (uniform within the triangle). Colour is interpolated
 * barycentrically; the normal is the unit face normal (winding direction). Fully
 * deterministic for a given `seed`. Zero-area triangles are never picked.
 *
 * opts: { count = 1_000_000, seed = 1 }
 */
export function sampleMesh(mesh, { count = 1_000_000, seed = 1 } = {}, onLog) {
  const nV = meshVertexCount(mesh), nT = meshTriangleCount(mesh)
  const hasCol = !!mesh.col
  const empty = { count: 0, pos: new Float64Array(0), col: hasCol ? new Uint8Array(0) : null, nrm: new Float32Array(0) }
  const N = Math.max(0, Math.floor(count) || 0)
  if (!nT || !N) return empty
  const { pos, idx, col } = mesh
  const cum = new Float64Array(nT)
  let total = 0
  for (let t = 0; t < nT; t++) {
    const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2]
    if (!badIndices(a, b, c, nV)) {
      const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2]
      const vx = pos[c * 3] - pos[a * 3], vy = pos[c * 3 + 1] - pos[a * 3 + 1], vz = pos[c * 3 + 2] - pos[a * 3 + 2]
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx
      const area = 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz)
      if (area > 0) total += area
    }
    cum[t] = total
  }
  if (!(total > 0)) return empty
  const rand = mulberry32(seed)
  const outPos = new Float64Array(N * 3)
  const outCol = hasCol ? new Uint8Array(N * 3) : null
  const outNrm = new Float32Array(N * 3)
  for (let i = 0; i < N; i++) {
    // First triangle whose cumulative area exceeds r (a zero-area one never does).
    const r = rand() * total
    let lo = 0, hi = nT - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (cum[mid] > r) hi = mid
      else lo = mid + 1
    }
    const t = lo
    const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2]
    const s1 = Math.sqrt(rand()), u2 = rand()
    const wb = s1 * (1 - u2), wc = s1 * u2, wa = 1 - wb - wc
    const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2]
    const vx = pos[c * 3] - pos[a * 3], vy = pos[c * 3 + 1] - pos[a * 3 + 1], vz = pos[c * 3 + 2] - pos[a * 3 + 2]
    const d = i * 3
    // p = a + wb·(b−a) + wc·(c−a): offsets, not a weighted sum of ~1e6 coordinates.
    outPos[d] = pos[a * 3] + wb * ux + wc * vx
    outPos[d + 1] = pos[a * 3 + 1] + wb * uy + wc * vy
    outPos[d + 2] = pos[a * 3 + 2] + wb * uz + wc * vz
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx
    const inv = 1 / Math.sqrt(cx * cx + cy * cy + cz * cz)
    outNrm[d] = cx * inv; outNrm[d + 1] = cy * inv; outNrm[d + 2] = cz * inv
    if (outCol) {
      for (let k = 0; k < 3; k++) outCol[d + k] = Math.round(wa * col[a * 3 + k] + wb * col[b * 3 + k] + wc * col[c * 3 + k])
    }
  }
  onLog?.(`Mesh sample: ${N.toLocaleString()} points over area ${total.toPrecision(6)} `
    + `(${(N / total).toPrecision(4)} per unit²), seed ${seed}`, 'info', 'Products')
  return { count: N, pos: outPos, col: outCol, nrm: outNrm }
}

// ── Measurement ──────────────────────────────────────────────────────────────

/**
 * Surface area, enclosed volume and topology health in the units of `pos` (the caller
 * converts grid units). Volume is the divergence-theorem sum 1/6 Σ v0·(v1×v2) taken
 * relative to the bbox centre (exact for any origin on a closed surface, and free of
 * cancellation at survey coordinates), reported as its absolute value — and only when
 * the mesh is `watertight` (no boundary and no non-manifold edges) AND consistently
 * oriented; otherwise `volume` is null. `components` counts triangle-bearing
 * components; triangles with bad indices are ignored throughout.
 *
 * Topology (closed? pieces?) is read on a welded copy (`weldVertices`, default ε),
 * so a mesh imported with every triangle carrying its own corners still measures as
 * closed; `weldedVertices` reports how many duplicates that joined (0 for a mesh that
 * already shares its vertices). `opts.weld = false` reads the topology as stored.
 *
 * Returns { area, volume, watertight, boundaryEdges, nonManifoldEdges,
 *           inconsistentEdges, components, triangles, vertices, weldedVertices }.
 */
export function meshMeasure(source, { weld = true } = {}) {
  const nVIn = meshVertexCount(source)
  // Topology on a welded copy, so an unwelded import (STL) is not "all boundary". The
  // weld keeps representatives' own positions, so area and volume move only by the
  // ε-sized slivers it collapses.
  const welded = weld ? weldStep(source) : null
  const mesh = welded ? welded.mesh : source
  const nV = meshVertexCount(mesh), nT = meshTriangleCount(mesh)
  const topo = meshTopology(mesh)
  const { nComp } = triangleComponents(mesh)
  const { pos, idx } = mesh
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let v = 0; v < nV; v++) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2]
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
  }
  const ox = nV ? (minX + maxX) / 2 : 0, oy = nV ? (minY + maxY) / 2 : 0, oz = nV ? (minZ + maxZ) / 2 : 0
  let area = 0, vol6 = 0
  for (let t = 0; t < nT; t++) {
    const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2]
    if (badIndices(a, b, c, nV)) continue
    const ax = pos[a * 3] - ox, ay = pos[a * 3 + 1] - oy, az = pos[a * 3 + 2] - oz
    const bx = pos[b * 3] - ox, by = pos[b * 3 + 1] - oy, bz = pos[b * 3 + 2] - oz
    const cx = pos[c * 3] - ox, cy = pos[c * 3 + 1] - oy, cz = pos[c * 3 + 2] - oz
    const ux = bx - ax, uy = by - ay, uz = bz - az
    const vx = cx - ax, vy = cy - ay, vz = cz - az
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    area += 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz)
    vol6 += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)
  }
  const watertight = topo.edges > 0 && topo.boundaryEdges === 0 && topo.nonManifoldEdges === 0
  return {
    area,
    volume: watertight && topo.inconsistentEdges === 0 ? Math.abs(vol6) / 6 : null,
    watertight,
    boundaryEdges: topo.boundaryEdges,
    nonManifoldEdges: topo.nonManifoldEdges,
    inconsistentEdges: topo.inconsistentEdges,
    components: nComp,
    triangles: nT,
    vertices: nVIn,
    weldedVertices: welded ? welded.merged : 0,
  }
}
