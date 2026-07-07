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

// Inverse: distorted normalised (xd,yd) → ideal normalised [x,y] by fixed-point
// iteration (the standard OpenCV scheme). Converges in a handful of steps for
// lens-grade coefficients; strong fisheye is out of scope for this model.
export function undistortNormalized(xd, yd, d = {}, iters = 8) {
  const { k1 = 0, k2 = 0, k3 = 0, p1 = 0, p2 = 0 } = d || {}
  let x = xd, y = yd
  for (let i = 0; i < iters; i++) {
    const r2 = x * x + y * y
    const radial = 1 + r2 * (k1 + r2 * (k2 + r2 * k3))
    const xy = x * y
    const dxT = 2 * p1 * xy + p2 * (r2 + 2 * x * x)
    const dyT = p1 * (r2 + 2 * y * y) + 2 * p2 * xy
    x = (xd - dxT) / radial
    y = (yd - dyT) / radial
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
