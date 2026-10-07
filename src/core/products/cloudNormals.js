// Per-point normal estimation for a flat point cloud (Tools ▸ Point Cloud ▸
// Estimate normals). Pure, no Vue/Pinia/OPFS/DOM — plain data in, plain data out,
// side effects via the injected `onLog` / `onProgress`.
//
// Why it exists: the screened-Poisson mesher needs an oriented normal per sample
// (`DenseCloud.nrm`). A computed dense cloud carries the PatchMatch plane normals,
// but an imported PLY/LAS/XYZ usually arrives with none.
//
// Method: classic PCA. For each point, the k nearest neighbours (core/products/
// knn.js — the one neighbour index) plus the point itself give a 3×3 covariance;
// the normal is the eigenvector of its smallest eigenvalue. PCA gives an axis, not a
// direction, so each normal is then flipped to agree with a reference direction:
//   - 'up'          — a fixed vector (aerial default: terrain faces the sky);
//   - 'viewpoints'  — towards the NEAREST camera centre (a surface was seen from the
//                     side it faces, so this is right for objects and façades);
//   - 'existing'    — the sign of the cloud's current `nrm` (re-estimation keeps the
//                     orientation the cloud already had), else 'up'.
// Orientation is per point and deterministic. There is deliberately no
// minimum-spanning-tree sign propagation: it is order-dependent and one wrong
// edge flips a whole region, while every reference above is a fact about the scene.
//
// Degenerate neighbourhoods are handled explicitly rather than trusted to the
// eigen solver: too few neighbours or a zero-spread neighbourhood (duplicates) take
// the reference direction itself (counted as `fallback`); a collinear neighbourhood
// — where every direction perpendicular to the line is equally "smallest" — takes
// the perpendicular closest to the reference, instead of whichever one Jacobi lands on.
//
// Precision: positions may be survey coordinates (~1e6). The covariance is
// accumulated relative to the neighbourhood centroid in double precision (two
// passes), so a Float32 or Float64 buffer at any offset gives the same normal.
//
// Dense-scale invariant: typed arrays only, no per-point objects; the input is
// never mutated.

import { buildKnnIndex, knnQuery } from './knn.js'

// ── Symmetric 3×3 eigen solver ───────────────────────────────────────────────

const JACOBI_MAX_SWEEPS = 32
// Off-diagonal mass at which the matrix counts as diagonal, relative to the
// diagonal's — well below anything f64 accumulation of a covariance can resolve.
const JACOBI_REL_TOL = 1e-30

const jA = new Float64Array(9)
const jLam = new Float64Array(3)
const jCols = new Float64Array(9)

/**
 * Eigen-decomposition of the symmetric 3×3 matrix
 *   [a00 a01 a02; a01 a11 a12; a02 a12 a22]
 * by cyclic Jacobi rotations — unconditionally convergent and robust on repeated
 * or zero eigenvalues (flat/linear/duplicate neighbourhoods), where the closed-form
 * trigonometric solution loses its eigenvectors to cancellation.
 *
 * Writes into `out` (Float64Array(12)): out[0..2] the eigenvalues in ascending
 * order, out[3..5] / out[6..8] / out[9..11] the matching unit eigenvectors.
 * @returns {Float64Array} `out`
 */
