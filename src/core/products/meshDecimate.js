// Mesh decimation (quadric edge collapse) — pure, no Vue/Pinia/OPFS/DOM. A
// products-stage concern beside mesh.js: Poisson meshes come out at millions of
// triangles, far more than a viewer, a GLB export or a 3D Tiles payload wants, and
// most of them sit on surfaces a fraction of that count describes to sub-GSD error.
//
// Method: Garland & Heckbert (1997) quadric error metrics. Each vertex carries the
// sum of the area-weighted plane quadrics of its incident faces; collapsing an edge
// merges the two quadrics and places the surviving vertex where the merged quadric
// is smallest. Edges are collapsed cheapest-first until the triangle target (or an
// error ceiling) is reached.
//
// Dense-scale invariants, as everywhere else in this codebase: typed arrays only.
// There is no per-vertex, per-edge or per-triangle JS object anywhere — a 5 M
// triangle mesh as objects is the same OOM fusion once hit. Concretely:
//   • quadrics: 10 Float64 per vertex (the upper triangle of the symmetric 4×4) plus
//     one Float64 face-area weight;
//   • vertex→triangle adjacency: an intrusive singly linked list threaded through the
//     triangle CORNERS (`head[v]` → corner → `next[corner]` …). Corners are fixed
//     nodes (3·nTris of them), so the adjacency never allocates after setup: a
//     collapse re-points the removed vertex's corners at the survivor and splices
//     them into its list. Corners of dead triangles are skipped lazily on traversal
//     and dropped whenever their vertex's list is rebuilt;
//   • the candidate queue: a 4-ary min-heap in parallel typed arrays with LAZY
//     deletion. Each entry records the collapse counter at push time; an entry is
//     stale once either endpoint died or was modified after it (`modTime[v] > T`).
//     Stale entries are discarded on pop, and purged in bulk (filter + heapify)
//     before the heap is allowed to grow, so memory stays ~1.25× the live edge count.
//
// Error normalisation: the queue is ordered by the merged quadric divided by the
// merged face-area weight — the area-weighted MEAN squared distance from the new
// vertex to the planes it stands in for. That makes `maxError` a distance in model
// units (compared as its square) and keeps the ordering independent of how finely
// the input was tessellated. The boundary constraint quadrics are deliberately NOT
// added to that weight: they must stay `boundaryWeight` times more expensive than a
// surface deviation, and folding them into the denominator would cancel exactly that.
//
// Survey coordinates (~1e6) are handled by working relative to the bbox centre:
// quadric coefficients square the coordinates, and at 1e6 the plane offsets alone
// would eat 12 of float64's 16 digits. The origin is added back at the end.

/**
 * @typedef {Object} DecimateOptions
 * @property {number} [targetTriangles] absolute triangle target (exactly one of this
 *   and `targetRatio`).
 * @property {number} [targetRatio] fraction of the input triangle count to keep, 0..1.
 * @property {boolean} [preserveBoundary=true] add a constraint quadric along every open
 *   border so it does not erode inward.
 * @property {number} [boundaryWeight=1000] weight of that constraint relative to the
 *   surface quadrics.
 * @property {number} [maxError=Infinity] stop once the cheapest remaining collapse
 *   would move the surface by more than this (RMS distance, model units).
 * @property {boolean} [preventFlips=true] reject collapses that turn a surviving
 *   triangle's normal by more than ~78° (dot < 0.2).
 */

// A surviving triangle whose normal turns past this cosine is a fold: dot < 0.2 is
// ~78°, which a legitimate collapse on a reasonably smooth surface never needs.
const FLIP_MIN_COS = 0.2
// A new triangle with sin²(angle at the moved vertex) below this is degenerate
// (collinear) — scale-free, so it behaves the same on a 1 mm and a 1 km mesh.
const DEGENERATE_SIN2 = 1e-12
// det(A) / max(diag A)³ below this is treated as singular: the minimum is a line or
// plane (flat or ridge regions), and the 3×3 solve would only report rounding noise.
const SINGULAR_REL_DET = 1e-10
// Snap the along-edge parameter to an endpoint when it is this close: keeps a
// surviving grid/boundary vertex bit-exact instead of 1e-16 off.
const T_SNAP = 1e-12

