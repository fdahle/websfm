// Interior orientation for scanned film (F4).
//
// Scanned historical film has scan geometry ≠ camera geometry: every scan places
// the film frame differently (translation, rotation, slight scale/shear from the
// scanner), and the principal point / pixel pitch are otherwise only guessed. A
// metric film camera exposes fiducial marks whose positions the calibration
// certificate gives in millimetres in the camera frame. Fitting a per-image affine
// between clicked scan pixels and those calibrated mm coordinates recovers, per
// image: true pixel pitch, scan rotation, shear, and the principal point in scan
// pixels — i.e. a correct interior orientation.
//
// We treat scan geometry exactly like lens distortion: remove it once, at SfM
// ingest, so the whole pipeline stays pinhole with one shared K per sensor. This
// module is the pure math — no Vue/Pinia/OPFS, worker-safe.
//
// The transform chain, applied to keypoints at ingest, is
//   scan px ──(per-image affine A)──► camera mm ──(canonical frame)──► canonical px
// and the inverse (canonical px → scan px) is the dense raster sample map.
//
// Distortion ordering: the certificate's radial distortion is defined in the
// camera mm frame about the principal point, so the correct chain is
//   scan px →(affine)→ mm →(lens undistort)→ ideal mm → canonical px.
// The canonical frame is a *pure scale+offset* of the mm frame (fx = fy =
// focalMm/pitchMm, cx/cy = the principal point mapped into the grid), so applying
// the existing Brown `undistortPixel` in canonical px with the canonical K is
// mathematically identical to undistorting in mm — the pipeline order stays
// "fiducial transform first, then the existing distortion path", with no new
// distortion code. (Fitting k1/k2 from a certificate distortion table is a
// follow-up, out of v1.)

import { applyFiducialTransform, invertFiducialTransform } from './fiducialCalibration.js'

const DEG = 180 / Math.PI

// Solve a symmetric 3×3 system N·x = b (Cramer's rule). Returns null if singular.
function solve3(N, b) {
  // N is symmetric so N[i][j] === N[j][i]; name the six distinct entries.
  const n00 = N[0][0], n01 = N[0][1], n02 = N[0][2]
  const n11 = N[1][1], n12 = N[1][2], n22 = N[2][2]
  const det =
    n00 * (n11 * n22 - n12 * n12) -
    n01 * (n01 * n22 - n12 * n02) +
    n02 * (n01 * n12 - n11 * n02)
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null
  // Inverse of the symmetric 3×3.
  const c00 = n11 * n22 - n12 * n12
  const c01 = n02 * n12 - n01 * n22
  const c02 = n01 * n12 - n02 * n11
  const c11 = n00 * n22 - n02 * n02
  const c12 = n01 * n02 - n00 * n12
  const c22 = n00 * n11 - n01 * n01
  return [
    (c00 * b[0] + c01 * b[1] + c02 * b[2]) / det,
    (c01 * b[0] + c11 * b[1] + c12 * b[2]) / det,
    (c02 * b[0] + c12 * b[1] + c22 * b[2]) / det,
  ]
}

/**
 * Least-squares affine `scan px → camera mm` from paired observations.
 * `obs`: `[{ px, py, xMm, yMm }]` (the join of `image.fiducialObs` with the
 * sensor's calibrated marks). Returns `null` when < 3 usable pairs or the system
 * is degenerate (collinear marks).
 *
 * The affine is
 *   xMm = a·px + b·py + c
 *   yMm = d·px + e·py + f
 * Both rows share the design matrix `[px py 1]`, so one 3×3 normal matrix serves
 * both right-hand sides.
 *
 * @returns {null | {
 *   A: [number,number,number,number,number,number],  // [a,b,c,d,e,f]
 *   residualsUm: number[],  // per-mark residual magnitude, µm
 *   rmsUm: number,          // RMS residual, µm (the audit number)
 *   pitchMm: number,        // mean singular value of the 2×2 part (px size in mm)
 *   shear: number, scaleRatio: number, rotDeg: number,  // diagnostics
 * }}
 */
export function fitFiducialAffine(obs) {
  const pts = (obs || []).filter(
    (o) => o && Number.isFinite(o.px) && Number.isFinite(o.py)
      && Number.isFinite(o.xMm) && Number.isFinite(o.yMm),
  )
  if (pts.length < 3) return null

  // Normal matrix N = MᵀM with M = [px py 1] and RHS Mᵀ·xMm, Mᵀ·yMm.
  let spp = 0, spq = 0, sp = 0, sqq = 0, sq = 0, s1 = 0
  let bx0 = 0, bx1 = 0, bx2 = 0, by0 = 0, by1 = 0, by2 = 0
  for (const o of pts) {
    const p = o.px, q = o.py
    spp += p * p; spq += p * q; sp += p
    sqq += q * q; sq += q; s1 += 1
    bx0 += p * o.xMm; bx1 += q * o.xMm; bx2 += o.xMm
    by0 += p * o.yMm; by1 += q * o.yMm; by2 += o.yMm
  }
  const N = [[spp, spq, sp], [spq, sqq, sq], [sp, sq, s1]]
  const rowX = solve3(N, [bx0, bx1, bx2])   // [a, b, c]
  const rowY = solve3(N, [by0, by1, by2])   // [d, e, f]
  if (!rowX || !rowY) return null

  const A = [rowX[0], rowX[1], rowX[2], rowY[0], rowY[1], rowY[2]]
  const [a, b, , d, e] = A

  // Residuals in µm.
  const residualsUm = pts.map((o) => {
    const ex = (a * o.px + A[1] * o.py + A[2]) - o.xMm
    const ey = (d * o.px + e * o.py + A[5]) - o.yMm
    return Math.hypot(ex, ey) * 1000
  })
  const rmsUm = Math.sqrt(residualsUm.reduce((s, r) => s + r * r, 0) / residualsUm.length)

  // Singular values of the 2×2 linear part B = [[a,b],[d,e]] via eigenvalues of BᵀB.
  const pp = a * a + d * d, qq = b * b + e * e, rr = a * b + d * e
  const mid = (pp + qq) / 2
  const rad = Math.sqrt(Math.max(0, ((pp - qq) / 2) ** 2 + rr * rr))
  const sigma1 = Math.sqrt(Math.max(0, mid + rad))
  const sigma2 = Math.sqrt(Math.max(0, mid - rad))
  const pitchMm = (sigma1 + sigma2) / 2
  const scaleRatio = sigma2 > 0 ? sigma1 / sigma2 : Infinity

  // Rotation + shear via the standard 2D affine decomposition B = R(θ)·[[sx, sh],[0, sy]].
  const det = a * e - b * d
  const sx = Math.hypot(a, d)
  const rotDeg = Math.atan2(d, a) * DEG
  const shear = sx > 0 && det !== 0 ? (a * b + d * e) / det : 0

  return { A, residualsUm, rmsUm, pitchMm, shear, scaleRatio, rotDeg }
}

