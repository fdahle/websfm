// Mesh basics shared by the editing steps (core/products/meshEdit.js): counts, the
// coincident-vertex join of a textured mesh, triangle selection, union-find components,
// and the topology report (boundaries, non-manifold edges, pieces). Pure; see
// meshEdit.js for the mesh shape and the scale and precision rules every step keeps.

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

/** A triangle no atlas page covers (a filled hole on a textured mesh). */
export const UNTEXTURED = 0xffff

export function emptyMesh(hasCol) {
  return {
    nVerts: 0,
    count: 0,
    pos: new Float64Array(0),
    idx: new Uint32Array(0),
    col: hasCol ? new Uint8Array(0) : null,
  }
}

/**
 * Copy of the mesh keeping only the triangles flagged in `keep` (`kept` = its
 * popcount). Vertices are carried over unchanged — orphans included — so indices need
 * no remap; `compactMesh` is the step that drops unreferenced vertices.
 */
export function selectTriangles(mesh, keep, kept) {
  const nV = meshVertexCount(mesh),
    nT = meshTriangleCount(mesh)
  const pos = new Float64Array(nV * 3)
  pos.set(mesh.pos.subarray(0, nV * 3))
  const col = mesh.col ? mesh.col.slice(0, nV * 3) : null
  const src = mesh.idx
  const idx = new Uint32Array(kept * 3)
  const page = mesh.page ? new Uint16Array(kept) : null
  let o = 0
  for (let t = 0; t < nT; t++) {
    if (!keep[t]) continue
    const s = t * 3
    if (page) page[o / 3] = mesh.page[t]
    idx[o] = src[s]
    idx[o + 1] = src[s + 1]
    idx[o + 2] = src[s + 2]
    o += 3
  }
  return { nVerts: nV, count: kept, pos, idx, col, ...textureOf(mesh, nV, page) }
}

// The texture fields of a result: `uv` copied (vertices unchanged) and the given page.
function textureOf(mesh, nV, page) {
  if (!mesh.uv) return {}
  return { uv: mesh.uv.slice(0, nV * 2), ...(page ? { page } : {}) }
}

/**
 * Vertices at exactly the same position → one id each. A textured mesh has one copy
 * of a vertex per atlas piece it lies in (its UV differs per piece), bit-identical in
 * position. Hashed on the coordinates' bits, typed arrays only — O(n). NaN positions
 * join nothing. → { id: Int32Array(nV), first: Int32Array(m) (a vertex of each id), m }
 */
export function coincidentVertices(pos, nV = Math.floor(pos.length / 3)) {
  let size = 1
  while (size < nV * 2) size <<= 1
  const mask = size - 1
  const head = new Int32Array(size).fill(-1),
    next = new Int32Array(nV)
  const id = new Int32Array(nV),
    first = new Int32Array(nV)
  const f64 = new Float64Array(1),
    u32 = new Uint32Array(f64.buffer)
  const bits = (x) => {
    f64[0] = x === 0 ? 0 : x
    return u32[0] ^ Math.imul(u32[1], 0x9e3779b1)
  } // −0 ≡ 0
  let m = 0
  for (let v = 0; v < nV; v++) {
    const x = pos[v * 3],
      y = pos[v * 3 + 1],
      z = pos[v * 3 + 2]
    const h = (bits(x) ^ Math.imul(bits(y), 73856093) ^ Math.imul(bits(z), 19349663)) & mask
    let found = -1
    for (let r = head[h]; r >= 0; r = next[r]) {
      const o = first[r] * 3
      if (pos[o] === x && pos[o + 1] === y && pos[o + 2] === z) {
        found = r
        break
      }
    }
    if (found >= 0) {
      id[v] = found
      continue
    }
    id[v] = m
    first[m] = v
    next[m] = head[h]
    head[h] = m
    m++
  }
  return { id, first: first.subarray(0, m), m }
}

/**
 * The geometry of a textured mesh as one surface: its UV copies joined
 * (coincidentVertices), so topology — pieces, boundaries, holes, a vertex's
 * neighbours — is the surface's own and not the atlas layout's. Same triangles in the
 * same order. Null for an untextured mesh or one without copies.
 * → { mesh: { nVerts, count, pos: Float64Array, idx, col }, id, first }
 */
export function geometricMesh(mesh) {
  if (!mesh.uv) return null
  const nV = meshVertexCount(mesh),
    nT = meshTriangleCount(mesh)
  const { id, first, m } = coincidentVertices(mesh.pos, nV)
  if (m === nV) return null
  const pos = new Float64Array(m * 3)
  const col = mesh.col ? new Uint8Array(m * 3) : null
  for (let r = 0; r < m; r++) {
    const o = first[r] * 3
    pos[r * 3] = mesh.pos[o]
    pos[r * 3 + 1] = mesh.pos[o + 1]
    pos[r * 3 + 2] = mesh.pos[o + 2]
    if (col) {
      col[r * 3] = mesh.col[o]
      col[r * 3 + 1] = mesh.col[o + 1]
      col[r * 3 + 2] = mesh.col[o + 2]
    }
  }
  const idx = new Uint32Array(nT * 3)
  for (let i = 0; i < nT * 3; i++) {
    const v = mesh.idx[i]
    idx[i] = v < nV ? id[v] : m + (v - nV) // out of range stays out of range
  }
  return { mesh: { nVerts: m, count: nT, pos, idx, col }, id, first }
}

