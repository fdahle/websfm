// Pure triangle-mesh editing: cleanup, hole filling, smoothing, crop, surface
// sampling and measurement. No Vue/Pinia/OPFS/DOM — plain data in, plain data out,
// side effects via an injected `onLog(message, level, 'Products')`.
//
// This file holds the Clean Mesh pipeline, crop and measurement and re-exports the
// rest, which lives beside it: meshTopology.js (shared helpers, topology), meshWeld.js
// (weld, compact), meshHoles.js (small pieces, long edges, holes), meshSmooth.js and
// meshSample.js.
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
// A textured mesh (core/products/texture/) also carries `uv` (Float32, 2 per vertex)
// and `page` (Uint16, the atlas page per triangle). Its vertices are split: one copy
// per atlas piece a vertex lies in. Steps that keep or drop triangles and vertices
// carry uv and page along; a triangle a step creates (a filled hole) gets page
// UNTEXTURED, which tells the caller the texture no longer covers the mesh. A weld
// joins only corners with the same UV, or it would erase the chart seams. Everything
// that reads the SURFACE (pieces, holes, boundaries, smoothing, measuring) reads it with
// the copies joined (geometricMesh), so a textured mesh cleans, smooths and measures
// exactly as the same geometry untextured.
//
// Precision: survey coordinates are ~1e6 (UTM / polar stereographic). Lengths,
// areas and volumes are computed from coordinate DIFFERENCES or relative to a local
// origin, never as products of absolute coordinates.

