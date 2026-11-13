// Smooth Mesh: Taubin λ|μ smoothing (core/products/meshEdit.js). Pure.

import { geometricMesh, meshTopology, meshTriangleCount, meshVertexCount, selectTriangles } from './meshTopology.js'

// ── Smoothing ────────────────────────────────────────────────────────────────

/**
 * Taubin λ/μ smoothing (Taubin 1995): alternating a shrinking Laplacian step (λ > 0)
 * with an inflating one (μ < −λ), a low-pass filter that removes surface noise without
 * the volume loss of plain Laplacian smoothing. One iteration = one λ pass + one μ pass.
 * The Laplacian is the uniform umbrella operator over the vertex one-ring (CSR from
 * the unique edges). With `fixBoundary`, every vertex on a boundary or non-manifold
 * edge stays put, so an open terrain mesh keeps its rim. Topology and colour unchanged.
 * A textured mesh is smoothed as its surface (geometricMesh): every UV copy of a vertex
 * moves the same way, so the chart seams neither open nor count as boundary.
 *
 * opts: { iterations = 10, lambda = 0.5, mu = -0.53, fixBoundary = true }
 */
export function taubinSmooth(mesh, opts = {}, onLog) {
  const { iterations = 10, lambda = 0.5, mu = -0.53, fixBoundary = true } = opts
  const nV = meshVertexCount(mesh),
    nT = meshTriangleCount(mesh)
  const out = selectTriangles(mesh, new Uint8Array(nT).fill(1), nT)
  const iters = Math.max(0, Math.floor(iterations) || 0)
  if (!nV || !nT || !iters) return out
  const g = geometricMesh(mesh)
  if (g) {
    const s = taubinSmooth(g.mesh, opts, onLog)
    for (let v = 0; v < nV; v++) {
      const o = g.id[v] * 3
      out.pos[v * 3] = s.pos[o]
      out.pos[v * 3 + 1] = s.pos[o + 1]
      out.pos[v * 3 + 2] = s.pos[o + 2]
    }
    return out
  }
  const topo = meshTopology(mesh)
  const { edges: E, edgeLo, edgeHi, incidence } = topo
  const start = new Uint32Array(nV + 1)
  for (let e = 0; e < E; e++) {
    start[edgeLo[e] + 1]++
    start[edgeHi[e] + 1]++
  }
  for (let v = 0; v < nV; v++) start[v + 1] += start[v]
  const fillAt = start.slice(0, nV)
  const nbr = new Uint32Array(E * 2)
  const fixed = new Uint8Array(nV)
  for (let e = 0; e < E; e++) {
    const a = edgeLo[e],
      b = edgeHi[e]
    nbr[fillAt[a]++] = b
    nbr[fillAt[b]++] = a
    if (fixBoundary && incidence[e] !== 2) {
      fixed[a] = 1
      fixed[b] = 1
    }
  }
  // Work relative to the first vertex: averaging ~1e6 coordinates is exact enough in
  // Float64, but the subtraction keeps the per-pass deltas at full relative precision.
  const ox = out.pos[0],
    oy = out.pos[1],
    oz = out.pos[2]
  let cur = new Float64Array(nV * 3)
  for (let v = 0; v < nV; v++) {
    cur[v * 3] = out.pos[v * 3] - ox
    cur[v * 3 + 1] = out.pos[v * 3 + 1] - oy
    cur[v * 3 + 2] = out.pos[v * 3 + 2] - oz
  }
  let nxt = new Float64Array(nV * 3)
  for (let pass = 0; pass < iters * 2; pass++) {
    const f = pass % 2 === 0 ? lambda : mu
    for (let v = 0; v < nV; v++) {
      const s = start[v],
        e = start[v + 1],
        p = v * 3
      if (e === s || fixed[v]) {
        nxt[p] = cur[p]
        nxt[p + 1] = cur[p + 1]
        nxt[p + 2] = cur[p + 2]
        continue
      }
      let mx = 0,
        my = 0,
        mz = 0
      for (let k = s; k < e; k++) {
        const q = nbr[k] * 3
        mx += cur[q]
        my += cur[q + 1]
        mz += cur[q + 2]
      }
      const inv = 1 / (e - s)
      nxt[p] = cur[p] + f * (mx * inv - cur[p])
      nxt[p + 1] = cur[p + 1] + f * (my * inv - cur[p + 1])
      nxt[p + 2] = cur[p + 2] + f * (mz * inv - cur[p + 2])
    }
    const t = cur
    cur = nxt
    nxt = t
  }
  let maxMove2 = 0,
    nFixed = 0
  for (let v = 0; v < nV; v++) {
    const p = v * 3
    const x = cur[p] + ox,
      y = cur[p + 1] + oy,
      z = cur[p + 2] + oz
    const dx = x - out.pos[p],
      dy = y - out.pos[p + 1],
      dz = z - out.pos[p + 2]
    const d2 = dx * dx + dy * dy + dz * dz
    if (d2 > maxMove2) maxMove2 = d2
    out.pos[p] = x
    out.pos[p + 1] = y
    out.pos[p + 2] = z
    nFixed += fixed[v]
  }
  onLog?.(
    `Mesh smooth (Taubin λ=${lambda}, μ=${mu}, ${iters} iterations): ${nV.toLocaleString()} vertices, ` +
      `${nFixed.toLocaleString()} fixed on the boundary, max displacement ${Math.sqrt(maxMove2).toPrecision(4)}`,
    'info',
    'Products',
  )
  return out
}
