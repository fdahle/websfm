// Cloud-to-cloud (C2C) and cloud-to-mesh (C2M) distances — change detection
// between epochs, checking a cloud against a reference model. Pure, no
// Vue/Pinia/OPFS/DOM — plain data in, plain data out, side effects via the
// injected `onLog` / `onProgress`.
//
// Output is one Float32Array per source point (NaN = nothing within maxDistance)
// plus summary stats; colouring/attribute storage is the caller's business.
//
// C2C: exact nearest neighbour via core/products/knn.js (the one neighbour index).
// With k ≥ 3 the distance is to the least-squares plane through the k nearest
// reference points instead (CloudCompare's "local model"), which removes the
// sampling-spacing floor a nearest-POINT distance has on a sparse reference.
//
// C2M: exact point-to-triangle distance (Ericson, Real-Time Collision Detection
// §5.1.5). Candidate triangles come from a k-d tree over triangle CENTROIDS. Each
// triangle T has a bounding radius r_T = max |vertex − centroid|, so every point of T
// lies within r_T of its centroid c_T, and for any query x
//     dist(x, T) ≥ |x − c_T| − r_T.
// With d* the best exact distance found so far, a triangle can only beat it if
// |x − c_T| < d* + r_T ≤ d* + R_max. Querying ALL centroids within d* + R_max
// (growing k until the k-th centroid lies beyond that radius) therefore visits every
// triangle that could be closer — the result is exact, not an approximation, and
// the per-candidate bound skips the exact test for most of them. One huge triangle
// would inflate R_max for every query, so triangles are binned into radius tiers
// (powers of two above twice the median radius), each with its own tree and R_max.
// (Note r_T is the radius about the centroid, not the circumradius: for an obtuse
// triangle the circumradius is larger than needed, for some acute ones it is too
// small to bound the triangle about its centroid.)
//
// Precision: distances are computed relative to the query point in double
// precision, so survey coordinates (~1e6) in Float32 or Float64 buffers lose nothing.
//
// Sign conventions:
//   C2C — positive when the source point lies on the side the reference normal at
//         its nearest point points to: sign(dot(source − nearest, n)) × |d|. Needs
//         reference `nrm`; with k ≥ 3 the plane normal is oriented to agree with the
//         neighbours' normals.
//   C2M — positive on the side the closest triangle's face normal points to, the
//         normal taken from the stored winding (right-hand rule: counter-clockwise
//         seen from the positive side). Where the closest feature is an edge or vertex
//         shared by faces of differing orientation (sharp creases), the sign follows
//         whichever of the equidistant faces was found first.
//
// Dense-scale invariant: typed arrays only, no per-point objects; inputs are never
// mutated.

import { buildKnnIndex, knnQuery } from './knn.js'
import { eigenSym3 } from './cloudNormals.js'

function countOf(cloud) {
  if (!cloud?.pos) return 0
  return cloud.count ?? Math.floor(cloud.pos.length / 3)
}

// ── Stats ────────────────────────────────────────────────────────────────────

// Linear-interpolated quantile of an ascending array (type 7).
function quantile(sorted, p) {
  const n = sorted.length
  if (!n) return NaN
  const h = (n - 1) * p, lo = Math.floor(h), hi = Math.min(n - 1, lo + 1)
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo])
}

/**
 * Summary statistics of a distance array, ignoring NaN.
 * mean/median/p95/min/max are of the values as given (signed when signed);
 * rms, meanAbs and p95Abs describe magnitudes.
 * @param {ArrayLike<number>} distances
 * @returns {{ mean, median, rms, p95, min, max, meanAbs, p95Abs, validCount }} — NaN
 *   fields when nothing is valid
 */