import { componentsStep, holesStep, longEdgesStep } from './meshHoles.js'
import {
  badIndices,
  meshTopology,
  meshTriangleCount,
  meshVertexCount,
  selectTriangles,
  triangleComponents,
} from './meshTopology.js'
import { compactStep, weldLine, weldStep } from './meshWeld.js'

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
    if (!CLEAN_STEPS.includes(m)) onLog?.(`Mesh clean: unknown method "${m}" — skipped`, 'warn', 'Products')
  }
  const stats = { inputTriangles: meshTriangleCount(mesh) }
  let out = mesh
  if (methods.has('weld')) {
    const r = weldStep(out, { epsilon: opts.weldEpsilon ?? null })
    out = r.mesh
    stats.weld = {
      merged: r.merged,
      collapsedTriangles: r.collapsedTriangles,
      epsilon: r.epsilon,
      epsilonSource: r.epsilonSource,
      diagonal: r.diagonal,
      medianEdge: r.medianEdge,
    }
    onLog?.(`Mesh clean (weld): ${weldLine(r, {})}`, 'info', 'Products')
  }
  if (methods.has('components')) {
    const r = componentsStep(out, { minTriangles: opts.minTriangles, minFraction: opts.minFraction })
    out = r.mesh
    stats.components = {
      components: r.components,
      removedComponents: r.removedComponents,
      removedTriangles: r.removedTriangles,
      threshold: r.threshold,
    }
    onLog?.(
      `Mesh clean (components): removed ${r.removedComponents.toLocaleString()} of ${r.components.toLocaleString()} components ` +
        `(${r.removedTriangles.toLocaleString()} triangles, threshold ${Math.ceil(r.threshold).toLocaleString()})`,
      'info',
      'Products',
    )
  }
  if (methods.has('longEdges')) {
    const r = longEdgesStep(out, { maxEdgeFactor: opts.maxEdgeFactor ?? 4 })
    out = r.mesh
    stats.longEdges = { removedTriangles: r.removedTriangles, median: r.median, limit: r.limit }
    onLog?.(
      `Mesh clean (long edges): median ${r.median.toPrecision(4)}, limit ${r.limit.toPrecision(4)} → ` +
        `removed ${r.removedTriangles.toLocaleString()} triangles`,
      'info',
      'Products',
    )
  }
  if (methods.has('holes')) {
    const r = holesStep(out, { maxHoleEdges: opts.maxHoleEdges ?? 64 })
    out = r.mesh
    stats.holes = {
      filled: r.filled,
      skipped: r.skipped,
      tooLarge: r.tooLarge,
      addedTriangles: r.addedTriangles,
      addedVertices: r.addedVertices,
    }
    onLog?.(
      `Mesh clean (holes): filled ${r.filled.toLocaleString()}, left ${r.tooLarge.toLocaleString()} too large, ` +
        `skipped ${r.skipped.toLocaleString()} non-manifold chains`,
      r.skipped ? 'warn' : 'info',
      'Products',
    )
  }
  if (methods.has('compact')) {
    const r = compactStep(out)
    out = r.mesh
    stats.compact = { removedTriangles: r.removedTriangles, removedVertices: r.removedVertices }
    onLog?.(
      `Mesh clean (compact): removed ${r.removedTriangles.toLocaleString()} degenerate triangles, ` +
        `${r.removedVertices.toLocaleString()} unreferenced vertices`,
      'info',
      'Products',
    )
  }
  // Never hand back the input itself — it would alias the source's buffers.
  if (out === mesh)
    out = selectTriangles(mesh, new Uint8Array(meshTriangleCount(mesh)).fill(1), meshTriangleCount(mesh))
  stats.outputTriangles = out.count
  stats.outputVertices = out.nVerts
  onLog?.(
    `Mesh clean: ${stats.inputTriangles.toLocaleString()} → ${out.count.toLocaleString()} triangles`,
    'success',
    'Products',
  )
  return { mesh: out, stats }
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
  const nV = meshVertexCount(mesh),
    nT = meshTriangleCount(mesh)
  const lo = [0, 1, 2].map((i) => (Number.isFinite(min?.[i]) ? min[i] : -Infinity))
  const hi = [0, 1, 2].map((i) => (Number.isFinite(max?.[i]) ? max[i] : Infinity))
  const { pos, idx } = mesh
  const inside = new Uint8Array(nV)
  for (let v = 0; v < nV; v++) {
    const x = pos[v * 3],
      y = pos[v * 3 + 1],
      z = pos[v * 3 + 2]
    if (x >= lo[0] && x <= hi[0] && y >= lo[1] && y <= hi[1] && z >= lo[2] && z <= hi[2]) inside[v] = 1
  }
  const keep = new Uint8Array(nT)
  let kept = 0
  for (let t = 0; t < nT; t++) {
    const a = idx[t * 3],
      b = idx[t * 3 + 1],
      c = idx[t * 3 + 2]
    const all = inside[a] === 1 && inside[b] === 1 && inside[c] === 1
    if (all !== invert) {
      keep[t] = 1
      kept++
    }
  }
  const out = compactStep(selectTriangles(mesh, keep, kept)).mesh
  onLog?.(
    `Mesh crop: kept ${out.count.toLocaleString()} of ${nT.toLocaleString()} triangles` +
      `${invert ? ' (outside box)' : ''}`,
    'info',
    'Products',
  )
  return out
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
  // Positions only: a textured mesh's UV copies of a vertex are one surface vertex.
  const welded = weld ? weldStep(source.uv ? { ...source, uv: null, page: null } : source) : null
  const mesh = welded ? welded.mesh : source
  const nV = meshVertexCount(mesh),
    nT = meshTriangleCount(mesh)
  const topo = meshTopology(mesh)
  const { nComp } = triangleComponents(mesh)
  const { pos, idx } = mesh
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
  const ox = nV ? (minX + maxX) / 2 : 0,
    oy = nV ? (minY + maxY) / 2 : 0,
    oz = nV ? (minZ + maxZ) / 2 : 0
  let area = 0,
    vol6 = 0
  for (let t = 0; t < nT; t++) {
    const a = idx[t * 3],
      b = idx[t * 3 + 1],
      c = idx[t * 3 + 2]
    if (badIndices(a, b, c, nV)) continue
    const ax = pos[a * 3] - ox,
      ay = pos[a * 3 + 1] - oy,
      az = pos[a * 3 + 2] - oz
    const bx = pos[b * 3] - ox,
      by = pos[b * 3 + 1] - oy,
      bz = pos[b * 3 + 2] - oz
    const cx = pos[c * 3] - ox,
      cy = pos[c * 3 + 1] - oy,
      cz = pos[c * 3 + 2] - oz
    const ux = bx - ax,
      uy = by - ay,
      uz = bz - az
    const vx = cx - ax,
      vy = cy - ay,
      vz = cz - az
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx
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

export { meshTriangleCount, meshVertexCount, UNTEXTURED, coincidentVertices, meshTopology } from './meshTopology.js'
export { WELD_REL_BBOX, WELD_REL_EDGE, weldVertices, compactMesh } from './meshWeld.js'
export { removeSmallComponents, removeLongEdges, fillHoles } from './meshHoles.js'
export { taubinSmooth } from './meshSmooth.js'
export { sampleMesh } from './meshSample.js'
