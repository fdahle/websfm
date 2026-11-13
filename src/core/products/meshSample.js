// Mesh to Points: area-weighted random samples of a mesh surface, coloured by vertex
// colour or texture (core/products/meshEdit.js). Pure.

import { sampleRgbaBilinear } from './undistort.js'
import { badIndices, meshTriangleCount, meshVertexCount } from './meshTopology.js'

// ── Surface sampling ─────────────────────────────────────────────────────────

/** mulberry32: a tiny, fast, deterministic 32-bit PRNG returning [0, 1). */
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
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
 * A textured mesh with `texture` = { pages: [{ width, height, data (RGBA) }] } takes
 * each point's colour from the atlas instead, at its interpolated UV on its
 * triangle's page: the photo's detail rather than the blur of vertex colours. A
 * triangle without a page falls back to the vertex colours.
 *
 * opts: { count = 1_000_000, seed = 1, texture? }
 */
export function sampleMesh(mesh, { count = 1_000_000, seed = 1, texture = null } = {}, onLog) {
  const nV = meshVertexCount(mesh),
    nT = meshTriangleCount(mesh)
  const tex = texture?.pages?.length && mesh.uv && mesh.page ? texture.pages : null
  const hasCol = !!mesh.col || !!tex
  const empty = { count: 0, pos: new Float64Array(0), col: hasCol ? new Uint8Array(0) : null, nrm: new Float32Array(0) }
  const N = Math.max(0, Math.floor(count) || 0)
  if (!nT || !N) return empty
  const { pos, idx, col, uv, page } = mesh
  const px = new Float32Array(4)
  const cum = new Float64Array(nT)
  let total = 0
  for (let t = 0; t < nT; t++) {
    const a = idx[t * 3],
      b = idx[t * 3 + 1],
      c = idx[t * 3 + 2]
    if (!badIndices(a, b, c, nV)) {
      const ux = pos[b * 3] - pos[a * 3],
        uy = pos[b * 3 + 1] - pos[a * 3 + 1],
        uz = pos[b * 3 + 2] - pos[a * 3 + 2]
      const vx = pos[c * 3] - pos[a * 3],
        vy = pos[c * 3 + 1] - pos[a * 3 + 1],
        vz = pos[c * 3 + 2] - pos[a * 3 + 2]
      const cx = uy * vz - uz * vy,
        cy = uz * vx - ux * vz,
        cz = ux * vy - uy * vx
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
    let lo = 0,
      hi = nT - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (cum[mid] > r) hi = mid
      else lo = mid + 1
    }
    const t = lo
    const a = idx[t * 3],
      b = idx[t * 3 + 1],
      c = idx[t * 3 + 2]
    const s1 = Math.sqrt(rand()),
      u2 = rand()
    const wb = s1 * (1 - u2),
      wc = s1 * u2,
      wa = 1 - wb - wc
    const ux = pos[b * 3] - pos[a * 3],
      uy = pos[b * 3 + 1] - pos[a * 3 + 1],
      uz = pos[b * 3 + 2] - pos[a * 3 + 2]
    const vx = pos[c * 3] - pos[a * 3],
      vy = pos[c * 3 + 1] - pos[a * 3 + 1],
      vz = pos[c * 3 + 2] - pos[a * 3 + 2]
    const d = i * 3
    // p = a + wb·(b−a) + wc·(c−a): offsets, not a weighted sum of ~1e6 coordinates.
    outPos[d] = pos[a * 3] + wb * ux + wc * vx
    outPos[d + 1] = pos[a * 3 + 1] + wb * uy + wc * vy
    outPos[d + 2] = pos[a * 3 + 2] + wb * uz + wc * vz
    const cx = uy * vz - uz * vy,
      cy = uz * vx - ux * vz,
      cz = ux * vy - uy * vx
    const inv = 1 / Math.sqrt(cx * cx + cy * cy + cz * cz)
    outNrm[d] = cx * inv
    outNrm[d + 1] = cy * inv
    outNrm[d + 2] = cz * inv
    const pg = tex ? tex[page[t]] : null
    if (pg) {
      const u = wa * uv[a * 2] + wb * uv[b * 2] + wc * uv[c * 2],
        v = wa * uv[a * 2 + 1] + wb * uv[b * 2 + 1] + wc * uv[c * 2 + 1]
      sampleRgbaBilinear(pg.data, pg.width, pg.height, u * pg.width - 0.5, v * pg.height - 0.5, px, 0)
      outCol[d] = Math.round(px[0])
      outCol[d + 1] = Math.round(px[1])
      outCol[d + 2] = Math.round(px[2])
    } else if (outCol && col) {
      for (let k = 0; k < 3; k++)
        outCol[d + k] = Math.round(wa * col[a * 3 + k] + wb * col[b * 3 + k] + wc * col[c * 3 + k])
    } else if (outCol) outCol.fill(128, d, d + 3)
  }
  onLog?.(
    `Mesh sample: ${N.toLocaleString()} points over area ${total.toPrecision(6)} ` +
      `(${(N / total).toPrecision(4)} per unit²), seed ${seed}${tex ? ', colour from the texture' : ''}`,
    'info',
    'Products',
  )
  return { count: N, pos: outPos, col: outCol, nrm: outNrm }
}
