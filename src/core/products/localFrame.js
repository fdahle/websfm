// Local metric frame for georeferencing in a projected CRS. Pure, no proj4 —
// the caller supplies a grid→geographic callback once, when the frame is built;
// every later mapping is closed-form, so frames, workers and exporters need no
// projection library.
//
// Why: a 7-parameter similarity assumes both sides are Cartesian, but project
// grid coordinates are not. Grid E/N are scaled by the projection's point scale
// factor k (0.980 at 80°S, 0.973 at the pole in EPSG:3031, 1.0004 on a UTM
// edge) while ellipsoidal heights are not, and the grid ignores Earth curvature
// (a point 5 km away at the same height is ~2 m *below* the tangent plane).
// Fitting a similarity straight to grid+height therefore leaves model error that
// error-free control cannot remove: 2.2 m RMS on a 6 km block at 80°S, 7 m on
// 10 km at 85°S, with DEM relief compressed by k.
//
// A conformal projection is locally a similarity (scale k, rotation by the
// meridian convergence), so dividing out k about a site origin and restoring the
// curvature drop gives a Cartesian frame to within the variation of k across the
// block. The rotation is absorbed by the similarity itself.
//
// That first-order frame still left 6 cm (80°S, 6 km) to 18 cm (85°S, 10 km): k
// itself varies across the block (≈3.5e-5 over 5 km near the pole). For a conformal
// map the second-order term is fixed entirely by the gradient of log k (Cauchy–
// Riemann: log f' is analytic, so its derivative is ∂ₓlog k − i∂ᵧlog k). In complex
// grid-oriented coordinates, with u = ((E−e0) + i(N−n0))/k and ground ζ:
//     u = ζ + ½·c·ζ²,   c = k·(g_E − i·g_N),  g = ∇ log k  (per grid unit)
// solved exactly both ways: ζ = 2u / (1 + √(1 + 2cu)) (the cancellation-free root).
// Residual is third order: ~10 µm over 10 km at 85°S.
//
// Height matters horizontally too: a point h above its foot sits on the foot's
// ellipsoid normal, which tilts by d/R away from the origin, so its tangent-frame
// horizontal position is ζ·(1 + h/R) — the grid only knows the foot. Over ±500 m of
// relief at 5 km that was ±0.4 m. The curvature drop is d²/(2R) at the foot.
//
//   frame  { e0, n0, k, R, gE?, gN? } — origin (grid units), point scale factor at
//          the origin, Gaussian mean radius (grid units), ∇log k (absent ⇒ 0)
//   gridToLocal([E, N, h]) = [ζx·(1+h/R), ζy·(1+h/R), h − |ζ|²/(2R)]
//   localToGrid([x, y, u]) = its inverse (a fixed point that converges to machine
//                            precision in a few steps — the coupling is O(h/R)).
// Heights stay in the vertical unit of the CRS.

import { geodeticToEcef } from './tiles3d.js'

const WGS84_A = 6378137
const WGS84_E2 = 0.00669437999014

// Second-order coefficient c = k·(g_E − i·g_N) as [re, im].
const coeff = (f) => [f.k * (f.gE || 0), -f.k * (f.gN || 0)]

function csqrt(a, b) {
  const r = Math.hypot(a, b)
  const re = Math.sqrt((r + a) / 2), im = Math.sqrt(Math.max(0, (r - a) / 2))
  return [re, b < 0 ? -im : im]
}

export function gridToLocal(p, f) {
  const ur = (p[0] - f.e0) / f.k, ui = (p[1] - f.n0) / f.k
  const [cr, ci] = coeff(f)
  // ζ = 2u / (1 + √(1 + 2cu))
  const [sr, si] = csqrt(1 + 2 * (cr * ur - ci * ui), 2 * (cr * ui + ci * ur))
  const dr = 1 + sr, di = si, dd = dr * dr + di * di
  const x = 2 * (ur * dr + ui * di) / dd, y = 2 * (ui * dr - ur * di) / dd
  const lift = 1 + p[2] / f.R
  return [x * lift, y * lift, p[2] - (x * x + y * y) / (2 * f.R)]
}

