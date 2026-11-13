// ICP (`icpAlign`) and the alignment report, in the transform representation of
// core/products/rigidTransform.js. Pure, no Vue/Pinia/OPFS/DOM — plain data in, plain
// data out, side effects via the injected `onLog` / `onProgress`.
//
// A seeded random subsample of the source, exact 1-NN correspondences against the
// reference (core/products/knn.js — the one neighbour index), rejection beyond
// `maxDistance`, then a trimmed set (best `trim` fraction by distance). Point-to-plane
// solves the linearised small-angle 6-DoF (7 with scale) least squares about the
// correspondence centroid; point-to-point solves Horn's closed form each iteration.
// Point-to-plane needs reference normals; their estimation is NOT done here
// (core/products/cloudNormals.js) — without them it falls back to point-to-point and
// says so. A mesh reference is matched on its SURFACE: each sample's correspondence is
// the exact closest point on the mesh (core/products/cloudDistance.js ▸
// buildMeshClosest, the C2M search) with that triangle's face normal, so a coarse mesh
// aligns to the noise level, not to its vertex spacing.
//
// Dense-scale invariant: typed arrays only for per-point data; inputs are never
// mutated. Every solve runs in a local frame about the reference centroid (see
// rigidTransform.js ▸ Precision).

import { buildKnnIndex, knnQuery } from './knn.js'
import { eigenSym3 } from './cloudNormals.js'
import { buildMeshClosest } from './cloudDistance.js'
import {
  applyTransform,
  mat3Mul,
  mat3Vec,
  orthonormalize,
  rodrigues,
  rotationAngle,
  similarityOf,
  solveSmall,
  vertexCount,
} from './rigidTransform.js'

// ── Horn on typed arrays (ICP point-to-point) ────────────────────────────────

// georef.js `fitSimilarity` is the pair fit's solver, but ICP cannot use it: it
// takes an object per pair and runs an O(n²) collinearity test, which at tens of
// thousands of correspondences per iteration is the whole cost. The closed form is
// the same (Horn's quaternion method); this version accumulates the centroids and
// cross-covariance straight from typed arrays.

// Unit eigenvector of the largest eigenvalue of a symmetric 4×4 (cyclic Jacobi).
function topEigen4(N) {
  const A = Float64Array.from(N)
  const V = new Float64Array(16)
  V[0] = V[5] = V[10] = V[15] = 1
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0,
      diag = 0
    for (let i = 0; i < 4; i++) {
      diag += A[i * 5] * A[i * 5]
      for (let j = i + 1; j < 4; j++) off += A[i * 4 + j] * A[i * 4 + j]
    }
    if (off === 0 || off <= 1e-32 * diag) break
    for (let p = 0; p < 3; p++)
      for (let q = p + 1; q < 4; q++) {
        const apq = A[p * 4 + q]
        if (apq === 0) continue
        const theta = (A[q * 5] - A[p * 5]) / (2 * apq)
        const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1),
          s = t * c
        for (let k = 0; k < 4; k++) {
          const akp = A[k * 4 + p],
            akq = A[k * 4 + q]
          A[k * 4 + p] = c * akp - s * akq
          A[k * 4 + q] = s * akp + c * akq
        }
        for (let k = 0; k < 4; k++) {
          const apk = A[p * 4 + k],
            aqk = A[q * 4 + k]
          A[p * 4 + k] = c * apk - s * aqk
          A[q * 4 + k] = s * apk + c * aqk
        }
        for (let k = 0; k < 4; k++) {
          const vkp = V[k * 4 + p],
            vkq = V[k * 4 + q]
          V[k * 4 + p] = c * vkp - s * vkq
          V[k * 4 + q] = s * vkp + c * vkq
        }
      }
  }
  let best = 0
  for (let i = 1; i < 4; i++) if (A[i * 5] > A[best * 5]) best = i
  const v = [V[best], V[4 + best], V[8 + best], V[12 + best]]
  const l = Math.hypot(v[0], v[1], v[2], v[3])
  return l > 0 ? v.map((x) => x / l) : null
}

/**
 * Least-squares b ≈ s·R·a + t over m pairs of Float64Array(3m) (local coordinates).
 * @returns {{scale,R,t}|null}
 */