export function distanceStats(distances) {
  const n = distances.length
  let valid = 0
  for (let i = 0; i < n; i++) if (distances[i] === distances[i]) valid++
  const vals = new Float64Array(valid), abs = new Float64Array(valid)
  let j = 0, sum = 0, sumAbs = 0, sum2 = 0
  for (let i = 0; i < n; i++) {
    const d = distances[i]
    if (d !== d) continue
    vals[j] = d; abs[j] = Math.abs(d); j++
    sum += d; sumAbs += Math.abs(d); sum2 += d * d
  }
  vals.sort(); abs.sort()
  return {
    mean: valid ? sum / valid : NaN,
    median: quantile(vals, 0.5),
    rms: valid ? Math.sqrt(sum2 / valid) : NaN,
    p95: quantile(vals, 0.95),
    min: valid ? vals[0] : NaN,
    max: valid ? vals[valid - 1] : NaN,
    meanAbs: valid ? sumAbs / valid : NaN,
    p95Abs: quantile(abs, 0.95),
    validCount: valid,
  }
}

const fmtStats = (s) => `mean ${s.mean.toPrecision(4)}, median ${s.median.toPrecision(4)}, ` +
  `RMS ${s.rms.toPrecision(4)}, p95 ${s.p95.toPrecision(4)}, range ${s.min.toPrecision(4)} … ${s.max.toPrecision(4)}`

// ── Cloud to cloud ───────────────────────────────────────────────────────────

// A plane fit whose middle eigenvalue is this small relative to the largest is a
// line — no plane; the nearest-point distance is used instead.
const LINEAR_REL = 1e-10

/**
 * Distance from every source point to the reference cloud.
 * @param {{count?, pos}} source
 * @param {{count?, pos, nrm?}} reference
 * @param {object} [opts]
 * @param {number} [opts.maxDistance=Infinity] no reference point strictly within this
 *   ⇒ NaN
 * @param {boolean|'auto'} [opts.signed='auto'] 'auto' ⇒ signed iff the reference has
 *   normals; true without normals logs a warning and stays unsigned
 * @param {number} [opts.k=1] 1 ⇒ nearest point; ≥ 3 ⇒ distance to the least-squares
 *   plane through the k nearest reference points (falls back to the nearest point
 *   when fewer than 3 lie within maxDistance or they are collinear); 2 behaves as 1
 * @param {(msg:string, level?:string, source?:string)=>void} [onLog]
 * @param {(fraction:number)=>void} [onProgress]
 * @returns {{ distance: Float32Array, stats: object, signed: boolean }}
 */
