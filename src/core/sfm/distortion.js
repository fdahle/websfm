// Brown–Conrady lens distortion (radial k1,k2,k3 + tangential p1,p2).
//
// The pipeline is pinhole everywhere; distortion is removed once, "at ingest",
// so no downstream consumer (triangulation, PnP, BA, the three PatchMatch kernels,
// DEM, ortho) has to know about it:
//   • sparse keypoints → undistortPixel (iterative inverse; run per keypoint)
//   • dense/ortho rasters → distortNormalized (closed-form forward; per output px,
//     building the undistorted→distorted sample map)
//
// Convention: (x, y) are NORMALISED image coords, x = (u − cx) / fx. The forward
// model maps an ideal (undistorted) normalised point to where the real lens
// recorded it; the inverse recovers the ideal point from an observed one.

// True when any coefficient is non-zero (so callers can cheaply skip the no-op).
export function hasDistortion(d) {
  return !!d && !!(d.k1 || d.k2 || d.k3 || d.p1 || d.p2)
}

// ── Distortion models (D3) ───────────────────────────────────────────────────
// A sensor declares which Brown–Conrady coefficients it *uses* (and, for the
// self-calibrated subset, refines). The model governs the sensor UI (which
// coefficient inputs are live) and `distortionOf` (only active coefficients are
// applied at ingest — a stale k3 left over from a model switch can't leak). The
// pipeline stays pinhole regardless: the chosen coefficients are removed once at
// ingest (keypoints + rasters), exactly as before. Ordered simplest → richest.
export const DISTORTION_MODELS = [
  { id: 'pinhole', label: 'Pinhole (none)',        coeffs: [] },
  { id: 'radial',  label: 'Radial (k1)',           coeffs: ['k1'] },
  { id: 'radial2', label: 'Radial (k1,k2)',        coeffs: ['k1', 'k2'] },
  { id: 'brown',   label: 'Brown (k1,k2,k3,p1,p2)', coeffs: ['k1', 'k2', 'k3', 'p1', 'p2'] },
]
const MODEL_BY_ID = new Map(DISTORTION_MODELS.map((m) => [m.id, m]))
const ALL_COEFFS = ['k1', 'k2', 'k3', 'p1', 'p2']

// Active coefficient keys for a model id. An unknown/undefined model returns the
// full set — back-compat for sensors saved before models existed (their non-zero
// coefficients are all applied, exactly as the old `distortionOf` did).
export function coeffsForModel(model) {
  return MODEL_BY_ID.get(model)?.coeffs ?? ALL_COEFFS
}

// Pick the tightest model that covers a sensor's non-zero coefficients — used to
// seed the model of an imported calibration (which carries coefficients but no
// explicit model choice).
export function inferDistortionModel(sensor) {
  if (!sensor) return 'pinhole'
  if (sensor.k3 || sensor.p1 || sensor.p2) return 'brown'
  if (sensor.k2) return 'radial2'
  if (sensor.k1) return 'radial'
  return 'pinhole'
}

// Forward Brown–Conrady: ideal normalised (x,y) → distorted normalised [xd,yd].
export function distortNormalized(x, y, d = {}) {
  const { k1 = 0, k2 = 0, k3 = 0, p1 = 0, p2 = 0 } = d || {}
  const r2 = x * x + y * y
  const radial = 1 + r2 * (k1 + r2 * (k2 + r2 * k3))
  const xy = x * y
  const xd = x * radial + 2 * p1 * xy + p2 * (r2 + 2 * x * x)
  const yd = y * radial + p1 * (r2 + 2 * y * y) + 2 * p2 * xy
  return [xd, yd]
}