function hornArrays(a, b, m, withScale) {
  const ca = [0, 0, 0],
    cb = [0, 0, 0]
  for (let k = 0; k < m; k++)
    for (let i = 0; i < 3; i++) {
      ca[i] += a[k * 3 + i]
      cb[i] += b[k * 3 + i]
    }
  for (let i = 0; i < 3; i++) {
    ca[i] /= m
    cb[i] /= m
  }
  let Sxx = 0,
    Sxy = 0,
    Sxz = 0,
    Syx = 0,
    Syy = 0,
    Syz = 0,
    Szx = 0,
    Szy = 0,
    Szz = 0,
    va = 0
  for (let k = 0; k < m; k++) {
    const ax = a[k * 3] - ca[0],
      ay = a[k * 3 + 1] - ca[1],
      az = a[k * 3 + 2] - ca[2]
    const bx = b[k * 3] - cb[0],
      by = b[k * 3 + 1] - cb[1],
      bz = b[k * 3 + 2] - cb[2]
    Sxx += ax * bx
    Sxy += ax * by
    Sxz += ax * bz
    Syx += ay * bx
    Syy += ay * by
    Syz += ay * bz
    Szx += az * bx
    Szy += az * by
    Szz += az * bz
    va += ax * ax + ay * ay + az * az
  }
  if (!(va > 0)) return null
  const q = topEigen4([
    Sxx + Syy + Szz,
    Syz - Szy,
    Szx - Sxz,
    Sxy - Syx,
    Syz - Szy,
    Sxx - Syy - Szz,
    Sxy + Syx,
    Szx + Sxz,
    Szx - Sxz,
    Sxy + Syx,
    -Sxx + Syy - Szz,
    Syz + Szy,
    Sxy - Syx,
    Szx + Sxz,
    Syz + Szy,
    -Sxx - Syy + Szz,
  ])
  if (!q) return null
  const [w, x, y, z] = q
  const R = [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ]
  let s = 1
  if (withScale) {
    // s = Σ b'·(R·a') / Σ|a'|² — the same estimator as fitSimilarity.
    const M = [
      [Sxx, Sxy, Sxz],
      [Syx, Syy, Syz],
      [Szx, Szy, Szz],
    ]
    let num = 0
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) num += R[j][i] * M[i][j]
    s = num / va
    if (!(s > 0)) return null
  }
  const Rca = mat3Vec(R, ca)
  return { scale: s, R, t: [cb[0] - s * Rca[0], cb[1] - s * Rca[1], cb[2] - s * Rca[2]] }
}

// ── ICP ──────────────────────────────────────────────────────────────────────

// mulberry32 — small, fast, deterministic.
function prng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// k distinct indices of [0, n) — Floyd's algorithm (O(k) memory, deterministic for
// a seed), returned sorted so the sample walks the source buffer in order.
function sampleIndices(n, k, seed) {
  if (k >= n) {
    const all = new Int32Array(n)
    for (let i = 0; i < n; i++) all[i] = i
    return all
  }
  const rand = prng(seed)
  const set = new Set()
  for (let j = n - k; j < n; j++) {
    const r = Math.floor(rand() * (j + 1))
    set.add(set.has(r) ? j : r)
  }
  return Int32Array.from(set).sort()
}

// Reference points + optional unit normals in the local frame (centred on `c`).
// A mesh contributes its vertices and area-weighted face normals summed per vertex.
function referenceGeometry(reference) {
  const isMesh = !!reference.idx
  const m = vertexCount(reference)
  const src = reference.pos
  let cx = 0,
    cy = 0,
    cz = 0,
    valid = 0
  for (let i = 0; i < m; i++) {
    const x = src[i * 3],
      y = src[i * 3 + 1],
      z = src[i * 3 + 2]
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
    cx += x
    cy += y
    cz += z
    valid++
  }
  if (!valid) return null
  const c = [cx / valid, cy / valid, cz / valid]
  const pos = new Float64Array(m * 3)
  for (let i = 0; i < m; i++) {
    pos[i * 3] = src[i * 3] - c[0]
    pos[i * 3 + 1] = src[i * 3 + 1] - c[1]
    pos[i * 3 + 2] = src[i * 3 + 2] - c[2]
  }
  if (isMesh) {
    // The closest-point search over the local-frame triangles; normals are per face.
    const surface = buildMeshClosest({ nVerts: m, count: reference.count, pos, idx: reference.idx })
    return surface.nValid ? { c, pos, nrm: null, count: m, isMesh, surface } : null
  }
  const nrm = reference.nrm && reference.nrm.length >= m * 3 ? reference.nrm : null
  let unitN = null
  if (nrm) {
    unitN = new Float64Array(m * 3)
    for (let i = 0; i < m; i++) {
      const x = nrm[i * 3],
        y = nrm[i * 3 + 1],
        z = nrm[i * 3 + 2]
      const l = Math.sqrt(x * x + y * y + z * z)
      if (l > 0 && Number.isFinite(l)) {
        unitN[i * 3] = x / l
        unitN[i * 3 + 1] = y / l
        unitN[i * 3 + 2] = z / l
      }
    }
  }
  return { c, pos, nrm: unitN, count: m, isMesh }
}