/** A triangle whose corner indices repeat or fall outside the vertex array. */
export function badIndices(a, b, c, nV) {
  return a === b || b === c || a === c || !(a < nV) || !(b < nV) || !(c < nV)
}

// Union-find over vertex ids with path halving + union by rank. Typed arrays only.
function makeUnionFind(n) {
  const parent = new Int32Array(n)
  for (let i = 0; i < n; i++) parent[i] = i
  const rank = new Uint8Array(n)
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]
      x = parent[x]
    }
    return x
  }
  const union = (a, b) => {
    let ra = find(a),
      rb = find(b)
    if (ra === rb) return
    if (rank[ra] < rank[rb]) {
      const t = ra
      ra = rb
      rb = t
    }
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
export function triangleComponents(mesh) {
  const nV = meshVertexCount(mesh),
    nT = meshTriangleCount(mesh)
  const idx = mesh.idx
  const uf = makeUnionFind(nV)
  for (let t = 0; t < nT; t++) {
    const a = idx[t * 3],
      b = idx[t * 3 + 1],
      c = idx[t * 3 + 2]
    if (!(a < nV) || !(b < nV) || !(c < nV)) continue
    uf.union(a, b)
    uf.union(a, c)
  }
  const compOfRoot = new Int32Array(nV).fill(-1)
  const compOfTri = new Int32Array(nT)
  let nComp = 0
  for (let t = 0; t < nT; t++) {
    const a = idx[t * 3],
      b = idx[t * 3 + 1],
      c = idx[t * 3 + 2]
    if (!(a < nV) || !(b < nV) || !(c < nV)) {
      compOfTri[t] = -1
      continue
    }
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
  const nV = meshVertexCount(mesh),
    nT = meshTriangleCount(mesh)
  const idx = mesh.idx
  const H = nT * 3
  const valid = new Uint8Array(nT)
  let nHalf = 0
  for (let t = 0; t < nT; t++) {
    if (badIndices(idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2], nV)) continue
    valid[t] = 1
    nHalf += 3
  }
  const endOf = (h) => idx[h % 3 === 2 ? h - 2 : h + 1]

  // Pass 1: counting sort of valid half-edges by hi vertex.
  const bucket = new Uint32Array(nV + 1)
  for (let h = 0; h < H; h++) {
    if (!valid[(h / 3) | 0]) continue
    const a = idx[h],
      b = endOf(h)
    bucket[(a > b ? a : b) + 1]++
  }
  for (let v = 0; v < nV; v++) bucket[v + 1] += bucket[v]
  const byHi = new Int32Array(nHalf)
  for (let h = 0; h < H; h++) {
    if (!valid[(h / 3) | 0]) continue
    const a = idx[h],
      b = endOf(h)
    byHi[bucket[a > b ? a : b]++] = h
  }
  // Pass 2: stable counting sort by lo — within one lo bucket, hi stays ascending.
  bucket.fill(0)
  for (let i = 0; i < nHalf; i++) {
    const h = byHi[i],
      a = idx[h],
      b = endOf(h)
    bucket[(a < b ? a : b) + 1]++
  }
  for (let v = 0; v < nV; v++) bucket[v + 1] += bucket[v]
  const sorted = new Int32Array(nHalf)
  for (let i = 0; i < nHalf; i++) {
    const h = byHi[i],
      a = idx[h],
      b = endOf(h)
    sorted[bucket[a < b ? a : b]++] = h
  }

  // Scan runs of equal (lo, hi).
  const edgeOfHalf = new Int32Array(H).fill(-1)
  const loBuf = new Uint32Array(nHalf),
    hiBuf = new Uint32Array(nHalf)
  const incBuf = new Uint32Array(nHalf),
    fwdBuf = new Uint32Array(nHalf)
  const firstBuf = new Int32Array(nHalf)
  let E = -1,
    pLo = -1,
    pHi = -1
  for (let i = 0; i < nHalf; i++) {
    const h = sorted[i],
      a = idx[h],
      b = endOf(h)
    const lo = a < b ? a : b,
      hi = a < b ? b : a
    if (lo !== pLo || hi !== pHi) {
      E++
      pLo = lo
      pHi = hi
      loBuf[E] = lo
      hiBuf[E] = hi
      firstBuf[E] = h
    }
    incBuf[E]++
    if (a === lo) fwdBuf[E]++
    edgeOfHalf[h] = E
  }
  E++
  let boundaryEdges = 0,
    nonManifoldEdges = 0,
    inconsistentEdges = 0
  for (let e = 0; e < E; e++) {
    const k = incBuf[e]
    if (k === 1) boundaryEdges++
    else if (k > 2) nonManifoldEdges++
    else if (fwdBuf[e] !== 1) inconsistentEdges++
  }
  return {
    edges: E,
    edgeLo: loBuf.slice(0, E),
    edgeHi: hiBuf.slice(0, E),
    incidence: incBuf.slice(0, E),
    forward: fwdBuf.slice(0, E),
    firstHalf: firstBuf.slice(0, E),
    edgeOfHalf,
    boundaryEdges,
    nonManifoldEdges,
    inconsistentEdges,
  }
}