/**
 * Decimate a flat indexed triangle mesh by quadric edge collapse.
 *
 * Input shape: `{ nVerts, count /* triangles *\/, pos: Float64Array|Float32Array(3·nVerts),
 * idx: Uint32Array(3·count), col?: Uint8Array(3·nVerts)|null }`. Never mutated.
 *
 * Output: `{ mesh, stats }` where `mesh` has the same shape with `pos: Float64Array`,
 * `idx: Uint32Array`, `col: Uint8Array|null`, compacted (no unreferenced vertices,
 * no repeated-index triangles; vertices keep their original relative order), and
 * `stats = { before, after, collapses, maxError }` — `maxError` is the largest
 * accepted collapse error (RMS distance, model units).
 *
 * Vertex colour: the survivor takes the colour interpolated along the collapsed edge
 * at the new position's projection onto it (clamped to the edge). A plain "closer
 * endpoint" pick would posterise gradients as regions merge; the projection is
 * already computed for the placement, so the interpolation is free.
 *
 * Topology guards (always on): the link condition — the two endpoints' one-rings may
 * share exactly the edge's opposite vertices (2 for an interior edge, 1 for a
 * boundary edge), else the collapse would create a non-manifold edge — plus "never
 * join two boundary vertices through the interior" (it would pinch the surface) and
 * a minimum surviving valence (no collapsing a closed piece into a double-sided pillow).
 *
 * @param {{ nVerts:number, count:number, pos:Float64Array|Float32Array, idx:Uint32Array, col?:Uint8Array|null }} mesh
 * @param {DecimateOptions} opts
 * @param {(msg:string, level?:string, source?:string)=>void} [onLog]
 * @returns {{ mesh: { nVerts:number, count:number, pos:Float64Array, idx:Uint32Array, col:Uint8Array|null },
 *            stats: { before:number, after:number, collapses:number, maxError:number } }}
 */
