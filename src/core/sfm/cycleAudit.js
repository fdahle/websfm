import { matMul3, matT3, rotAngleDeg } from './rotations.js'

// ── Audit of the rotation-cycle filter against the finished model (pure) ─────
// The filter judges each pair by the relative rotation decomposed from its F, before
// any camera exists. Once the model is solved, every pair whose two images registered
// has a ground truth to compare with, and each pair can be put in one of three bins:
//
//   false    — most of its matches violate the final epipolar geometry: a genuinely
//              wrong pair (the filter was right to drop it);
//   badRot   — its matches agree with the final geometry, but the rotation recovered
//              from F does not: a true pair with an unreliable rotation estimate (a
//              planar / low-parallax E decomposition). A better R source fixes these;
//   goodRot  — true matches AND a correct rotation: dropped only because the cycles it
//              sat in were broken by OTHER edges.
//
// Kept pairs are binned the same way, as the reference: if kept pairs also show large
// rotation errors, the comparison convention or the pose estimate is suspect, not the
// filter. This is diagnosis only — nothing here changes the reconstruction.
//
// pairs: [{ idA, idB, matches: [[ia, ib], …], degenerate? }]
// rotations: Map 'a--b' (a<b) → R (idA→idB, row-major 3×3) as the filter saw it
// cameras: Map uuid → { R, t, K } (world→camera, pinhole frame; K as { fx, fy, cx, cy })
// keypointOf(uuid, idx) → { x, y } in the same pinhole frame as the cameras

const pk = (a, b) => (a < b ? `${a}--${b}` : `${b}--${a}`)

function inv3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g
  const det = a * A + b * B + c * C
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ]
}

/** Relative pose of B w.r.t. A: X_B = R·X_A + t. */
export function relativePose(camA, camB) {
  const R = matMul3(camB.R, matT3(camA.R))
  const Rt = R.map((row) => row[0] * camA.t[0] + row[1] * camA.t[1] + row[2] * camA.t[2])
  return { R, t: [camB.t[0] - Rt[0], camB.t[1] - Rt[1], camB.t[2] - Rt[2]] }
}

// Intrinsics as a 3×3 matrix; cameras carry them as { fx, fy, cx, cy }.
const kMat = (K) => (Array.isArray(K) ? K : [[K.fx, 0, K.cx], [0, K.fy, K.cy], [0, 0, 1]])

/** Fundamental matrix of the pair from two posed cameras: x_Bᵀ F x_A = 0. */
export function fundamentalFromPoses(camA, camB) {
  const { R, t } = relativePose(camA, camB)
  const tx = [[0, -t[2], t[1]], [t[2], 0, -t[0]], [-t[1], t[0], 0]]
  const E = matMul3(tx, R)
  return matMul3(matMul3(matT3(inv3(kMat(camB.K))), E), inv3(kMat(camA.K)))
}

/** Sampson distance (px) of one correspondence under F. */
export function sampsonPx(F, a, b) {
  const Fa = [F[0][0] * a.x + F[0][1] * a.y + F[0][2], F[1][0] * a.x + F[1][1] * a.y + F[1][2], F[2][0] * a.x + F[2][1] * a.y + F[2][2]]
  const Ftb = [F[0][0] * b.x + F[1][0] * b.y + F[2][0], F[0][1] * b.x + F[1][1] * b.y + F[2][1]]
  const e = b.x * Fa[0] + b.y * Fa[1] + Fa[2]
  const den = Fa[0] * Fa[0] + Fa[1] * Fa[1] + Ftb[0] * Ftb[0] + Ftb[1] * Ftb[1]
  return den > 0 ? Math.sqrt((e * e) / den) : Infinity
}

const median = (v) => {
  if (!v.length) return null
  const s = [...v].sort((x, y) => x - y)
  return s[Math.floor((s.length - 1) / 2)]
}

/**
 * Bin pairs by match truth and rotation error against the final model.
 *
 * @param {object} o
 * @param {Array} o.pairs
 * @param {Map} o.rotations
 * @param {Map} o.cameras
 * @param {(uuid: string, idx: number) => ({x:number,y:number}|null)} o.keypointOf
 * @param {number} [o.epipolarPx]  a match is "true" when its Sampson distance is below
 * @param {number} [o.trueFrac]    a pair is "true" when at least this share of its matches is
 * @param {number} [o.rotTolDeg]   a rotation estimate is "good" within this angle
 */
export function auditPairs({ pairs, rotations, cameras, keypointOf, epipolarPx = 4, trueFrac = 0.5, rotTolDeg = 5 }) {
  const bins = { false: 0, badRot: 0, goodRot: 0, unposed: 0, noRotation: 0 }
  const degenerate = { false: 0, badRot: 0, goodRot: 0 }
  const rotErr = []
  const rows = []
  for (const p of pairs) {
    const camA = cameras.get(p.idA), camB = cameras.get(p.idB)
    if (!camA || !camB) { bins.unposed++; continue }
    const R = rotations.get(pk(p.idA, p.idB))
    let agree = 0, n = 0
    const F = fundamentalFromPoses(camA, camB)
    for (const [ia, ib] of p.matches) {
      const a = keypointOf(p.idA, ia), b = keypointOf(p.idB, ib)
      if (!a || !b) continue
      n++
      if (sampsonPx(F, a, b) <= epipolarPx) agree++
    }
    const frac = n ? agree / n : 0
    let err = null
    if (R) {
      // The filter's R maps the pair's idA to its idB (recoverPose on [A, B]).
      err = rotAngleDeg(matMul3(R, matT3(relativePose(camA, camB).R)))
      rotErr.push(err)
    }
    let bin
    if (frac < trueFrac) bin = 'false'
    else if (err == null) { bins.noRotation++; continue }
    else bin = err <= rotTolDeg ? 'goodRot' : 'badRot'
    bins[bin]++
    if (p.degenerate) degenerate[bin]++
    rows.push({ idA: p.idA, idB: p.idB, bin, agreeFrac: frac, rotErrDeg: err, matches: n, degenerate: !!p.degenerate })
  }
  return { bins, degenerate, medianRotErrDeg: median(rotErr), rows }
}