/**
 * Iterative closest point: refine the transform that maps `source` onto `reference`.
 *
 * @param {{count?:number, pos}} source cloud (only positions are read)
 * @param {object} reference cloud ({ pos, nrm? }) or mesh ({ nVerts, pos, idx })
 * @param {object} opts
 * @param {number} opts.maxDistance REQUIRED — correspondences farther apart than this
 *   (in cloud units, after the current transform) are rejected
 * @param {number} [opts.maxIterations=30] solve steps
 * @param {number} [opts.sampleCount=50000] seeded random subsample of the source
 * @param {boolean} [opts.pointToPlane=true] needs reference normals (or a mesh)
 * @param {boolean} [opts.estimateScale=false] 7-DoF similarity instead of rigid —
 *   weakly constrained on near-planar scenes in point-to-plane (scale along a plane
 *   is invisible to a plane distance); prefer point-to-point when scale matters
 * @param {number} [opts.trim=0.9] keep the best fraction of in-range pairs by distance
 * @param {number} [opts.tolerance=1e-6] convergence: the RMS displacement of the
 *   sample between iterations AND the change in rms both below tolerance × the
 *   sample's RMS radius
 * @param {object} [opts.initial] starting transform (similarity), default identity
 * @param {number} [opts.seed=1]
 * @param {(msg:string, level?:string, source?:string)=>void} [onLog]
 * @param {(fraction:number)=>void} [onProgress]
 * @returns {{ transform:{scale,R,t}, rms:number, inlierFraction:number, iterations:number,
 *   converged:boolean, history:{rms:number, inliers:number}[], method:string,
 *   sampleCount:number, pivot:number[] }}
 *   transform maps source → reference and INCLUDES `initial`; rms = RMS Euclidean
 *   distance of the trimmed correspondences at the final transform; inliers /
 *   inlierFraction = sample points with a reference point within maxDistance (before
 *   trimming); history[i] is evaluated at the transform after i solve steps; pivot =
 *   the reference centroid (the local-frame origin).
 * @throws when maxDistance is missing, an input is empty, or too few sample points
 *   lie within maxDistance of the reference at the start.
 */