export function eigenSym3(a00, a01, a02, a11, a12, a22, out = new Float64Array(12)) {
  const A = jA
  A[0] = a00; A[1] = a01; A[2] = a02
  A[3] = a01; A[4] = a11; A[5] = a12
  A[6] = a02; A[7] = a12; A[8] = a22
  // V accumulates the rotations; its columns are the eigenvectors.
  let v00 = 1, v01 = 0, v02 = 0, v10 = 0, v11 = 1, v12 = 0, v20 = 0, v21 = 0, v22 = 1
  for (let sweep = 0; sweep < JACOBI_MAX_SWEEPS; sweep++) {
    const off = A[1] * A[1] + A[2] * A[2] + A[5] * A[5]
    const diag = A[0] * A[0] + A[4] * A[4] + A[8] * A[8]
    if (off === 0 || off <= JACOBI_REL_TOL * diag) break
    for (let pq = 0; pq < 3; pq++) {
      // (p, q) ∈ (0,1), (0,2), (1,2); r is the remaining index.
      const p = pq === 2 ? 1 : 0
      const q = pq === 0 ? 1 : 2
      const r = 3 - p - q
      const apq = A[p * 3 + q]
      if (apq === 0) continue
      const app = A[p * 3 + p], aqq = A[q * 3 + q]
      const theta = (aqq - app) / (2 * apq)
      // t = tan of the rotation angle, the smaller root (Numerical Recipes §11.1);
      // the |θ| guard avoids θ² overflowing for a nearly-diagonal pair.
      const t = Math.abs(theta) > 1e150
        ? 1 / (2 * theta)
        : (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
      const c = 1 / Math.sqrt(t * t + 1)
      const s = t * c
      A[p * 3 + p] = app - t * apq
      A[q * 3 + q] = aqq + t * apq
      A[p * 3 + q] = 0; A[q * 3 + p] = 0
      const arp = A[r * 3 + p], arq = A[r * 3 + q]
      const nrp = c * arp - s * arq, nrq = s * arp + c * arq
      A[r * 3 + p] = nrp; A[p * 3 + r] = nrp
      A[r * 3 + q] = nrq; A[q * 3 + r] = nrq
      // Rotate columns p, q of V.
      if (p === 0 && q === 1) {
        let x = v00, y = v01; v00 = c * x - s * y; v01 = s * x + c * y
        x = v10; y = v11; v10 = c * x - s * y; v11 = s * x + c * y
        x = v20; y = v21; v20 = c * x - s * y; v21 = s * x + c * y
      } else if (p === 0) {
        let x = v00, y = v02; v00 = c * x - s * y; v02 = s * x + c * y
        x = v10; y = v12; v10 = c * x - s * y; v12 = s * x + c * y
        x = v20; y = v22; v20 = c * x - s * y; v22 = s * x + c * y
      } else {
        let x = v01, y = v02; v01 = c * x - s * y; v02 = s * x + c * y
        x = v11; y = v12; v11 = c * x - s * y; v12 = s * x + c * y
        x = v21; y = v22; v21 = c * x - s * y; v22 = s * x + c * y
      }
    }
  }
  // Sort the three (value, column) pairs ascending — a 3-element network over
  // module scratch (this runs once per point; no per-call allocation).
  const lam = jLam, cols = jCols
  lam[0] = A[0]; lam[1] = A[4]; lam[2] = A[8]
  cols[0] = v00; cols[1] = v10; cols[2] = v20
  cols[3] = v01; cols[4] = v11; cols[5] = v21
  cols[6] = v02; cols[7] = v12; cols[8] = v22
  let i0 = 0, i1 = 1, i2 = 2
  if (lam[i0] > lam[i1]) { const t = i0; i0 = i1; i1 = t }
  if (lam[i1] > lam[i2]) { const t = i1; i1 = i2; i2 = t }
  if (lam[i0] > lam[i1]) { const t = i0; i0 = i1; i1 = t }
  for (let k = 0; k < 3; k++) {
    const ci = k === 0 ? i0 : (k === 1 ? i1 : i2)
    out[k] = lam[ci]
    const x = cols[ci * 3], y = cols[ci * 3 + 1], z = cols[ci * 3 + 2]
    // V is orthogonal up to rounding; renormalise so callers get exact unit vectors.
    const len = Math.sqrt(x * x + y * y + z * z) || 1
    out[3 + k * 3] = x / len; out[4 + k * 3] = y / len; out[5 + k * 3] = z / len
  }
  return out
}

// ── Normal estimation ────────────────────────────────────────────────────────

/** Point count of a flat cloud (tolerates a missing `count`). */
function countOf(cloud) {
  if (!cloud?.pos) return 0
  return cloud.count ?? Math.floor(cloud.pos.length / 3)
}

// A neighbourhood whose middle eigenvalue is this small relative to the largest is
// treated as a line: the "smallest" eigenvector is then any perpendicular, so the
// normal is chosen from the reference instead.
const LINEAR_REL = 1e-10

/** Unit copy of a 3-vector, or null when it is zero / non-finite. */
function unit3(v) {
  if (!v || v.length < 3) return null
  const x = +v[0], y = +v[1], z = +v[2]
  const len = Math.sqrt(x * x + y * y + z * z)
  if (!(len > 0) || !Number.isFinite(len)) return null
  return [x / len, y / len, z / len]
}

/**
 * Estimate a unit normal per point of a flat cloud by neighbourhood PCA.
 *
 * @param {{ count?:number, pos:Float32Array|Float64Array, nrm?:Float32Array }} cloud
 * @param {object} [opts]
 * @param {number} [opts.k=16] neighbours per point (the point itself is added on top)
 * @param {number} [opts.radius=0] 0 ⇒ plain k-NN; > 0 ⇒ k-NN limited to this radius
 * @param {{kind:'up', up?:number[]}|{kind:'viewpoints', points:Float64Array|number[]}|{kind:'existing'}} [opts.orient]
 *   sign reference — see the file header. Default `{ kind:'up', up:[0,0,1] }`.
 * @param {number} [opts.minNeighbors=3] fewer neighbours than this ⇒ the point takes
 *   the reference direction (counted in `stats.fallback`)
 * @param {(msg:string, level?:string, source?:string)=>void} [onLog]
 * @param {(fraction:number)=>void} [onProgress] monotonic 0..1
 * @returns {{ nrm: Float32Array, stats: { estimated:number, fallback:number,
 *   flipped:number, planarity:number|null } }} — `planarity` is the median surface
 *   variation λ0/(λ0+λ1+λ2) over estimated points (0 = perfectly planar, 1/3 =
 *   isotropic), null when nothing was estimated.
 */
export function estimateNormals(cloud, opts = {}, onLog, onProgress) {
  const log = (msg, level = 'info') => onLog?.(msg, level, 'Products')
  const n = countOf(cloud)
  const k = Math.max(1, Math.floor(Number(opts.k ?? 16)) || 16)
  const radius = Number(opts.radius) > 0 ? Number(opts.radius) : 0
  const maxD2 = radius > 0 ? radius * radius : Infinity
  const minNeighbors = Math.min(k, Math.max(1, Math.floor(Number(opts.minNeighbors ?? 3)) || 1))

  // Resolve the orientation reference.
  let orientKind = opts.orient?.kind ?? 'up'
  const up = unit3(opts.orient?.up) ?? [0, 0, 1]
  if (orientKind === 'up' && opts.orient?.up && !unit3(opts.orient.up)) {
    log('Normals: invalid up vector; using (0, 0, 1)', 'warn')
  }
  const existing = cloud?.nrm && cloud.nrm.length >= n * 3 ? cloud.nrm : null
  if (orientKind === 'existing' && !existing) {
    log('Normals: cloud has no normals to keep the orientation of; orienting up instead', 'warn')
    orientKind = 'up'
  }
  let camIndex = null
  if (orientKind === 'viewpoints') {
    const cams = opts.orient?.points
    const m = cams ? Math.floor(cams.length / 3) : 0
    if (!m) {
      log('Normals: no viewpoints given; orienting up instead', 'warn')
      orientKind = 'up'
    } else {
      camIndex = buildKnnIndex({ count: m, pos: Float64Array.from(cams.slice(0, m * 3)) })
    }
  }
  if (orientKind !== 'up' && orientKind !== 'viewpoints' && orientKind !== 'existing') {
    log(`Normals: unknown orientation '${orientKind}'; orienting up instead`, 'warn')
    orientKind = 'up'
  }

  const nrm = new Float32Array(n * 3)
  const stats = { estimated: 0, fallback: 0, flipped: 0, planarity: null }
  if (!n) {
    onProgress?.(1)
    return { nrm, stats }
  }

  log(`Normals: ${n.toLocaleString()} points · k=${k}` +
    (radius > 0 ? ` within r=${radius}` : '') +
    ` · min neighbours ${minNeighbors} · orient ${orientKind}` +
    (orientKind === 'up' ? ` (${up.map((v) => +v.toFixed(3)).join(', ')})` : '') +
    (orientKind === 'viewpoints' ? ` (${camIndex.count} camera centres)` : ''))

  const t0 = Date.now()
  const index = buildKnnIndex(cloud)
  const { pos } = cloud
  const nbIdx = new Int32Array(k), nbD2 = new Float64Array(k)
  const camIdx = new Int32Array(1), camD2 = new Float64Array(1)
  const eig = new Float64Array(12)
  const variation = new Float32Array(n)
  const tick = Math.max(1, Math.floor(n / 100))

  for (let i = 0; i < n; i++) {
    const px = pos[i * 3], py = pos[i * 3 + 1], pz = pos[i * 3 + 2]

    // Reference direction for this point.
    let rx = up[0], ry = up[1], rz = up[2]
    if (orientKind === 'viewpoints') {
      knnQuery(camIndex, px, py, pz, 1, camIdx, camD2)
      const c = camIdx[0] * 3
      const dx = camIndex.pos[c] - px, dy = camIndex.pos[c + 1] - py, dz = camIndex.pos[c + 2] - pz
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
      // A point exactly at a camera centre has no direction to it; keep 'up'.
      if (len > 0) { rx = dx / len; ry = dy / len; rz = dz / len }
    } else if (orientKind === 'existing') {
      const ex = existing[i * 3], ey = existing[i * 3 + 1], ez = existing[i * 3 + 2]
      const len = Math.sqrt(ex * ex + ey * ey + ez * ez)
      if (len > 0 && Number.isFinite(len)) { rx = ex / len; ry = ey / len; rz = ez / len }
    }

    const found = knnQuery(index, px, py, pz, k, nbIdx, nbD2, i, maxD2)
    let nx = rx, ny = ry, nz = rz
    let ok = false
    if (found >= minNeighbors) {
      // Pass 1: centroid of point + neighbours, as an offset from the point itself
      // (small numbers even at survey coordinates).
      let sx = 0, sy = 0, sz = 0
      for (let j = 0; j < found; j++) {
        const q = nbIdx[j] * 3
        sx += pos[q] - px; sy += pos[q + 1] - py; sz += pos[q + 2] - pz
      }
      const m = found + 1
      const cx = sx / m, cy = sy / m, cz = sz / m
      // Pass 2: covariance about that centroid (the point itself contributes −c).
      let xx = cx * cx, xy = cx * cy, xz = cx * cz, yy = cy * cy, yz = cy * cz, zz = cz * cz
      for (let j = 0; j < found; j++) {
        const q = nbIdx[j] * 3
        const dx = pos[q] - px - cx, dy = pos[q + 1] - py - cy, dz = pos[q + 2] - pz - cz
        xx += dx * dx; xy += dx * dy; xz += dx * dz
        yy += dy * dy; yz += dy * dz; zz += dz * dz
      }
      const tr = xx + yy + zz
      if (tr > 0 && Number.isFinite(tr)) {
        // Normalise by the trace so the solver's thresholds and the eigenvalue
        // ratios are scale-free; the eigenvalues then sum to 1.
        const s = 1 / tr
        eigenSym3(xx * s, xy * s, xz * s, yy * s, yz * s, zz * s, eig)
        const l0 = Math.max(0, eig[0]), l1 = Math.max(0, eig[1]), l2 = Math.max(0, eig[2])
        let ux = eig[3], uy = eig[4], uz = eig[5]
        if (l1 <= LINEAR_REL * l2) {
          // Collinear: take the perpendicular to the line closest to the reference.
          const ax = eig[9], ay = eig[10], az = eig[11]
          const d = rx * ax + ry * ay + rz * az
          const px2 = rx - d * ax, py2 = ry - d * ay, pz2 = rz - d * az
          const len = Math.sqrt(px2 * px2 + py2 * py2 + pz2 * pz2)
          if (len > 1e-6) { ux = px2 / len; uy = py2 / len; uz = pz2 / len }
        }
        const sum = l0 + l1 + l2
        variation[stats.estimated] = sum > 0 ? l0 / sum : 0
        // Orient: flip into the reference's half-space.
        if (ux * rx + uy * ry + uz * rz < 0) { ux = -ux; uy = -uy; uz = -uz; stats.flipped++ }
        nx = ux; ny = uy; nz = uz
        ok = true
      }
    }
    if (ok) stats.estimated++
    else stats.fallback++
    nrm[i * 3] = nx; nrm[i * 3 + 1] = ny; nrm[i * 3 + 2] = nz
    if (onProgress && i % tick === 0) onProgress(i / n)
  }

  if (stats.estimated) {
    const v = variation.subarray(0, stats.estimated).sort()
    const h = stats.estimated >> 1
    stats.planarity = stats.estimated % 2 ? v[h] : 0.5 * (v[h - 1] + v[h])
  }
  onProgress?.(1)
  log(`Normals: ${stats.estimated.toLocaleString()} estimated, ` +
    `${stats.fallback.toLocaleString()} fell back to the reference direction ` +
    `(< ${minNeighbors} neighbours or zero spread), ${stats.flipped.toLocaleString()} flipped; ` +
    `median surface variation ${stats.planarity == null ? '—' : stats.planarity.toExponential(2)} ` +
    `in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  if (stats.fallback > 0.05 * n) {
    log(`Normals: ${(100 * stats.fallback / n).toFixed(1)}% of points had too few neighbours` +
      (radius > 0 ? ' — the radius may be too small for this cloud\'s spacing' : ''), 'warn')
  }
  return { nrm, stats }
}
