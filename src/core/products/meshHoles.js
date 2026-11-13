// Clean Mesh ▸ small pieces, long edges and hole filling (core/products/meshEdit.js).
// Pure.

import {
  UNTEXTURED,
  badIndices,
  geometricMesh,
  meshTopology,
  meshTriangleCount,
  meshVertexCount,
  selectTriangles,
  triangleComponents,
} from './meshTopology.js'
import { medianEdgeLength } from './meshWeld.js'

// ── Small components ─────────────────────────────────────────────────────────

/**
 * Remove connected components (connectivity through shared vertices) with fewer than
 * `max(minTriangles, minFraction × largest component's triangles)` triangles — the
 * floating specks Poisson inflates around stray samples. Vertices are kept (run
 * `compactMesh` to drop the orphans).
 *
 * opts: { minTriangles = 0, minFraction = 0 } → { mesh, components, removedComponents, removedTriangles, threshold }
 */
export function componentsStep(mesh, { minTriangles = 0, minFraction = 0 } = {}) {
  const nT = meshTriangleCount(mesh)
  if (!nT)
    return {
      mesh: selectTriangles(mesh, new Uint8Array(0), 0),
      components: 0,
      removedComponents: 0,
      removedTriangles: 0,
      threshold: 0,
    }
  // A textured mesh's pieces are atlas pieces, not surface pieces: join its UV copies.
  const { compOfTri, compTris, nComp } = triangleComponents(geometricMesh(mesh)?.mesh ?? mesh)
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
    if (c >= 0 && keepComp[c]) {
      keep[t] = 1
      kept++
    }
  }
  return {
    mesh: selectTriangles(mesh, keep, kept),
    components: nComp,
    removedComponents,
    removedTriangles: nT - kept,
    threshold,
  }
}

// ── Long edges ───────────────────────────────────────────────────────────────

/**
 * Drop triangles with any edge longer than `maxEdgeFactor × median edge length` —
 * the stretched "bridge" triangles screened Poisson spans across data gaps. The
 * median comes from a deterministic sample of at most ~1 M half-edges. A degenerate
 * (all zero-length) mesh or `maxEdgeFactor <= 0` removes nothing.
 *
 * opts: { maxEdgeFactor = 4 } → { mesh, median, limit, removedTriangles }
 */
export function longEdgesStep(mesh, { maxEdgeFactor = 4 } = {}) {
  const nV = meshVertexCount(mesh),
    nT = meshTriangleCount(mesh)
  const { pos, idx } = mesh
  const len2 = (h) => {
    const a = idx[h],
      b = idx[h % 3 === 2 ? h - 2 : h + 1]
    const dx = pos[b * 3] - pos[a * 3],
      dy = pos[b * 3 + 1] - pos[a * 3 + 1],
      dz = pos[b * 3 + 2] - pos[a * 3 + 2]
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
    keep[t] = 1
    kept++
  }
  return { mesh: selectTriangles(mesh, keep, kept), removedTriangles: nT - kept, median, limit: Math.sqrt(limit2) }
}

// ── Hole filling ─────────────────────────────────────────────────────────────

// Holes of the surface. A textured mesh's piece outlines are boundaries only in the
// atlas: the loops are found with its UV copies joined, and the caps then reference
// one copy of each loop vertex (any copy: they share the position).
export function holesStep(mesh, opts = {}) {
  const g = geometricMesh(mesh)
  if (!g) return holesOnSurface(mesh, opts)
  const r = holesOnSurface(g.mesh, opts)
  const nV = meshVertexCount(mesh),
    nT = meshTriangleCount(mesh),
    m = g.mesh.nVerts
  if (!r.addedTriangles) return { ...r, mesh: selectTriangles(mesh, new Uint8Array(nT).fill(1), nT) } // a copy, never the input
  const nAddV = r.addedVertices,
    nAddT = r.addedTriangles
  const pos = new Float64Array((nV + nAddV) * 3)
  pos.set(mesh.pos.subarray(0, nV * 3))
  pos.set(r.mesh.pos.subarray(m * 3), nV * 3)
  let col = null
  if (mesh.col) {
    col = new Uint8Array((nV + nAddV) * 3)
    col.set(mesh.col.subarray(0, nV * 3))
    col.set(r.mesh.col.subarray(m * 3), nV * 3)
  }
  const idx = new Uint32Array((nT + nAddT) * 3)
  idx.set(mesh.idx.subarray(0, nT * 3))
  const add = r.mesh.idx.subarray(nT * 3)
  for (let i = 0; i < add.length; i++) idx[nT * 3 + i] = add[i] < m ? g.first[add[i]] : nV + (add[i] - m)
  // The caps' centre vertices get UV 0 and their triangles no page.
  const uv = new Float32Array((nV + nAddV) * 2)
  uv.set(mesh.uv.subarray(0, nV * 2))
  let page = null
  if (mesh.page) {
    page = new Uint16Array(nT + nAddT).fill(UNTEXTURED)
    page.set(mesh.page.subarray(0, nT))
  }
  return { ...r, mesh: { nVerts: nV + nAddV, count: nT + nAddT, pos, idx, col, uv, ...(page ? { page } : {}) } }
}

