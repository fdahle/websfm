// Clean Mesh ▸ weld and compact (core/products/meshEdit.js): join coincident vertices
// within a tolerance, then drop unused vertices and degenerate triangles. Pure.

import { badIndices, emptyMesh, meshTriangleCount, meshVertexCount } from './meshTopology.js'

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
export function medianEdgeLength(mesh) {
  const nV = meshVertexCount(mesh),
    nT = meshTriangleCount(mesh)
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
    const a = idx[h],
      b = idx[h % 3 === 2 ? h - 2 : h + 1]
    const dx = pos[b * 3] - pos[a * 3],
      dy = pos[b * 3 + 1] - pos[a * 3 + 1],
      dz = pos[b * 3 + 2] - pos[a * 3 + 2]
    const d2 = dx * dx + dy * dy + dz * dz
    if (d2 === d2) sample[m++] = d2 // NaN-free
  }
  const s = sample.subarray(0, m).sort()
  return m ? Math.sqrt(s[m >> 1]) : 0
}

export function weldStep(mesh, { epsilon = null, relBbox = WELD_REL_BBOX, relEdge = WELD_REL_EDGE } = {}) {
  const nV = meshVertexCount(mesh),
    nT = meshTriangleCount(mesh)
  const { pos, idx } = mesh
  const uv = mesh.uv ?? null
  const hasCol = !!mesh.col
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity
  for (let v = 0; v < nV; v++) {
    const x = pos[v * 3],
      y = pos[v * 3 + 1],
      z = pos[v * 3 + 2]
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }
  const diagonal = minX <= maxX ? Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) : 0
  const medianEdge = medianEdgeLength(mesh)
  let eps,
    epsilonSource = 'auto'
  if (epsilon != null && epsilon >= 0) {
    eps = epsilon
    epsilonSource = 'given'
  } else {
    const byBox = relBbox * diagonal
    // Zero-length edges are exactly the corners a weld is for: an all-duplicate median
    // says nothing about spacing, so the bbox term alone decides then.
    eps = medianEdge > 0 ? Math.min(byBox, relEdge * medianEdge) : byBox
  }
  // Grid cell ≥ ε, so every vertex within ε of a point lies in its 27-cell block. With
  // ε = 0 the weld is exact-coincidence only; any positive cell then works.
  const cell = eps > 0 ? eps : diagonal > 0 ? diagonal : 1
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
    const x = pos[v * 3],
      y = pos[v * 3 + 1],
      z = pos[v * 3 + 2]
    const fx = (x - minX) / cell,
      fy = (y - minY) / cell,
      fz = (z - minZ) / cell
    if (!(Number.isFinite(fx) && Number.isFinite(fy) && Number.isFinite(fz))) {
      newId[v] = m
      repOf[m++] = v // a NaN corner welds to nothing
      continue
    }
    const ix = Math.floor(fx),
      iy = Math.floor(fy),
      iz = Math.floor(fz)
    let best = -1,
      bestD2 = Infinity
    for (let dz = -1; dz <= 1; dz++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          for (let r = head[hash(ix + dx, iy + dy, iz + dz)]; r >= 0; r = next[r]) {
            const o = repOf[r] * 3
            const ex = pos[o] - x,
              ey = pos[o + 1] - y,
              ez = pos[o + 2] - z
            const d2 = ex * ex + ey * ey + ez * ez
            // Same UV too, on a textured mesh: a seam vertex has one copy per chart.
            if (
              uv &&
              (Math.abs(uv[repOf[r] * 2] - uv[v * 2]) > 1e-7 || Math.abs(uv[repOf[r] * 2 + 1] - uv[v * 2 + 1]) > 1e-7)
            )
              continue
            // Nearest representative; ties go to the earlier one (lower new id).
            if (d2 <= eps2 && (d2 < bestD2 || (d2 === bestD2 && r < best))) {
              best = r
              bestD2 = d2
            }
          }
        }
    if (best >= 0) {
      newId[v] = best
      continue
    }
    newId[v] = m
    repOf[m] = v
    const h = hash(ix, iy, iz)
    next[m] = head[h]
    head[h] = m
    m++
  }

  const outPos = new Float64Array(m * 3)
  const outCol = hasCol ? new Uint8Array(m * 3) : null
  const outUv = uv ? new Float32Array(m * 2) : null
  for (let r = 0; r < m; r++) {
    const o = repOf[r] * 3,
      d = r * 3
    outPos[d] = pos[o]
    outPos[d + 1] = pos[o + 1]
    outPos[d + 2] = pos[o + 2]
    if (outCol) {
      outCol[d] = mesh.col[o]
      outCol[d + 1] = mesh.col[o + 1]
      outCol[d + 2] = mesh.col[o + 2]
    }
    if (outUv) {
      outUv[r * 2] = uv[repOf[r] * 2]
      outUv[r * 2 + 1] = uv[repOf[r] * 2 + 1]
    }
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
    if (!badIndices(idx[s], idx[s + 1], idx[s + 2], nV) && badIndices(outIdx[s], outIdx[s + 1], outIdx[s + 2], m))
      collapsed++
  }
  return {
    mesh: {
      nVerts: m,
      count: nT,
      pos: outPos,
      idx: outIdx,
      col: outCol,
      ...(outUv ? { uv: outUv, ...(mesh.page ? { page: mesh.page.slice(0, nT) } : {}) } : {}),
    },
    merged: nV - m,
    collapsedTriangles: collapsed,
    epsilon: eps,
    epsilonSource,
    diagonal,
    medianEdge,
  }
}