export function localToGrid(p, f) {
  const [cr, ci] = coeff(f)
  // Recover the foot ζ and the height h together: h = u + |ζ|²/(2R), ζ = (x,y)/(1+h/R).
  let h = p[2], x = p[0], y = p[1]
  for (let i = 0; i < 6; i++) {
    const lift = 1 + h / f.R
    x = p[0] / lift; y = p[1] / lift
    h = p[2] + (x * x + y * y) / (2 * f.R)
  }
  // u = ζ + ½cζ²
  const zr = x * x - y * y, zi = 2 * x * y
  const ur = x + 0.5 * (cr * zr - ci * zi), ui = y + 0.5 * (cr * zi + ci * zr)
  return [f.e0 + f.k * ur, f.n0 + f.k * ui, h]
}

// A precision matrix (inverse covariance) given in grid units, expressed in the
// local frame. x = J·g with J ≈ diag(1/k, 1/k, 1) (the curvature term's gradient is
// x/R ≈ 1e-3 at 6 km and negligible against survey σ), so P_local = Jᵀ⁻¹·P·J⁻¹ =
// D·P·D with D = diag(k, k, 1).
export function precisionToLocal(P, f) {
  if (!P) return P
  const d = [f.k, f.k, 1]
  return P.map((row, i) => row.map((v, j) => d[i] * v * d[j]))
}

// Gaussian mean radius of curvature √(M·N) at geodetic latitude φ, in metres.
export function gaussianRadius(latDeg) {
  const s = Math.sin((latDeg * Math.PI) / 180)
  const w = Math.sqrt(1 - WGS84_E2 * s * s)
  return Math.sqrt((WGS84_A * (1 - WGS84_E2)) / (w * w * w) * (WGS84_A / w))
}

/**
 * Build the frame at grid origin (e0, n0).
 *   toLonLat([x, y]) → [lonDeg, latDeg]   the CRS's inverse projection
 *   metresPerUnit                           metres per CRS linear unit (1 for m)
 * k is measured from probes ±`probe` grid units east and north (chord ≈ arc at
 * that distance), averaged — equal for a conformal projection, and the average
 * is the best single scale if a CRS is mildly non-conformal.
 * Returns null when the probes do not resolve (outside the projection's domain).
 */
export function buildMetricFrame(toLonLat, e0, n0, { metresPerUnit = 1, probe = 50, gradient = true } = {}) {
  const ecef = ([x, y]) => {
    const ll = toLonLat([x, y])
    return ll && Number.isFinite(ll[0]) && Number.isFinite(ll[1]) ? geodeticToEcef(ll[0], ll[1], 0) : null
  }
  const centre = toLonLat([e0, n0])
  if (!centre || !Number.isFinite(centre[1])) return null
  const span = (a, b) => {
    const pa = ecef(a), pb = ecef(b)
    return pa && pb ? Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]) : NaN
  }
  const ground = (span([e0 - probe, n0], [e0 + probe, n0]) + span([e0, n0 - probe], [e0, n0 + probe])) / 2
  const k = (2 * probe * metresPerUnit) / ground
  const R = gaussianRadius(centre[1]) / metresPerUnit
  if (!(k > 0) || !Number.isFinite(k) || !(R > 0)) return null
  if (!gradient) return { e0, n0, k, R }
  // ∇log k by central differences over ±D grid units (k is smooth; D large enough
  // that the probe chords resolve the change, small enough to stay local).
  const D = 1000 / metresPerUnit
  const kAt = (x, y) => buildMetricFrame(toLonLat, x, y, { metresPerUnit, probe, gradient: false })?.k
  const kE1 = kAt(e0 + D, n0), kE0 = kAt(e0 - D, n0), kN1 = kAt(e0, n0 + D), kN0 = kAt(e0, n0 - D)
  const gE = kE1 && kE0 ? (Math.log(kE1) - Math.log(kE0)) / (2 * D) : 0
  const gN = kN1 && kN0 ? (Math.log(kN1) - Math.log(kN0)) / (2 * D) : 0
  return { e0, n0, k, R, gE, gN }
}

/** Point scale factor k at a grid position — grid distance / ground distance. */
export function pointScaleFactor(toLonLat, x, y, opts = {}) {
  return buildMetricFrame(toLonLat, x, y, { ...opts, gradient: false })?.k ?? null
}