export function icpAlign(source, reference, opts = {}, onLog, onProgress) {
  const log = (msg, level = 'info') => onLog?.(msg, level, 'Products')
  const {
    maxIterations = 30,
    maxDistance,
    sampleCount = 50000,
    pointToPlane = true,
    estimateScale = false,
    tolerance = 1e-6,
    initial = null,
    seed = 1,
    trim = 0.9,
  } = opts
  if (!(maxDistance > 0)) throw new Error('ICP needs a positive maxDistance (the correspondence rejection radius).')
  const nSrc = vertexCount(source)
  if (!nSrc) throw new Error('ICP: the source cloud is empty.')
  const ref = vertexCount(reference) ? referenceGeometry(reference) : null
  if (!ref) throw new Error('ICP: the reference is empty.')
  const trimFrac = Math.min(1, Math.max(0.05, Number(trim) || 0.9))
  const usePlane = !!pointToPlane
  // A reference cloud without normals (an imported survey, a thinned streamed one): each
  // reference point ICP matches gets its normal from its 16 nearest neighbours, once,
  // when first matched. Point-to-point instead needed 100+ iterations on a real dense
  // cloud and still had not converged; this costs a few thousand normals per iteration.
  const lazyNormals = usePlane && !ref.nrm && !ref.isMesh
  if (lazyNormals) log('ICP: the reference has no normals — estimating them at the matched points')
  const method = usePlane ? 'point-to-plane' : 'point-to-point'
  const t0 = Date.now()
  const index = ref.isMesh ? null : buildKnnIndex({ count: ref.count, pos: ref.pos })
  let normalAt = null
  if (lazyNormals) {
    const have = new Uint8Array(ref.count),
      lazy = new Float64Array(ref.count * 3)
    const nb = new Int32Array(16),
      nd = new Float64Array(16),
      eig = new Float64Array(12)
    ref.nrm = lazy
    normalAt = (r) => {
      if (have[r]) return
      have[r] = 1
      const px = ref.pos[r * 3],
        py = ref.pos[r * 3 + 1],
        pz = ref.pos[r * 3 + 2]
      const found = knnQuery(index, px, py, pz, 16, nb, nd, r)
      let sx = 0,
        sy = 0,
        sz = 0
      for (let j = 0; j < found; j++) {
        sx += ref.pos[nb[j] * 3] - px
        sy += ref.pos[nb[j] * 3 + 1] - py
        sz += ref.pos[nb[j] * 3 + 2] - pz
      }
      const m = found + 1,
        cx = sx / m,
        cy = sy / m,
        cz = sz / m
      let xx = cx * cx,
        xy = cx * cy,
        xz = cx * cz,
        yy = cy * cy,
        yz = cy * cz,
        zz = cz * cz
      for (let j = 0; j < found; j++) {
        const dx = ref.pos[nb[j] * 3] - px - cx,
          dy = ref.pos[nb[j] * 3 + 1] - py - cy,
          dz = ref.pos[nb[j] * 3 + 2] - pz - cz
        xx += dx * dx
        xy += dx * dy
        xz += dx * dz
        yy += dy * dy
        yz += dy * dz
        zz += dz * dz
      }
      const tr = xx + yy + zz
      if (found < 3 || !(tr > 0)) return // no plane: the zero normal adds no constraint
      eigenSym3(xx / tr, xy / tr, xz / tr, yy / tr, yz / tr, zz / tr, eig)
      // The sign does not matter: a point-to-plane residual is squared.
      lazy[r * 3] = eig[3]
      lazy[r * 3 + 1] = eig[4]
      lazy[r * 3 + 2] = eig[5]
    }
  }

  // Sample in the local frame; non-finite source points are dropped.
  const pick = sampleIndices(nSrc, Math.max(1, Math.floor(sampleCount)), seed)
  const c = ref.c
  const sp = new Float64Array(pick.length * 3)
  let m = 0
  for (let k = 0; k < pick.length; k++) {
    const i = pick[k] * 3
    const x = source.pos[i] - c[0],
      y = source.pos[i + 1] - c[1],
      z = source.pos[i + 2] - c[2]
    if (!Number.isFinite(x + y + z)) continue
    sp[m * 3] = x
    sp[m * 3 + 1] = y
    sp[m * 3 + 2] = z
    m++
  }
  if (!m) throw new Error('ICP: the source has no finite points.')

  // Current transform in the local frame: q = s·R·p + t (p, q relative to c).
  const init = similarityOf(initial, 'initial transform')
  let s = init.scale,
    R = init.R
  const Rc = mat3Vec(R, c)
  let t = [0, 1, 2].map((i) => s * Rc[i] + init.t[i] - c[i])

  log(
    `ICP: ${nSrc.toLocaleString()} source pts → sample ${m.toLocaleString()} (seed ${seed}) · ` +
      `reference ${ref.isMesh ? `${ref.surface.nValid.toLocaleString()} mesh triangles (closest surface point)` : `${ref.count.toLocaleString()} pts`} · ${method} · ` +
      `maxDistance ${maxDistance} · trim ${Math.round(trimFrac * 100)}% · scale ${estimateScale ? 'estimated' : 'fixed'} · ` +
      `≤ ${maxIterations} iterations, tolerance ${tolerance}`,
  )

  const q = new Float64Array(m * 3),
    prevQ = new Float64Array(m * 3)
  const pairSrc = new Int32Array(m),
    pairD2 = new Float64Array(m)
  // Each sample's current match: the reference point (cloud) or the closest point on
  // the surface (mesh), and its unit normal for point-to-plane.
  const tp = new Float64Array(m * 3),
    tn = usePlane ? new Float64Array(m * 3) : null
  const nnI = new Int32Array(1),
    nnD = new Float64Array(1)
  // Mesh: each sample's last triangle, tested first next time (a tight bound, still exact).
  const hint = ref.isMesh ? new Int32Array(m).fill(-1) : null
  const cp = new Float64Array(3),
    fn = new Float64Array(3)
  const maxD2 = maxDistance * maxDistance
  const minPairs = usePlane ? 6 + (estimateScale ? 1 : 0) : 3
  let radius = 0

  // Transform the sample, find correspondences, trim. Returns the pair count kept.
  const evaluate = () => {
    let found = 0
    const R0 = R[0],
      R1 = R[1],
      R2 = R[2]
    for (let k = 0; k < m; k++) {
      const x = sp[k * 3],
        y = sp[k * 3 + 1],
        z = sp[k * 3 + 2]
      const qx = s * (R0[0] * x + R0[1] * y + R0[2] * z) + t[0]
      const qy = s * (R1[0] * x + R1[1] * y + R1[2] * z) + t[1]
      const qz = s * (R2[0] * x + R2[1] * y + R2[2] * z) + t[2]
      q[k * 3] = qx
      q[k * 3 + 1] = qy
      q[k * 3 + 2] = qz
      if (ref.isMesh) {
        const f = ref.surface.closest(qx, qy, qz, maxDistance, hint[k], cp)
        if (f < 0) continue
        hint[k] = f
        tp[k * 3] = cp[0]
        tp[k * 3 + 1] = cp[1]
        tp[k * 3 + 2] = cp[2]
        if (tn) {
          ref.surface.faceNormal(f, fn)
          tn[k * 3] = fn[0]
          tn[k * 3 + 1] = fn[1]
          tn[k * 3 + 2] = fn[2]
        }
        pairSrc[found] = k
        pairD2[found] = ref.surface.distance ** 2
        found++
      } else if (knnQuery(index, qx, qy, qz, 1, nnI, nnD, -1, maxD2)) {
        if (normalAt) normalAt(nnI[0])
        const r = nnI[0] * 3
        tp[k * 3] = ref.pos[r]
        tp[k * 3 + 1] = ref.pos[r + 1]
        tp[k * 3 + 2] = ref.pos[r + 2]
        if (tn) {
          tn[k * 3] = ref.nrm[r]
          tn[k * 3 + 1] = ref.nrm[r + 1]
          tn[k * 3 + 2] = ref.nrm[r + 2]
        }
        pairSrc[found] = k
        pairD2[found] = nnD[0]
        found++
      }
    }
    let kept = found
    let cut = Infinity
    if (found && trimFrac < 1) {
      const sorted = pairD2.slice(0, found).sort()
      cut = sorted[Math.max(0, Math.ceil(trimFrac * found) - 1)]
      kept = 0
      for (let j = 0; j < found; j++) {
        if (pairD2[j] <= cut) {
          pairSrc[kept] = pairSrc[j]
          pairD2[kept] = pairD2[j]
          kept++
        }
      }
    }
    let sse = 0
    for (let j = 0; j < kept; j++) sse += pairD2[j]
    return { inliers: found, kept, rms: kept ? Math.sqrt(sse / kept) : NaN }
  }

  // Sample radius (convergence scale) at the initial pose.
  {
    let mx = 0,
      my = 0,
      mz = 0
    for (let k = 0; k < m; k++) {
      mx += sp[k * 3]
      my += sp[k * 3 + 1]
      mz += sp[k * 3 + 2]
    }
    mx /= m
    my /= m
    mz /= m
    let r2 = 0
    for (let k = 0; k < m; k++) r2 += (sp[k * 3] - mx) ** 2 + (sp[k * 3 + 1] - my) ** 2 + (sp[k * 3 + 2] - mz) ** 2
    radius = s * Math.sqrt(r2 / m) || 1
  }
  const tol = tolerance * radius

  const history = []
  let iterations = 0,
    converged = false
  let ev = evaluate()
  history.push({ rms: ev.rms, inliers: ev.inliers })
  if (ev.kept < minPairs) {
    throw new Error(
      `ICP: only ${ev.inliers} of ${m} sampled source points lie within maxDistance (${maxDistance}) ` +
        'of the reference — increase maxDistance or start from a closer initial alignment.',
    )
  }
  log(
    `ICP iter 0: rms ${ev.rms.toPrecision(4)}, ${ev.inliers.toLocaleString()} in range (${((100 * ev.inliers) / m).toFixed(1)}%)`,
    'debug',
  )

  const H = new Float64Array(49),
    g = new Float64Array(7),
    row = new Float64Array(7)
  while (iterations < maxIterations) {
    // ── Solve one step from the kept pairs ──
    let next = null
    if (usePlane) {
      const dim = estimateScale ? 7 : 6
      // Linearise about the correspondence centroid (decouples rotation from
      // translation): q' = cq + e^σ·Rδ·(q − cq) + tδ, Rδ ≈ I + [ω]×.
      let cx = 0,
        cy = 0,
        cz = 0
      for (let j = 0; j < ev.kept; j++) {
        const k = pairSrc[j] * 3
        cx += q[k]
        cy += q[k + 1]
        cz += q[k + 2]
      }
      cx /= ev.kept
      cy /= ev.kept
      cz /= ev.kept
      H.fill(0)
      g.fill(0)
      for (let j = 0; j < ev.kept; j++) {
        const k = pairSrc[j] * 3
        const nx = tn[k],
          ny = tn[k + 1],
          nz = tn[k + 2]
        if (nx === 0 && ny === 0 && nz === 0) continue
        const ux = q[k] - cx,
          uy = q[k + 1] - cy,
          uz = q[k + 2] - cz
        // residual(δ) = (q − p)·n + ω·(u × n) + tδ·n + σ·(u·n)
        row[0] = uy * nz - uz * ny
        row[1] = uz * nx - ux * nz
        row[2] = ux * ny - uy * nx
        row[3] = nx
        row[4] = ny
        row[5] = nz
        if (dim === 7) row[6] = ux * nx + uy * ny + uz * nz
        const r0 = (q[k] - tp[k]) * nx + (q[k + 1] - tp[k + 1]) * ny + (q[k + 2] - tp[k + 2]) * nz
        for (let a = 0; a < dim; a++) {
          g[a] += row[a] * r0
          for (let b = a; b < dim; b++) H[a * dim + b] += row[a] * row[b]
        }
      }
      let maxDiag = 0
      for (let a = 0; a < dim; a++) {
        for (let b = 0; b < a; b++) H[a * dim + b] = H[b * dim + a]
        maxDiag = Math.max(maxDiag, H[a * dim + a])
      }
      // Tiny damping: a direction the surface cannot see (sliding along a plane)
      // gets a ~zero step instead of a singular solve.
      for (let a = 0; a < dim; a++) H[a * dim + a] += 1e-12 * maxDiag + 1e-300
      const rhs = new Float64Array(dim)
      for (let a = 0; a < dim; a++) rhs[a] = -g[a]
      const x = solveSmall(H.slice(0, dim * dim), rhs, dim)
      if (x) {
        const Rd = rodrigues(x[0], x[1], x[2])
        const sd = dim === 7 ? Math.exp(x[6]) : 1
        const Rdc = mat3Vec(Rd, [cx, cy, cz])
        const td = [cx - sd * Rdc[0] + x[3], cy - sd * Rdc[1] + x[4], cz - sd * Rdc[2] + x[5]]
        // δ ∘ current: s' = sδ·s, R' = Rδ·R, t' = sδ·Rδ·t + tδ.
        const Rdt = mat3Vec(Rd, t)
        next = { s: sd * s, R: orthonormalize(mat3Mul(Rd, R)), t: [0, 1, 2].map((i) => sd * Rdt[i] + td[i]) }
      }
    } else {
      // Full Horn re-solve from the ORIGINAL sample points to their matches.
      const a = new Float64Array(ev.kept * 3),
        b = new Float64Array(ev.kept * 3)
      for (let j = 0; j < ev.kept; j++) {
        const k = pairSrc[j] * 3
        a[j * 3] = sp[k]
        a[j * 3 + 1] = sp[k + 1]
        a[j * 3 + 2] = sp[k + 2]
        b[j * 3] = tp[k]
        b[j * 3 + 1] = tp[k + 1]
        b[j * 3 + 2] = tp[k + 2]
      }
      const fit = hornArrays(a, b, ev.kept, estimateScale)
      if (fit) next = { s: fit.scale, R: fit.R, t: fit.t }
    }
    if (!next) {
      log(`ICP: the ${method} step was singular at iteration ${iterations + 1}; stopping`, 'warn')
      break
    }
    s = next.s
    R = next.R
    t = next.t
    iterations++
    prevQ.set(q)
    const prevRms = ev.rms
    ev = evaluate()
    history.push({ rms: ev.rms, inliers: ev.inliers })
    let disp = 0
    for (let k = 0; k < m * 3; k++) {
      const d = q[k] - prevQ[k]
      disp += d * d
    }
    disp = Math.sqrt(disp / m)
    log(
      `ICP iter ${iterations}: rms ${ev.rms.toPrecision(4)}, ${ev.inliers.toLocaleString()} in range, ` +
        `moved ${disp.toPrecision(3)}`,
      'debug',
    )
    onProgress?.(iterations / (maxIterations + 1))
    if (ev.kept < minPairs) {
      log(`ICP: only ${ev.kept} correspondences left within maxDistance; stopping`, 'warn')
      break
    }
    if (disp < tol && Math.abs(ev.rms - prevRms) < tol) {
      converged = true
      break
    }
  }

  // Back to world: p' = s·R·(p − c) + t + c  ⇒  t_world = t + c − s·R·c.
  const Rcw = mat3Vec(R, c)
  const transform = { scale: s, R, t: [0, 1, 2].map((i) => t[i] + c[i] - s * Rcw[i]) }
  const result = {
    transform,
    rms: ev.rms,
    inlierFraction: ev.inliers / m,
    iterations,
    converged,
    history,
    method,
    sampleCount: m,
    pivot: c.slice(),
  }
  onProgress?.(1)
  log(
    `ICP: ${converged ? 'converged' : 'stopped'} after ${iterations} iteration${iterations === 1 ? '' : 's'} in ` +
      `${((Date.now() - t0) / 1000).toFixed(1)} s · ${alignmentReport(result).slice(0, 3).join(' · ')}`,
    converged ? 'info' : 'warn',
  )
  return result
}