// Inverse: distorted normalised (xd,yd) → ideal normalised [x,y].
//
// Newton on the exact forward model, with backtracking, to a tolerance — not a
// fixed count of fixed-point steps. The self-cal fold relies on this being the
// exact inverse of BA's forward model, and the fixed-point scheme (OpenCV's
// default 5–10 steps) stops short on strong barrel distortion: at the corner of a
// 4000×3000 / f=3000 frame it was off by 0.46 px at k1=−0.18 and 3.4 px at −0.20,
// errors the fold then baked into every keypoint. Newton converges quadratically
// wherever the forward map is invertible; where it is not (past the radius at
// which r·(1+k1r²+…) turns back) no inverse exists and the best point is returned.
// `iters` caps the Newton steps (the common case converges in 2–4).
export function undistortNormalized(xd, yd, d = {}, iters = 20) {
  const { k1 = 0, k2 = 0, k3 = 0, p1 = 0, p2 = 0 } = d || {}
  const residual = (x, y) => {
    const [fx, fy] = distortNormalized(x, y, d)
    return [fx - xd, fy - yd]
  }
  let x = xd, y = yd
  let [ex, ey] = residual(x, y)
  let err = ex * ex + ey * ey
  for (let i = 0; i < iters && err > 1e-26; i++) {
    const r2 = x * x + y * y
    const radial = 1 + r2 * (k1 + r2 * (k2 + r2 * k3))
    const g = k1 + r2 * (2 * k2 + 3 * k3 * r2) // d radial / d r²
    const a = radial + 2 * x * x * g + 2 * p1 * y + 6 * p2 * x
    const b = 2 * x * y * g + 2 * p1 * x + 2 * p2 * y
    const c = b
    const e = radial + 2 * y * y * g + 6 * p1 * y + 2 * p2 * x
    const det = a * e - b * c
    if (!(Math.abs(det) > 1e-15)) break
    const sx = (e * ex - b * ey) / det
    const sy = (a * ey - c * ex) / det
    // Backtrack: never accept a step that increases the residual (keeps Newton
    // from jumping across a fold of a strongly distorting model).
    let t = 1, improved = false
    for (let h = 0; h < 8; h++, t *= 0.5) {
      const nx = x - t * sx, ny = y - t * sy
      const [rx, ry] = residual(nx, ny)
      const nerr = rx * rx + ry * ry
      if (nerr < err) { x = nx; y = ny; ex = rx; ey = ry; err = nerr; improved = true; break }
    }
    if (!improved) break
  }
  return [x, y]
}

// Undistort a DISTORTED pixel (as observed) into the ideal pinhole pixel it should
// occupy under intrinsics K. Returns { x, y } in pixels; a no-op when d is zero.
export function undistortPixel(u, v, K, d) {
  if (!hasDistortion(d)) return { x: u, y: v }
  const { fx, fy, cx, cy } = K
  const [x, y] = undistortNormalized((u - cx) / fx, (v - cy) / fy, d)
  return { x: fx * x + cx, y: fy * y + cy }
}

// Forward: an ideal pinhole pixel → the distorted pixel the lens recorded there.
// Used to build the sample map for raster undistortion (and to test round-trips).
export function distortPixel(u, v, K, d) {
  if (!hasDistortion(d)) return { x: u, y: v }
  const { fx, fy, cx, cy } = K
  const [xd, yd] = distortNormalized((u - cx) / fx, (v - cy) / fy, d)
  return { x: fx * xd + cx, y: fy * yd + cy }
}

// Pull the Brown coefficients that the sensor's distortion model uses into a plain
// bag (or null when all zero) — the shape the worker/sfm marshalling forwards.
// Coefficients outside the active model are treated as zero (a model switch can't
// leave a stale term applied). No `distortionModel` ⇒ all five (pre-model back-compat).
export function distortionOf(sensor) {
  if (!sensor) return null
  const active = coeffsForModel(sensor.distortionModel)
  const d = { k1: 0, k2: 0, k3: 0, p1: 0, p2: 0 }
  for (const k of active) d[k] = sensor[k] || 0
  return hasDistortion(d) ? d : null
}