export function decimateMesh(mesh, opts = {}, onLog) {
  const t0 = nowMs()
  const {
    targetTriangles, targetRatio,
    preserveBoundary = true, boundaryWeight = 1000,
    maxError = Infinity, preventFlips = true,
  } = opts
  const hasCount = targetTriangles != null
  const hasRatio = targetRatio != null
  if (hasCount === hasRatio) {
    throw new Error('decimateMesh: give exactly one of targetTriangles / targetRatio')
  }

  const nT = mesh?.idx ? Math.floor(mesh.idx.length / 3) : 0
  const nV = mesh?.pos ? Math.floor(mesh.pos.length / 3) : 0
  const before = mesh?.count ?? nT
  const srcPos = mesh?.pos, srcIdx = mesh?.idx, srcCol = mesh?.col || null

  // ── Working copies (input never mutated) ────────────────────────────────────
  // Local origin = bbox centre of the referenced vertices.
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i < nV; i++) {
    const x = srcPos[i * 3], y = srcPos[i * 3 + 1], z = srcPos[i * 3 + 2]
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
  }
  const ox = nV ? (minX + maxX) / 2 : 0
  const oy = nV ? (minY + maxY) / 2 : 0
  const oz = nV ? (minZ + maxZ) / 2 : 0
  const P = new Float64Array(nV * 3)
  for (let i = 0; i < nV; i++) {
    P[i * 3] = srcPos[i * 3] - ox
    P[i * 3 + 1] = srcPos[i * 3 + 1] - oy
    P[i * 3 + 2] = srcPos[i * 3 + 2] - oz
  }
  const C = srcCol && srcCol.length >= nV * 3 ? Uint8Array.from(srcCol.subarray(0, nV * 3)) : null
  const tri = Uint32Array.from(srcIdx ? srcIdx.subarray(0, nT * 3) : [])
  const dead = new Uint8Array(nT)

  // Input triangles with a repeated or out-of-range index are dead from the start
  // (they carry no plane and would confuse the link condition).
  let live = 0
  for (let t = 0; t < nT; t++) {
    const a = tri[t * 3], b = tri[t * 3 + 1], c = tri[t * 3 + 2]
    if (a === b || b === c || a === c || a >= nV || b >= nV || c >= nV) dead[t] = 1
    else live++
  }

  // Target. A ratio is of the input count; both clamp into [0, live].
  let target = hasRatio
    ? Math.round(nT * Math.min(1, Math.max(0, Number(targetRatio) || 0)))
    : Math.floor(Math.max(0, Number(targetTriangles) || 0))
  target = Math.min(target, live)
  const maxErr2 = maxError === Infinity ? Infinity : Math.max(0, maxError) ** 2

  // ── Vertex→triangle adjacency over corners ──────────────────────────────────
  const head = new Int32Array(nV).fill(-1)
  const next = new Int32Array(nT * 3).fill(-1)
  for (let c = nT * 3 - 1; c >= 0; c--) {
    if (dead[(c / 3) | 0]) continue
    const v = tri[c]
    next[c] = head[v]
    head[v] = c
  }
  const alive = new Uint8Array(nV)
  for (let t = 0; t < nT; t++) {
    if (dead[t]) continue
    alive[tri[t * 3]] = 1; alive[tri[t * 3 + 1]] = 1; alive[tri[t * 3 + 2]] = 1
  }

  // ── Quadrics ────────────────────────────────────────────────────────────────
  // Q layout per vertex: [a11 a12 a13 a14 a22 a23 a24 a33 a34 a44] of w·[n;d][n;d]ᵀ.
  const Q = new Float64Array(nV * 10)
  const Wt = new Float64Array(nV)
  const addPlane = (v, nx, ny, nz, d, w) => {
    const o = v * 10
    Q[o] += w * nx * nx; Q[o + 1] += w * nx * ny; Q[o + 2] += w * nx * nz; Q[o + 3] += w * nx * d
    Q[o + 4] += w * ny * ny; Q[o + 5] += w * ny * nz; Q[o + 6] += w * ny * d
    Q[o + 7] += w * nz * nz; Q[o + 8] += w * nz * d
    Q[o + 9] += w * d * d
  }
  for (let t = 0; t < nT; t++) {
    if (dead[t]) continue
    const i0 = tri[t * 3] * 3, i1 = tri[t * 3 + 1] * 3, i2 = tri[t * 3 + 2] * 3
    const ux = P[i1] - P[i0], uy = P[i1 + 1] - P[i0 + 1], uz = P[i1 + 2] - P[i0 + 2]
    const vx = P[i2] - P[i0], vy = P[i2 + 1] - P[i0 + 1], vz = P[i2 + 2] - P[i0 + 2]
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz)
    if (!(len > 0)) continue
    nx /= len; ny /= len; nz /= len
    const d = -(nx * P[i0] + ny * P[i0 + 1] + nz * P[i0 + 2])
    const area = len / 2
    for (let k = 0; k < 3; k++) {
      const v = tri[t * 3 + k]
      addPlane(v, nx, ny, nz, d, area)
      Wt[v] += area
    }
  }

  // ── Shared scratch / helpers ───────────────────────────────────────────────
  const mark = new Int32Array(nV)
  let stamp = 0
  const isB = new Uint8Array(nV)

  const triHas = (t, v) => tri[t * 3] === v || tri[t * 3 + 1] === v || tri[t * 3 + 2] === v

  // Count live triangles holding edge (u,v) and the lowest such triangle id —
  // the deterministic owner that enumerates each undirected edge exactly once.
  let edgeCnt = 0, edgeMinT = 0
  const edgeInfo = (u, v) => {
    edgeCnt = 0; edgeMinT = 0x7fffffff
    for (let c = head[u]; c >= 0; c = next[c]) {
      const t = (c / 3) | 0
      if (dead[t] || !triHas(t, v)) continue
      edgeCnt++
      if (t < edgeMinT) edgeMinT = t
    }
  }

  // Boundary edges: used by exactly one live triangle. Mark their vertices and add
  // the constraint quadric — the plane through the edge perpendicular to its face,
  // weighted by boundaryWeight·|e|² (an area, like the face weights, so the ratio
  // between surface and border cost does not depend on the mesh's scale).
  let boundaryEdges = 0
  for (let t = 0; t < nT; t++) {
    if (dead[t]) continue
    for (let k = 0; k < 3; k++) {
      const u = tri[t * 3 + k], v = tri[t * 3 + ((k + 1) % 3)]
      edgeInfo(u, v)
      if (edgeCnt !== 1) continue
      boundaryEdges++
      isB[u] = 1; isB[v] = 1
      if (!preserveBoundary) continue
      const w2 = tri[t * 3 + ((k + 2) % 3)]
      const iu = u * 3, iv = v * 3, iw = w2 * 3
      const ex = P[iv] - P[iu], ey = P[iv + 1] - P[iu + 1], ez = P[iv + 2] - P[iu + 2]
      const fx = P[iw] - P[iu], fy = P[iw + 1] - P[iu + 1], fz = P[iw + 2] - P[iu + 2]
      // face normal n = e × f, constraint normal m = e × n (perpendicular to both).
      const nx = ey * fz - ez * fy, ny = ez * fx - ex * fz, nz = ex * fy - ey * fx
      let mx = ey * nz - ez * ny, my = ez * nx - ex * nz, mz = ex * ny - ey * nx
      const ml = Math.sqrt(mx * mx + my * my + mz * mz)
      if (!(ml > 0)) continue
      mx /= ml; my /= ml; mz /= ml
      const d = -(mx * P[iu] + my * P[iu + 1] + mz * P[iu + 2])
      const w = boundaryWeight * (ex * ex + ey * ey + ez * ez)
      addPlane(u, mx, my, mz, d, w)
      addPlane(v, mx, my, mz, d, w)
    }
  }

  // ── Collapse evaluation ─────────────────────────────────────────────────────
  // Writes the best placement into candX/Y/Z and its along-edge parameter into candT;
  // returns the normalised error (mean squared plane distance). Two candidates:
  // the unconstrained 3×3 minimiser, accepted only when well-conditioned and within
  // one edge length of the midpoint; and the minimiser on the segment itself
  // (a 1-D convex quadratic, clamped to [0,1] — endpoints included). On flat or
  // straight-border regions the 3×3 is singular and the segment placement keeps the
  // vertex exactly on the plane / border line.
  let candX = 0, candY = 0, candZ = 0, candT = 0, candL2 = 0
  const evaluate = (a, b) => {
    const oa = a * 10, ob = b * 10
    const a11 = Q[oa] + Q[ob], a12 = Q[oa + 1] + Q[ob + 1], a13 = Q[oa + 2] + Q[ob + 2]
    const a14 = Q[oa + 3] + Q[ob + 3], a22 = Q[oa + 4] + Q[ob + 4], a23 = Q[oa + 5] + Q[ob + 5]
    const a24 = Q[oa + 6] + Q[ob + 6], a33 = Q[oa + 7] + Q[ob + 7], a34 = Q[oa + 8] + Q[ob + 8]
    const a44 = Q[oa + 9] + Q[ob + 9]
    const W = Wt[a] + Wt[b]
    const ia = a * 3, ib = b * 3
    const pax = P[ia], pay = P[ia + 1], paz = P[ia + 2]
    const ex = P[ib] - pax, ey = P[ib + 1] - pay, ez = P[ib + 2] - paz

    // Segment minimiser: f(t) = f(0) + 2t·eᵀg + t²·eᵀAe with g = A·pa + q.
    const gx = a11 * pax + a12 * pay + a13 * paz + a14
    const gy = a12 * pax + a22 * pay + a23 * paz + a24
    const gz = a13 * pax + a23 * pay + a33 * paz + a34
    const Ae_x = a11 * ex + a12 * ey + a13 * ez
    const Ae_y = a12 * ex + a22 * ey + a23 * ez
    const Ae_z = a13 * ex + a23 * ey + a33 * ez
    const eAe = ex * Ae_x + ey * Ae_y + ez * Ae_z
    const eg = ex * gx + ey * gy + ez * gz
    let t
    if (eAe > 0 && Number.isFinite(eAe)) {
      t = -eg / eAe
      if (!(t > T_SNAP)) t = 0
      else if (!(t < 1 - T_SNAP)) t = 1
    } else {
      // Flat along the edge: f is linear in t (eAe = 0), so the cheaper endpoint wins;
      // a tie keeps `a` where it is.
      t = eg < 0 ? 1 : 0
    }
    let x = t === 1 ? P[ib] : pax + t * ex
    let y = t === 1 ? P[ib + 1] : pay + t * ey
    let z = t === 1 ? P[ib + 2] : paz + t * ez
    let err = quadricValue(a11, a12, a13, a14, a22, a23, a24, a33, a34, a44, x, y, z)

    // Unconstrained minimiser A·p = −q (Cramer's rule on the symmetric 3×3).
    const c11 = a22 * a33 - a23 * a23
    const c12 = a13 * a23 - a12 * a33
    const c13 = a12 * a23 - a13 * a22
    const det = a11 * c11 + a12 * c12 + a13 * c13
    const scale = Math.max(a11, a22, a33)
    if (scale > 0 && Math.abs(det) > SINGULAR_REL_DET * scale * scale * scale) {
      const c22 = a11 * a33 - a13 * a13
      const c23 = a12 * a13 - a11 * a23
      const c33 = a11 * a22 - a12 * a12
      const inv = 1 / det
      const sx = -(c11 * a14 + c12 * a24 + c13 * a34) * inv
      const sy = -(c12 * a14 + c22 * a24 + c23 * a34) * inv
      const sz = -(c13 * a14 + c23 * a24 + c33 * a34) * inv
      const mx = sx - (pax + ex / 2), my = sy - (pay + ey / 2), mz = sz - (paz + ez / 2)
      const e2 = ex * ex + ey * ey + ez * ez
      if (Number.isFinite(sx + sy + sz) && mx * mx + my * my + mz * mz <= e2) {
        const se = quadricValue(a11, a12, a13, a14, a22, a23, a24, a33, a34, a44, sx, sy, sz)
        // Only when meaningfully better: on a corner or a straight border the two
        // agree up to rounding, and the segment placement is the bit-exact one.
        if (se < err - 1e-12 * (scale * e2 + Math.abs(err))) {
          err = se; x = sx; y = sy; z = sz
          // Colour parameter: projection onto the edge, clamped.
          const tp = e2 > 0 ? ((sx - pax) * ex + (sy - pay) * ey + (sz - paz) * ez) / e2 : 0
          t = tp < 0 ? 0 : tp > 1 ? 1 : tp
        }
      }
    }
    candX = x; candY = y; candZ = z; candT = t; candL2 = ex * ex + ey * ey + ez * ez
    if (!(err > 0)) err = 0 // rounding can push a PSD form slightly negative
    return W > 0 ? err / W : err
  }

  // ── Topology: link condition + valence ──────────────────────────────────────
  // Mark values within one check: base = in ring(a) only, base+1 = in both rings,
  // base+2 = in ring(b) only. Reserving three stamps per call keeps the array
  // clear-free across millions of checks.
  let sharedTris = 0
  const linkOk = (a, b) => {
    const base = stamp + 1
    stamp += 3
    let nA = 0
    for (let c = head[a]; c >= 0; c = next[c]) {
      const t = (c / 3) | 0
      if (dead[t]) continue
      for (let k = 0; k < 3; k++) {
        const w = tri[t * 3 + k]
        if (w !== a && w !== b && mark[w] !== base) { mark[w] = base; nA++ }
      }
    }
    let common = 0, nBonly = 0
    sharedTris = 0
    for (let c = head[b]; c >= 0; c = next[c]) {
      const t = (c / 3) | 0
      if (dead[t]) continue
      if (triHas(t, a)) sharedTris++
      for (let k = 0; k < 3; k++) {
        const w = tri[t * 3 + k]
        if (w === a || w === b) continue
        const m = mark[w]
        if (m === base) { mark[w] = base + 1; common++ }
        else if (m !== base + 1 && m !== base + 2) { mark[w] = base + 2; nBonly++ }
      }
    }
    if (sharedTris < 1 || sharedTris > 2) return false // non-manifold (or no) edge
    if (common !== sharedTris) return false // would create a non-manifold edge
    // Interior edge between two border vertices: collapsing pinches the surface.
    if (sharedTris === 2 && isB[a] && isB[b]) return false
    // Survivor valence after the collapse: |ring(a) ∪ ring(b)| minus {a, b}.
    if (nA + nBonly < (sharedTris === 2 ? 3 : 2)) return false
    return true
  }

  // ── Geometry: no folded or degenerate surviving triangle ────────────────────
  const geometryOk = (a, b, x, y, z) => {
    for (let pass = 0; pass < 2; pass++) {
      const v = pass === 0 ? a : b
      for (let c = head[v]; c >= 0; c = next[c]) {
        const t = (c / 3) | 0
        if (dead[t]) continue
        if (triHas(t, pass === 0 ? b : a)) continue // removed by the collapse
        const k = c - t * 3
        const i1 = tri[t * 3 + ((k + 1) % 3)] * 3, i2 = tri[t * 3 + ((k + 2) % 3)] * 3
        const iv = v * 3
        // Old normal (orientation preserved: corner k, then k+1, k+2).
        const ox1 = P[i1] - P[iv], oy1 = P[i1 + 1] - P[iv + 1], oz1 = P[i1 + 2] - P[iv + 2]
        const ox2 = P[i2] - P[iv], oy2 = P[i2 + 1] - P[iv + 1], oz2 = P[i2 + 2] - P[iv + 2]
        const onx = oy1 * oz2 - oz1 * oy2, ony = oz1 * ox2 - ox1 * oz2, onz = ox1 * oy2 - oy1 * ox2
        // New normal with the vertex moved to (x,y,z).
        const nx1 = P[i1] - x, ny1 = P[i1 + 1] - y, nz1 = P[i1 + 2] - z
        const nx2 = P[i2] - x, ny2 = P[i2 + 1] - y, nz2 = P[i2 + 2] - z
        const nnx = ny1 * nz2 - nz1 * ny2, nny = nz1 * nx2 - nx1 * nz2, nnz = nx1 * ny2 - ny1 * nx2
        const nn2 = nnx * nnx + nny * nny + nnz * nnz
        const l1 = nx1 * nx1 + ny1 * ny1 + nz1 * nz1
        const l2 = nx2 * nx2 + ny2 * ny2 + nz2 * nz2
        if (!(nn2 > DEGENERATE_SIN2 * l1 * l2)) return false
        if (preventFlips) {
          const on2 = onx * onx + ony * ony + onz * onz
          if (on2 > 0) {
            const dot = onx * nnx + ony * nny + onz * nnz
            if (dot < FLIP_MIN_COS * Math.sqrt(on2 * nn2)) return false
          }
        }
      }
    }
    return true
  }

  // ── Heap (min on error, then edge length) with lazy deletion ───────────────
  // The secondary key matters on exactly flat or exactly straight regions, where every
  // collapse costs 0: ordered by error alone, ties fall to whichever survivor was
  // pushed last, which keeps absorbing its neighbours into an ever-larger fan (O(n²)
  // and slivers — a 200k planar grid took ~100 s). Shortest edge first instead
  // decimates a flat region uniformly. Float32 is ample for a tie-break. 4-ary: half
  // the depth of a binary heap, and most of a sift's cost is the 5-array move per level.
  let cap = 1024
  let hk = new Float64Array(cap), hl = new Float32Array(cap)
  let ha = new Uint32Array(cap), hb = new Uint32Array(cap), ht = new Uint32Array(cap)
  let hn = 0
  let time = 0
  const modTime = new Uint32Array(nV)
  const entryValid = (i) => {
    const a = ha[i], b = hb[i], T = ht[i]
    return alive[a] === 1 && alive[b] === 1 && modTime[a] <= T && modTime[b] <= T
  }
  const less = (i, j) => hk[i] < hk[j] || (hk[i] === hk[j] && hl[i] < hl[j])
  const move = (to, from) => { hk[to] = hk[from]; hl[to] = hl[from]; ha[to] = ha[from]; hb[to] = hb[from]; ht[to] = ht[from] }
  const siftDown = (i) => {
    const k = hk[i], l2 = hl[i], a = ha[i], b = hb[i], T = ht[i]
    for (;;) {
      const l = i * 4 + 1
      if (l >= hn) break
      let m = l
      const end = l + 4 < hn ? l + 4 : hn
      for (let j = l + 1; j < end; j++) if (less(j, m)) m = j
      if (!(hk[m] < k || (hk[m] === k && hl[m] < l2))) break
      move(i, m)
      i = m
    }
    hk[i] = k; hl[i] = l2; ha[i] = a; hb[i] = b; ht[i] = T
  }
  const ensureRoom = () => {
    if (hn < cap) return
    // Purge stale entries first; only grow if the live set itself is large.
    let o = 0
    for (let i = 0; i < hn; i++) if (entryValid(i)) move(o++, i)
    hn = o
    for (let i = (hn - 2) >> 2; i >= 0; i--) siftDown(i)
    if (hn > cap * 0.6) {
      const nc = Math.ceil(cap * 1.5) + 16
      const k2 = new Float64Array(nc); k2.set(hk.subarray(0, hn)); hk = k2
      const l2 = new Float32Array(nc); l2.set(hl.subarray(0, hn)); hl = l2
      const a2 = new Uint32Array(nc); a2.set(ha.subarray(0, hn)); ha = a2
      const b2 = new Uint32Array(nc); b2.set(hb.subarray(0, hn)); hb = b2
      const t2 = new Uint32Array(nc); t2.set(ht.subarray(0, hn)); ht = t2
      cap = nc
    }
  }
  // Push the edge (a,b) with the error `evaluate` just returned (its length² is in candL2).
  const push = (k, a, b) => {
    ensureRoom()
    const l2 = candL2
    let i = hn++
    while (i > 0) {
      const p = (i - 1) >> 2
      if (!(k < hk[p] || (k === hk[p] && l2 < hl[p]))) break
      move(i, p)
      i = p
    }
    hk[i] = k; hl[i] = l2; ha[i] = a; hb[i] = b; ht[i] = time
  }
  let popK = 0, popA = 0, popB = 0, popT = 0
  const pop = () => {
    popK = hk[0]; popA = ha[0]; popB = hb[0]; popT = ht[0]
    hn--
    if (hn > 0) {
      move(0, hn)
      siftDown(0)
    }
  }

  // Enumerate every live, manifold edge once (owner = lowest live triangle holding it).
  const fillHeap = () => {
    hn = 0
    if (cap < live * 1.5 + 1024) {
      cap = Math.ceil(live * 1.6) + 1024
      hk = new Float64Array(cap); hl = new Float32Array(cap)
      ha = new Uint32Array(cap); hb = new Uint32Array(cap); ht = new Uint32Array(cap)
    }
    for (let t = 0; t < nT; t++) {
      if (dead[t]) continue
      for (let k = 0; k < 3; k++) {
        const u = tri[t * 3 + k], v = tri[t * 3 + ((k + 1) % 3)]
        edgeInfo(u, v)
        if (edgeMinT !== t || edgeCnt > 2) continue
        push(evaluate(u, v), u, v)
      }
    }
  }

  // ── Collapse b into a, at (x,y,z) with colour parameter t ───────────────────
  const collapse = (a, b, x, y, z, t) => {
    const oa = a * 10, ob = b * 10
    for (let k = 0; k < 10; k++) Q[oa + k] += Q[ob + k]
    Wt[a] += Wt[b]
    P[a * 3] = x; P[a * 3 + 1] = y; P[a * 3 + 2] = z
    if (C) {
      for (let k = 0; k < 3; k++) {
        const ca = C[a * 3 + k], cb = C[b * 3 + k]
        C[a * 3 + k] = Math.round(ca + (cb - ca) * t)
      }
    }
    if (isB[b]) isB[a] = 1
    // Kill the triangles holding both endpoints.
    for (let c = head[b]; c >= 0; c = next[c]) {
      const tt = (c / 3) | 0
      if (!dead[tt] && triHas(tt, a)) { dead[tt] = 1; live-- }
    }
    // Rebuild a's list: its live corners, then b's live corners re-pointed at a.
    let first = -1, tail = -1
    for (let pass = 0; pass < 2; pass++) {
      let c = pass === 0 ? head[a] : head[b]
      while (c >= 0) {
        const nc = next[c]
        if (!dead[(c / 3) | 0]) {
          if (pass === 1) tri[c] = a
          if (tail < 0) first = c; else next[tail] = c
          tail = c
        }
        c = nc
      }
    }
    if (tail >= 0) next[tail] = -1
    head[a] = first
    head[b] = -1
    alive[b] = 0
    modTime[a] = ++time
    // Re-queue every edge around the survivor (its quadric changed).
    const s = ++stamp
    mark[a] = s
    for (let c = head[a]; c >= 0; c = next[c]) {
      const tt = (c / 3) | 0
      for (let k = 0; k < 3; k++) {
        const w = tri[tt * 3 + k]
        if (mark[w] === s) continue
        mark[w] = s
        push(evaluate(a, w), a, w)
      }
    }
  }

  // ── Main loop ───────────────────────────────────────────────────────────────
  // A collapse rejected for topology/geometry is dropped, not retried in place: its
  // neighbourhood may change later without either endpoint's quadric changing (so no
  // re-push). A further pass re-enumerates the surviving edges to pick those up; it
  // runs only while the previous pass both made progress and left rejections.
  const MAX_PASSES = 8
  let collapses = 0, worstErr2 = 0, passes = 0, rejected = 0
  let stoppedByError = false
  while (live > target && passes < MAX_PASSES && !stoppedByError) {
    passes++
    fillHeap()
    let passCollapses = 0
    rejected = 0
    while (hn > 0 && live > target) {
      pop()
      const a = popA, b = popB
      if (alive[a] !== 1 || alive[b] !== 1 || modTime[a] > popT || modTime[b] > popT) continue
      if (popK > maxErr2) { stoppedByError = true; break }
      evaluate(a, b)
      const x = candX, y = candY, z = candZ, t = candT
      if (!linkOk(a, b) || !geometryOk(a, b, x, y, z)) { rejected++; continue }
      collapse(a, b, x, y, z, t)
      if (popK > worstErr2) worstErr2 = popK
      collapses++; passCollapses++
    }
    if (passCollapses === 0 || rejected === 0) break
  }

  // ── Compact ─────────────────────────────────────────────────────────────────
  const remap = new Int32Array(nV).fill(-1)
  let outTris = 0
  for (let t = 0; t < nT; t++) {
    if (dead[t]) continue
    const a = tri[t * 3], b = tri[t * 3 + 1], c = tri[t * 3 + 2]
    if (a === b || b === c || a === c) continue
    remap[a] = 0; remap[b] = 0; remap[c] = 0
    outTris++
  }
  let outVerts = 0
  for (let v = 0; v < nV; v++) if (remap[v] === 0) remap[v] = outVerts++
  const pos = new Float64Array(outVerts * 3)
  const col = C ? new Uint8Array(outVerts * 3) : null
  for (let v = 0; v < nV; v++) {
    const r = remap[v]
    if (r < 0) continue
    pos[r * 3] = P[v * 3] + ox; pos[r * 3 + 1] = P[v * 3 + 1] + oy; pos[r * 3 + 2] = P[v * 3 + 2] + oz
    if (col) { col[r * 3] = C[v * 3]; col[r * 3 + 1] = C[v * 3 + 1]; col[r * 3 + 2] = C[v * 3 + 2] }
  }
  const idx = new Uint32Array(outTris * 3)
  let o = 0
  for (let t = 0; t < nT; t++) {
    if (dead[t]) continue
    const a = tri[t * 3], b = tri[t * 3 + 1], c = tri[t * 3 + 2]
    if (a === b || b === c || a === c) continue
    idx[o++] = remap[a]; idx[o++] = remap[b]; idx[o++] = remap[c]
  }

  const maxErr = Math.sqrt(worstErr2)
  const ms = Math.round(nowMs() - t0)
  onLog?.(`Decimate: target ${target.toLocaleString()} triangles `
    + `(${hasRatio ? `ratio ${targetRatio}` : 'absolute'}), ${boundaryEdges.toLocaleString()} boundary edges `
    + `${preserveBoundary ? `constrained ×${boundaryWeight}` : 'unconstrained'}, origin `
    + `(${ox.toFixed(3)}, ${oy.toFixed(3)}, ${oz.toFixed(3)})`, 'info', 'Products')
  if (outTris > target) {
    onLog?.(`Decimate: stopped at ${outTris.toLocaleString()} of target ${target.toLocaleString()} — `
      + (stoppedByError ? `next collapse exceeds maxError ${maxError}` : 'no further collapse passes the topology/fold checks'),
    'warn', 'Products')
  }
  onLog?.(`Decimate: ${before.toLocaleString()} → ${outTris.toLocaleString()} triangles, `
    + `${outVerts.toLocaleString()} vertices, ${collapses.toLocaleString()} collapses in ${passes} pass(es), `
    + `max error ${maxErr.toPrecision(3)} (RMS plane distance) in ${ms} ms`, 'success', 'Products')

  return {
    mesh: { nVerts: outVerts, count: outTris, pos, idx, col },
    stats: { before, after: outTris, collapses, maxError: maxErr },
  }
}

// vᵀAv for the homogeneous v = (x,y,z,1) and the symmetric 4×4 in upper-triangle form.
function quadricValue(a11, a12, a13, a14, a22, a23, a24, a33, a34, a44, x, y, z) {
  return a11 * x * x + 2 * a12 * x * y + 2 * a13 * x * z + 2 * a14 * x
    + a22 * y * y + 2 * a23 * y * z + 2 * a24 * y
    + a33 * z * z + 2 * a34 * z + a44
}

function nowMs() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}