export const weldLine = (r, opts) =>
  `ε ${r.epsilon.toPrecision(3)} (` +
  (r.epsilonSource === 'given' ? 'given' : `min of ${opts.relBbox ?? WELD_REL_BBOX} × bbox diagonal`) +
  ` ${r.diagonal.toPrecision(4)}; ${r.epsilonSource === 'given' ? 'median edge' : `${opts.relEdge ?? WELD_REL_EDGE} × median edge`}` +
  ` ${r.medianEdge.toPrecision(4)}) → merged ${r.merged.toLocaleString()} duplicate vertices` +
  (r.collapsedTriangles ? `, ${r.collapsedTriangles.toLocaleString()} triangles collapsed` : '')

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

export function compactStep(mesh) {
  const nV = meshVertexCount(mesh),
    nT = meshTriangleCount(mesh)
  const hasCol = !!mesh.col
  if (!nT) return { mesh: emptyMesh(hasCol), removedTriangles: 0, removedVertices: nV }
  const { pos, idx } = mesh
  const keep = new Uint8Array(nT)
  const remap = new Int32Array(nV).fill(-1)
  let kept = 0
  for (let t = 0; t < nT; t++) {
    const a = idx[t * 3],
      b = idx[t * 3 + 1],
      c = idx[t * 3 + 2]
    if (badIndices(a, b, c, nV)) continue
    const ux = pos[b * 3] - pos[a * 3],
      uy = pos[b * 3 + 1] - pos[a * 3 + 1],
      uz = pos[b * 3 + 2] - pos[a * 3 + 2]
    const vx = pos[c * 3] - pos[a * 3],
      vy = pos[c * 3 + 1] - pos[a * 3 + 1],
      vz = pos[c * 3 + 2] - pos[a * 3 + 2]
    const wx = vx - ux,
      wy = vy - uy,
      wz = vz - uz
    const cx = uy * vz - uz * vy,
      cy = uz * vx - ux * vz,
      cz = ux * vy - uy * vx
    const cross2 = cx * cx + cy * cy + cz * cz
    const maxE2 = Math.max(ux * ux + uy * uy + uz * uz, vx * vx + vy * vy + vz * vz, wx * wx + wy * wy + wz * wz)
    if (!(cross2 > ZERO_AREA_REL * ZERO_AREA_REL * maxE2 * maxE2)) continue // also rejects NaN
    keep[t] = 1
    kept++
    remap[a] = 0
    remap[b] = 0
    remap[c] = 0
  }
  // New ids in original vertex order, so a compacted mesh stays diffable to its source.
  let m = 0
  for (let v = 0; v < nV; v++) if (remap[v] === 0) remap[v] = m++
  const outPos = new Float64Array(m * 3)
  const outCol = hasCol ? new Uint8Array(m * 3) : null
  const outUv = mesh.uv ? new Float32Array(m * 2) : null
  for (let v = 0; v < nV; v++) {
    const d = remap[v]
    if (d < 0) continue
    outPos[d * 3] = pos[v * 3]
    outPos[d * 3 + 1] = pos[v * 3 + 1]
    outPos[d * 3 + 2] = pos[v * 3 + 2]
    if (outCol) {
      outCol[d * 3] = mesh.col[v * 3]
      outCol[d * 3 + 1] = mesh.col[v * 3 + 1]
      outCol[d * 3 + 2] = mesh.col[v * 3 + 2]
    }
    if (outUv) {
      outUv[d * 2] = mesh.uv[v * 2]
      outUv[d * 2 + 1] = mesh.uv[v * 2 + 1]
    }
  }
  const outIdx = new Uint32Array(kept * 3)
  const outPage = mesh.uv && mesh.page ? new Uint16Array(kept) : null
  let o = 0
  for (let t = 0; t < nT; t++) {
    if (!keep[t]) continue
    if (outPage) outPage[o / 3] = mesh.page[t]
    outIdx[o++] = remap[idx[t * 3]]
    outIdx[o++] = remap[idx[t * 3 + 1]]
    outIdx[o++] = remap[idx[t * 3 + 2]]
  }
  return {
    mesh: {
      nVerts: m,
      count: kept,
      pos: outPos,
      idx: outIdx,
      col: outCol,
      ...(outUv ? { uv: outUv, ...(outPage ? { page: outPage } : {}) } : {}),
    },
    removedTriangles: nT - kept,
    removedVertices: nV - m,
  }
}

/**
 * Drop degenerate triangles (a repeated or out-of-range vertex index, or zero area)
 * and every vertex no remaining triangle references; indices are remapped, surviving
 * vertices keep their relative order. Does NOT weld coincident vertices.
 */
export function compactMesh(mesh, onLog) {
  const r = compactStep(mesh)
  onLog?.(
    `Mesh compact: removed ${r.removedTriangles.toLocaleString()} degenerate triangles, ` +
      `${r.removedVertices.toLocaleString()} unreferenced vertices`,
    'info',
    'Products',
  )
  return r.mesh
}