export function cloudToCloudDistance(source, reference, opts = {}, onLog, onProgress) {
  const log = (msg, level = 'info') => onLog?.(msg, level, 'Products')
  const { maxDistance = Infinity, signed = 'auto' } = opts
  const k = Math.max(1, Math.floor(Number(opts.k ?? 1)) || 1)
  const usePlane = k >= 3
  const n = countOf(source), m = countOf(reference)
  const distance = new Float32Array(n).fill(NaN)
  const refNrm = reference?.nrm && reference.nrm.length >= m * 3 ? reference.nrm : null
  let useSign = signed === 'auto' ? !!refNrm : !!signed
  if (useSign && !refNrm) {
    log('C2C: the reference has no normals — distances are unsigned', 'warn')
    useSign = false
  }
  if (!n || !m) {
    onProgress?.(1)
    return { distance, stats: distanceStats(distance), signed: useSign }
  }
  log(`C2C: ${n.toLocaleString()} source pts vs ${m.toLocaleString()} reference pts · ` +
    `${usePlane ? `local plane (k=${k})` : 'nearest point'} · ${useSign ? 'signed (reference normals)' : 'unsigned'}` +
    (Number.isFinite(maxDistance) ? ` · maxDistance ${maxDistance}` : ''))
  const t0 = Date.now()
  const index = buildKnnIndex(reference)
  const rp = reference.pos, sp = source.pos
  const maxD2 = Number.isFinite(maxDistance) ? maxDistance * maxDistance : Infinity
  const kk = usePlane ? k : 1
  const nbI = new Int32Array(kk), nbD = new Float64Array(kk)
  const eig = new Float64Array(12)
  const tick = Math.max(1, Math.floor(n / 100))
  let planeFallback = 0

  for (let i = 0; i < n; i++) {
    const x = sp[i * 3], y = sp[i * 3 + 1], z = sp[i * 3 + 2]
    const found = knnQuery(index, x, y, z, kk, nbI, nbD, -1, maxD2)
    if (found) {
      const j = nbI[0] * 3
      // Nearest-point distance (also the plane path's fallback).
      let d = Math.sqrt(nbD[0])
      let sx = x - rp[j], sy = y - rp[j + 1], sz = z - rp[j + 2] // nearest → source
      let nx = 0, ny = 0, nz = 0, haveN = false
      if (useSign) { nx = refNrm[j]; ny = refNrm[j + 1]; nz = refNrm[j + 2]; haveN = true }
      if (usePlane) {
        if (found >= 3) {
          // Centroid and covariance relative to the query point (two passes).
          let cx = 0, cy = 0, cz = 0
          for (let a = 0; a < found; a++) {
            const q = nbI[a] * 3
            cx += rp[q] - x; cy += rp[q + 1] - y; cz += rp[q + 2] - z
          }
          cx /= found; cy /= found; cz /= found
          let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0
          for (let a = 0; a < found; a++) {
            const q = nbI[a] * 3
            const dx = rp[q] - x - cx, dy = rp[q + 1] - y - cy, dz = rp[q + 2] - z - cz
            xx += dx * dx; xy += dx * dy; xz += dx * dz; yy += dy * dy; yz += dy * dz; zz += dz * dz
          }
          const tr = xx + yy + zz
          if (tr > 0) {
            const s = 1 / tr
            eigenSym3(xx * s, xy * s, xz * s, yy * s, yz * s, zz * s, eig)
            if (eig[1] > LINEAR_REL * eig[2]) {
              let ux = eig[3], uy = eig[4], uz = eig[5]
              if (useSign) {
                // Orient the plane normal by the neighbours' summed normals.
                let ax = 0, ay = 0, az = 0
                for (let a = 0; a < found; a++) {
                  const q = nbI[a] * 3
                  ax += refNrm[q]; ay += refNrm[q + 1]; az += refNrm[q + 2]
                }
                if (ux * ax + uy * ay + uz * az < 0) { ux = -ux; uy = -uy; uz = -uz }
                nx = ux; ny = uy; nz = uz
              }
              // Source relative to the centroid is −c (c is relative to the source).
              sx = -cx; sy = -cy; sz = -cz
              d = Math.abs(sx * ux + sy * uy + sz * uz)
            } else planeFallback++
          } else planeFallback++
        } else planeFallback++
      }
      if (haveN && sx * nx + sy * ny + sz * nz < 0) d = -d
      distance[i] = d
    }
    if (onProgress && i % tick === 0) onProgress(i / n)
  }
  const stats = distanceStats(distance)
  onProgress?.(1)
  log(`C2C: ${stats.validCount.toLocaleString()} of ${n.toLocaleString()} within range · ${fmtStats(stats)}` +
    (planeFallback ? ` · ${planeFallback.toLocaleString()} fell back to the nearest point (too few / collinear neighbours)` : '') +
    ` in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  return { distance, stats, signed: useSign }
}

// ── Cloud to mesh ────────────────────────────────────────────────────────────

// Closest point on triangle (a, b, c) to the ORIGIN — callers pass vertices relative
// to the query point. Ericson §5.1.5; returns the squared distance and leaves the
// closest point (relative to the query) in CP.
const CP = new Float64Array(3)
const at = (x, y, z) => { CP[0] = x; CP[1] = y; CP[2] = z; return x * x + y * y + z * z }
function triDist2(ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az
  const acx = cx - ax, acy = cy - ay, acz = cz - az
  // ap = p − a = −a
  const d1 = -(abx * ax + aby * ay + abz * az), d2 = -(acx * ax + acy * ay + acz * az)
  if (d1 <= 0 && d2 <= 0) return at(ax, ay, az)
  const d3 = -(abx * bx + aby * by + abz * bz), d4 = -(acx * bx + acy * by + acz * bz)
  if (d3 >= 0 && d4 <= d3) return at(bx, by, bz)
  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3)
    return at(ax + v * abx, ay + v * aby, az + v * abz)
  }
  const d5 = -(abx * cx + aby * cy + abz * cz), d6 = -(acx * cx + acy * cy + acz * cz)
  if (d6 >= 0 && d5 <= d6) return at(cx, cy, cz)
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6)
    return at(ax + w * acx, ay + w * acy, az + w * acz)
  }
  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6))
    return at(bx + w * (cx - bx), by + w * (cy - by), bz + w * (cz - bz))
  }
  const sum = va + vb + vc
  if (!(sum > 0)) {
    // Degenerate (zero-area) triangle: nearest of its three edges.
    const e = [[ax, ay, az, bx, by, bz], [bx, by, bz, cx, cy, cz], [ax, ay, az, cx, cy, cz]]
    let best = Infinity, px = 0, py = 0, pz = 0
    for (const s of e) {
      const d = seg2(...s)
      if (d < best) { best = d; px = CP[0]; py = CP[1]; pz = CP[2] }
    }
    CP[0] = px; CP[1] = py; CP[2] = pz
    return best
  }
  const v = vb / sum, w = vc / sum
  return at(ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w)
}

// Squared distance from the origin to segment (a, b); the closest point goes to CP.
function seg2(ax, ay, az, bx, by, bz) {
  const ux = bx - ax, uy = by - ay, uz = bz - az
  const l2 = ux * ux + uy * uy + uz * uz
  let t = l2 > 0 ? -(ax * ux + ay * uy + az * uz) / l2 : 0
  t = t < 0 ? 0 : (t > 1 ? 1 : t)
  return at(ax + t * ux, ay + t * uy, az + t * uz)
}

/**
 * The exact closest-point search over a triangle mesh (the scheme in the file header),
 * built once and queried point by point: C2M distances, and ICP's correspondences on a
 * mesh reference (core/products/cloudAlign.js).
 * @param {{ nVerts?:number, count?:number, pos, idx:Uint32Array }} mesh
 * @returns {{ nValid, nT, tiers, maxRadius, medianRadius, stats: { candidates, exact },
 *   closest(x, y, z, limit = Infinity, hint = -1, out?: Float64Array(3)) → triangle | -1,
 *   faceNormal(f, out: Float64Array(3)) }} — `closest` writes the closest point to
 *   `out` and its distance to `.distance`; `hint` is a triangle to test first (the
 *   previous query's, for spatially coherent queries: a tight bound, still exact).
 *   faceNormal is the unit normal of the stored winding.
 */
export function buildMeshClosest(mesh) {
  const mp = mesh?.pos, idx = mesh?.idx
  const nV = mp ? (mesh.nVerts ?? Math.floor(mp.length / 3)) : 0
  const nT = idx ? Math.min(mesh.count ?? Infinity, Math.floor(idx.length / 3)) : 0

  // Per-triangle centroid + bounding radius about it; invalid triangles are skipped.
  const cen = new Float64Array(nT * 3), rad = new Float64Array(nT)
  const ok = new Uint8Array(nT)
  let nValid = 0
  for (let f = 0; f < nT; f++) {
    const a = idx[f * 3], b = idx[f * 3 + 1], c = idx[f * 3 + 2]
    if (a >= nV || b >= nV || c >= nV) continue
    const ax = mp[a * 3], ay = mp[a * 3 + 1], az = mp[a * 3 + 2]
    const bx = mp[b * 3], by = mp[b * 3 + 1], bz = mp[b * 3 + 2]
    const cx = mp[c * 3], cy = mp[c * 3 + 1], cz = mp[c * 3 + 2]
    // Centroid in double; the radius from vertex offsets to it (small numbers).
    const gx = (ax + bx + cx) / 3, gy = (ay + by + cy) / 3, gz = (az + bz + cz) / 3
    const r = Math.sqrt(Math.max(
      (ax - gx) ** 2 + (ay - gy) ** 2 + (az - gz) ** 2,
      (bx - gx) ** 2 + (by - gy) ** 2 + (bz - gz) ** 2,
      (cx - gx) ** 2 + (cy - gy) ** 2 + (cz - gz) ** 2))
    if (!Number.isFinite(r) || !Number.isFinite(gx + gy + gz)) continue
    cen[f * 3] = gx; cen[f * 3 + 1] = gy; cen[f * 3 + 2] = gz
    // Pad by a relative ulp so rounding in the centroid can never break the bound.
    rad[f] = r * (1 + 1e-12) + 1e-12 * (Math.abs(gx) + Math.abs(gy) + Math.abs(gz))
    ok[f] = 1; nValid++
  }
  const stats = { candidates: 0, exact: 0 }
  const self = { nValid, nT, tiers: [], maxRadius: 0, medianRadius: 0, stats, distance: Infinity }
  if (!nValid) {
    self.closest = () => -1
    return self
  }

  // Radius tiers: tier 0 holds r ≤ 2·median, tier t holds (base·2^(t−1), base·2^t].
  const radSorted = new Float64Array(nValid)
  for (let f = 0, j = 0; f < nT; f++) if (ok[f]) radSorted[j++] = rad[f]
  radSorted.sort()
  self.maxRadius = radSorted[nValid - 1]
  self.medianRadius = radSorted[nValid >> 1]
  const base = Math.max(2 * radSorted[nValid >> 1], radSorted[nValid - 1] * 1e-9, 1e-300)
  const tierOf = (r) => (r <= base ? 0 : Math.min(60, Math.ceil(Math.log2(r / base))))
  const tierCount = new Map()
  for (let f = 0; f < nT; f++) if (ok[f]) { const t = tierOf(rad[f]); tierCount.set(t, (tierCount.get(t) ?? 0) + 1) }
  const tiers = [...tierCount.keys()].sort((a, b) => a - b).map((t) => ({
    t, tri: new Int32Array(tierCount.get(t)), pos: new Float64Array(tierCount.get(t) * 3), rmax: 0, fill: 0,
  }))
  const byT = new Map(tiers.map((tr) => [tr.t, tr]))
  for (let f = 0; f < nT; f++) {
    if (!ok[f]) continue
    const tr = byT.get(tierOf(rad[f]))
    const j = tr.fill++
    tr.tri[j] = f
    tr.pos[j * 3] = cen[f * 3]; tr.pos[j * 3 + 1] = cen[f * 3 + 1]; tr.pos[j * 3 + 2] = cen[f * 3 + 2]
    if (rad[f] > tr.rmax) tr.rmax = rad[f]
  }
  for (const tr of tiers) tr.index = buildKnnIndex({ count: tr.fill, pos: tr.pos })
  self.tiers = tiers

  const dist2 = (f, x, y, z) => {
    const a = idx[f * 3] * 3, b = idx[f * 3 + 1] * 3, c = idx[f * 3 + 2] * 3
    return triDist2(
      mp[a] - x, mp[a + 1] - y, mp[a + 2] - z,
      mp[b] - x, mp[b + 1] - y, mp[b + 2] - z,
      mp[c] - x, mp[c + 1] - y, mp[c + 2] - z)
  }

  let cap = 16
  let qI = new Int32Array(cap), qD = new Float64Array(cap)
  self.closest = (x, y, z, limit = Infinity, hint = -1, out = null) => {
    let best = limit, bestTri = -1, px = 0, py = 0, pz = 0
    if (hint >= 0 && hint < nT && ok[hint]) {
      const d = Math.sqrt(dist2(hint, x, y, z)); stats.exact++
      if (d < best) { best = d; bestTri = hint; px = CP[0]; py = CP[1]; pz = CP[2] }
    }
    for (const tr of tiers) {
      let K = 8
      for (;;) {
        const bound = best + tr.rmax
        const found = knnQuery(tr.index, x, y, z, K, qI, qD, -1, bound === Infinity ? Infinity : bound * bound)
        stats.candidates += found
        for (let j = 0; j < found; j++) {
          const f = tr.tri[qI[j]]
          if (f === bestTri) continue
          if (Math.sqrt(qD[j]) - rad[f] >= best) continue
          const d = Math.sqrt(dist2(f, x, y, z)); stats.exact++
          if (d < best) { best = d; bestTri = f; px = CP[0]; py = CP[1]; pz = CP[2] }
        }
        if (found < K) break
        // Buffer full: done once the K-th centroid is beyond what could still win.
        if (Math.sqrt(qD[K - 1]) >= best + tr.rmax) break
        K *= 2
        if (K > cap) { cap = K; qI = new Int32Array(cap); qD = new Float64Array(cap) }
      }
    }
    self.distance = best
    if (out && bestTri >= 0) { out[0] = x + px; out[1] = y + py; out[2] = z + pz }
    return bestTri
  }
  self.faceNormal = (f, out) => {
    const a = idx[f * 3] * 3, b = idx[f * 3 + 1] * 3, c = idx[f * 3 + 2] * 3
    const ux = mp[b] - mp[a], uy = mp[b + 1] - mp[a + 1], uz = mp[b + 2] - mp[a + 2]
    const vx = mp[c] - mp[a], vy = mp[c + 1] - mp[a + 1], vz = mp[c + 2] - mp[a + 2]
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz)
    if (l > 0) { out[0] = nx / l; out[1] = ny / l; out[2] = nz / l } else out.fill(0)
    return out
  }
  return self
}

/**
 * Exact distance from every source point to a triangle mesh.
 * @param {{count?, pos}} source
 * @param {{ nVerts?:number, count?:number, pos, idx:Uint32Array }} mesh
 * @param {object} [opts]
 * @param {number} [opts.maxDistance=Infinity] no triangle strictly within this ⇒ NaN
 * @param {boolean} [opts.signed=true] sign from the closest triangle's face normal
 *   (stored winding) — see the file header
 * @param {(msg:string, level?:string, source?:string)=>void} [onLog]
 * @param {(fraction:number)=>void} [onProgress]
 * @returns {{ distance: Float32Array, stats: object, signed: boolean }}
 */
export function cloudToMeshDistance(source, mesh, opts = {}, onLog, onProgress) {
  const log = (msg, level = 'info') => onLog?.(msg, level, 'Products')
  const { maxDistance = Infinity, signed = true } = opts
  const n = countOf(source)
  const distance = new Float32Array(n).fill(NaN)
  const t0 = Date.now()
  const search = buildMeshClosest(mesh)
  const { nValid, nT } = search
  if (!n || !nValid) {
    if (n && !nValid) log('C2M: the mesh has no valid triangles', 'warn')
    onProgress?.(1)
    return { distance, stats: distanceStats(distance), signed: !!signed }
  }

  log(`C2M: ${n.toLocaleString()} source pts vs ${nValid.toLocaleString()} triangles` +
    (nValid < nT ? ` (${(nT - nValid).toLocaleString()} invalid skipped)` : '') +
    ` · ${search.tiers.length} radius tier${search.tiers.length === 1 ? '' : 's'} (max radius ${search.maxRadius.toPrecision(3)}, ` +
    `median ${search.medianRadius.toPrecision(3)}) · ${signed ? 'signed by face normal' : 'unsigned'}` +
    (Number.isFinite(maxDistance) ? ` · maxDistance ${maxDistance}` : ''))

  const sp = source.pos
  const limit = Number.isFinite(maxDistance) ? maxDistance : Infinity
  const tick = Math.max(1, Math.floor(n / 100))
  const nrm = new Float64Array(3), cp = new Float64Array(3)
  let prev = -1

  for (let i = 0; i < n; i++) {
    const x = sp[i * 3], y = sp[i * 3 + 1], z = sp[i * 3 + 2]
    if (!Number.isFinite(x + y + z)) continue
    // Warm start from the previous point's triangle (sources are usually coherent).
    const bestTri = search.closest(x, y, z, limit, prev, cp)
    if (bestTri < 0) continue
    prev = bestTri
    let d = search.distance
    if (signed) {
      search.faceNormal(bestTri, nrm)
      if ((x - cp[0]) * nrm[0] + (y - cp[1]) * nrm[1] + (z - cp[2]) * nrm[2] < 0) d = -d
    }
    distance[i] = d
    if (onProgress && i % tick === 0) onProgress(i / n)
  }
  const stats = distanceStats(distance)
  onProgress?.(1)
  log(`C2M: ${stats.validCount.toLocaleString()} of ${n.toLocaleString()} within range · ${fmtStats(stats)} · ` +
    `${(search.stats.candidates / n).toFixed(1)} candidates / ${(search.stats.exact / n).toFixed(1)} exact tests per point ` +
    `in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  return { distance, stats, signed: !!signed }
}