/**
 * Canonical pixel frame for a film sensor: a virtual pixel grid at `pitchMm`
 * covering the calibrated fiducial layout. One shared frame (hence one K) serves
 * every image of the sensor; `pitchMm` is normally the median of the per-image
 * fitted pitches so the frame doesn't chase any single scan.
 *
 * @param {{ marks: {xMm:number,yMm:number}[], ppxMm:number, ppyMm:number, focalMm:number }} fiducials
 * @param {number} pitchMm
 * @returns {null | { width:number, height:number, originX:number, originY:number,
 *   pitchMm:number, K:{fx:number,fy:number,cx:number,cy:number} }}
 *   `originX/Y` are the mm coords of pixel (0,0); the mm→px map is
 *   `x = (mmX − originX)/pitchMm`, `y = (mmY − originY)/pitchMm`.
 */
export function canonicalFrame(fiducials, pitchMm) {
  const marks = fiducials?.marks || []
  if (!Number.isFinite(pitchMm) || pitchMm <= 0 || !Number.isFinite(fiducials?.focalMm)
    || fiducials.focalMm <= 0 || marks.length < 3) return null
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const m of marks) {
    if (!Number.isFinite(m.xMm) || !Number.isFinite(m.yMm)) continue
    if (m.xMm < minX) minX = m.xMm
    if (m.xMm > maxX) maxX = m.xMm
    if (m.yMm < minY) minY = m.yMm
    if (m.yMm > maxY) maxY = m.yMm
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null
  const extent = Math.max(maxX - minX, maxY - minY)
  const marginMm = Math.max(0.02 * extent, pitchMm) // small breathing room so edge marks aren't at px 0
  const originX = minX - marginMm
  const originY = minY - marginMm
  const width = Math.max(1, Math.round((maxX - minX + 2 * marginMm) / pitchMm))
  const height = Math.max(1, Math.round((maxY - minY + 2 * marginMm) / pitchMm))
  const f = fiducials.focalMm / pitchMm
  const K = {
    fx: f,
    fy: f,
    cx: ((fiducials.ppxMm ?? 0) - originX) / pitchMm,
    cy: ((fiducials.ppyMm ?? 0) - originY) / pitchMm,
  }
  return { width, height, originX, originY, pitchMm, K }
}

/**
 * Compose scan px → camera mm (per-image affine `A`) → canonical px (frame map).
 * The keypoint move applied at SfM ingest.
 * @returns {{ x:number, y:number }}
 */
export function scanToCanonical(px, py, A, frame) {
  const mm = Array.isArray(A)
    ? { x: A[0] * px + A[1] * py + A[2], y: A[3] * px + A[4] * py + A[5] }
    : applyFiducialTransform({ x: px, y: py }, A)
  const mmX = mm.x, mmY = mm.y
  return {
    x: (mmX - frame.originX) / frame.pitchMm,
    y: (mmY - frame.originY) / frame.pitchMm,
  }
}

/**
 * Invert the per-image affine directly: camera mm → scan px. Used to predict
 * where a not-yet-clicked fiducial mark should land on the raster (the viewer's
 * ghost-marker guides), given a fit from the marks already placed.
 * @returns {null | { x:number, y:number }}
 */
export function mmToScan(xMm, yMm, A) {
  const [a, b, c, d, e, f] = A
  const det = a * e - b * d
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null
  const rx = xMm - c, ry = yMm - f
  return { x: (e * rx - b * ry) / det, y: (-d * rx + a * ry) / det }
}

/**
 * Inverse of {@link scanToCanonical}: canonical px → scan px. The dense raster
 * sample map (output a canonical-grid pixel, read from the scan raster).
 * @returns {{ x:number, y:number }}
 */
export function canonicalToScan(x, y, A, frame) {
  const mmX = x * frame.pitchMm + frame.originX
  const mmY = y * frame.pitchMm + frame.originY
  if (!Array.isArray(A)) return invertFiducialTransform({ x: mmX, y: mmY }, A)
  const [a, b, c, d, e, f] = A
  const det = a * e - b * d
  const rx = mmX - c, ry = mmY - f
  return {
    x: (e * rx - b * ry) / det,
    y: (-d * rx + a * ry) / det,
  }
}