// ── Report ───────────────────────────────────────────────────────────────────

const fmt = (v) =>
  Number.isFinite(v)
    ? (Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(3) : +v.toPrecision(4)).toString()
    : '—'

/**
 * Short human-readable summary of an `icpAlign` or `fitPointPairs` result.
 * The shift is reported at the result's `pivot` (the reference centroid for ICP,
 * the source-pair centroid for a pair fit): `t` itself is the move of the CRS
 * origin, which at survey coordinates is kilometres for a fraction of a degree.
 * @param {object} result
 * @param {{ unit?: string }} [opts] unit label for lengths
 * @returns {string[]}
 */
export function alignmentReport(result, { unit = 'units' } = {}) {
  const lines = []
  const tf = result.transform
  const inl =
    result.inlierFraction != null
      ? ` over ${(100 * result.inlierFraction).toFixed(1)}% of the sample in range`
      : result.count != null
        ? ` over ${result.count} pairs`
        : ''
  lines.push(`RMS ${fmt(result.rms)} ${unit}${inl}`)
  if (tf?.R) {
    lines.push(`rotation ${((rotationAngle(tf.R) * 180) / Math.PI).toFixed(4)}°`)
    let shift
    if (result.pivot) {
      const p = result.pivot,
        q = applyTransform(tf, p)
      shift = [q[0] - p[0], q[1] - p[1], q[2] - p[2]]
    } else shift = tf.t
    lines.push(
      `shift ${fmt(Math.hypot(shift[0], shift[1], shift[2]))} ${unit} ` +
        `(${shift.map(fmt).join(', ')})${result.pivot ? ' at the centroid' : ''}`,
    )
    lines.push(`scale ${(tf.scale ?? 1).toFixed(6)}`)
  }
  if (result.iterations != null) {
    lines.push(
      `${result.method ?? 'ICP'}: ${result.converged ? 'converged' : 'not converged'} after ` +
        `${result.iterations} iteration${result.iterations === 1 ? '' : 's'}`,
    )
  }
  if (Array.isArray(result.residuals) && result.residuals.length) {
    let worst = 0
    result.residuals.forEach((r, i) => {
      if (r > result.residuals[worst]) worst = i
    })
    lines.push(`largest pair residual ${fmt(result.residuals[worst])} ${unit} (pair ${worst + 1})`)
  }
  return lines
}