function holesOnSurface(mesh, { maxHoleEdges = 64 } = {}) {
  const nV = meshVertexCount(mesh),
    nT = meshTriangleCount(mesh)
  const { pos, idx } = mesh
  const limit = Number.isFinite(maxHoleEdges) && maxHoleEdges > 0 ? maxHoleEdges : Infinity
  const topo = meshTopology(mesh)
  const { edgeOfHalf, incidence } = topo
  const H = nT * 3
  const endOf = (h) => idx[h % 3 === 2 ? h - 2 : h + 1]

  // Boundary half-edges, indexed by their start vertex (CSR), plus in/out degrees.
  const outCnt = new Uint32Array(nV),
    inCnt = new Uint32Array(nV)
  let nb = 0
  for (let h = 0; h < H; h++) {
    const e = edgeOfHalf[h]
    if (e < 0 || incidence[e] !== 1) continue
    outCnt[idx[h]]++
    inCnt[endOf(h)]++
    nb++
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
  const loopV = new Uint32Array(nb),
    loopH = new Int32Array(nb)
  const visited = new Uint8Array(H)
  let nAddT = 0,
    nAddV = 0,
    filled = 0,
    skipped = 0,
    tooLarge = 0

  for (let i = 0; i < nb; i++) {
    const h0 = outList[i]
    if (visited[h0]) continue
    // Walk the chain in half-edge direction. A vertex with boundary in/out degree ≠ 1
    // (a bowtie / non-manifold vertex) makes the continuation ambiguous: abandon it.
    let h = h0,
      len = 0,
      ok = true
    for (;;) {
      visited[h] = 1
      loopV[len] = idx[h]
      loopH[len] = h
      len++
      const v = endOf(h)
      if (outCnt[v] !== 1 || inCnt[v] !== 1) {
        ok = false
        break
      }
      h = outList[outStart[v]]
      if (h === h0) break
      if (visited[h]) {
        ok = false
        break
      }
    }
    if (!ok) {
      skipped++
      continue
    }
    if (len > limit) {
      tooLarge++
      continue
    }
    // A lone triangle's own rim is a 3-loop; capping it would glue a back face onto it.
    if (len === 3 && ((loopH[0] / 3) | 0) === ((loopH[1] / 3) | 0) && ((loopH[1] / 3) | 0) === ((loopH[2] / 3) | 0)) {
      skipped++
      continue
    }
    // The existing triangles run each boundary edge a→b, so the cap must run it b→a.
    if (len === 3) {
      addIdx[nAddT * 3] = loopV[0]
      addIdx[nAddT * 3 + 1] = loopV[2]
      addIdx[nAddT * 3 + 2] = loopV[1]
      nAddT++
    } else {
      // Centroid fan, centroid accumulated relative to the first loop vertex.
      const o = loopV[0] * 3
      let sx = 0,
        sy = 0,
        sz = 0,
        r = 0,
        g = 0,
        b = 0
      for (let k = 0; k < len; k++) {
        const p = loopV[k] * 3
        sx += pos[p] - pos[o]
        sy += pos[p + 1] - pos[o + 1]
        sz += pos[p + 2] - pos[o + 2]
        if (hasCol) {
          r += mesh.col[p]
          g += mesh.col[p + 1]
          b += mesh.col[p + 2]
        }
      }
      const d = nAddV * 3
      addPos[d] = pos[o] + sx / len
      addPos[d + 1] = pos[o + 1] + sy / len
      addPos[d + 2] = pos[o + 2] + sz / len
      if (hasCol) {
        addCol[d] = Math.round(r / len)
        addCol[d + 1] = Math.round(g / len)
        addCol[d + 2] = Math.round(b / len)
      }
      const c = nV + nAddV
      nAddV++
      for (let k = 0; k < len; k++) {
        const a = loopV[k],
          bb = loopV[k + 1 === len ? 0 : k + 1]
        addIdx[nAddT * 3] = bb
        addIdx[nAddT * 3 + 1] = a
        addIdx[nAddT * 3 + 2] = c
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
  // A textured mesh: the cap's centre vertices get UV 0 and its triangles no page.
  let tex = {}
  if (mesh.uv) {
    const uv = new Float32Array((nV + nAddV) * 2)
    uv.set(mesh.uv.subarray(0, nV * 2))
    let page
    if (mesh.page) {
      page = new Uint16Array(nT + nAddT).fill(UNTEXTURED)
      page.set(mesh.page.subarray(0, nT))
    }
    tex = { uv, ...(page ? { page } : {}) }
  }
  return {
    mesh: { nVerts: nV + nAddV, count: nT + nAddT, pos: outPos, idx: outIdx, col: outCol, ...tex },
    filled,
    skipped,
    tooLarge,
    addedTriangles: nAddT,
    addedVertices: nAddV,
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
  onLog?.(
    `Mesh holes: filled ${r.filled.toLocaleString()} (+${r.addedTriangles.toLocaleString()} triangles), ` +
      `left ${r.tooLarge.toLocaleString()} above ${opts.maxHoleEdges ?? 64} edges, ` +
      `skipped ${r.skipped.toLocaleString()} non-manifold chains`,
    r.skipped ? 'warn' : 'info',
    'Products',
  )
  return r
}
