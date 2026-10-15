// Lens models: Brown–Conrady (radial k1,k2,k3 + tangential p1,p2), its rational
// extension (k4,k5,k6 in a denominator, OpenCV's CALIB_RATIONAL_MODEL) and the
// Kannala–Brandt fisheye (OpenCV fisheye / COLMAP *_FISHEYE).
//
// The pipeline is pinhole everywhere; the lens is removed once, "at ingest",
// so no downstream consumer (triangulation, PnP, BA, the three PatchMatch kernels,
// DEM, ortho) has to know about it:
//   • sparse keypoints → undistortPixel (iterative inverse; run per keypoint)
//   • dense/ortho rasters → distortNormalized (closed-form forward; per output px,
//     building the undistorted→distorted sample map)
//
// Convention: (x, y) are NORMALISED image coords, x = (u − cx) / fx. The forward
// model maps an ideal (undistorted, pinhole) normalised point to where the real lens
// recorded it; the inverse recovers the ideal point from an observed one.
//
// A *bag* is what distortionOf returns and every consumer passes around: the active
// coefficients as plain numbers, plus `fisheye: true` for the Kannala–Brandt family.
// A bag without that flag is Brown/rational (the self-cal bags are always Brown).

// True when the bag changes anything (so callers can cheaply skip the no-op). A
// fisheye bag always does: with every k zero it is still the equidistant
// projection r = f·θ, nothing like a pinhole.
export function hasDistortion(d) {
  return !!d && !!(d.fisheye || d.k1 || d.k2 || d.k3 || d.p1 || d.p2 || d.k4 || d.k5 || d.k6)
}

// ── Distortion models (D3) ───────────────────────────────────────────────────
// A sensor declares which lens model it uses: the projection family and which
// coefficients are live. The model governs the sensor UI (which coefficient inputs
// are live), `distortionOf` (only active coefficients are applied at ingest — a
// stale k3 left over from a model switch can't leak) and the COLMAP mapping
// (`colmap`). The pipeline stays pinhole regardless: the lens is removed once at
// ingest (keypoints + rasters). Ordered simplest → richest within each family.
//
// The fisheye family reuses k1…k4 for its own polynomial in the ray angle θ, as
// COLMAP and OpenCV do: θd = θ·(1 + k1·θ² + k2·θ⁴ + k3·θ⁶ + k4·θ⁸).
export const DISTORTION_MODELS = [
  { id: 'pinhole',  label: 'Pinhole (none)',            family: 'brown',   coeffs: [], colmap: 'PINHOLE' },
  { id: 'radial',   label: 'Radial (k1)',               family: 'brown',   coeffs: ['k1'], colmap: 'SIMPLE_RADIAL' },
  { id: 'radial2',  label: 'Radial (k1,k2)',            family: 'brown',   coeffs: ['k1', 'k2'], colmap: 'RADIAL' },
  { id: 'brown',    label: 'Brown (k1,k2,k3,p1,p2)',    family: 'brown',   coeffs: ['k1', 'k2', 'k3', 'p1', 'p2'], colmap: 'OPENCV' },
  { id: 'rational', label: 'Rational (k1–k6,p1,p2)',    family: 'brown',
    coeffs: ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'p1', 'p2'], colmap: 'FULL_OPENCV' },
  { id: 'fisheye1', label: 'Fisheye (k1)',              family: 'fisheye', coeffs: ['k1'], colmap: 'SIMPLE_RADIAL_FISHEYE' },
  { id: 'fisheye2', label: 'Fisheye (k1,k2)',           family: 'fisheye', coeffs: ['k1', 'k2'], colmap: 'RADIAL_FISHEYE' },
  { id: 'fisheye',  label: 'Fisheye (k1–k4)',           family: 'fisheye', coeffs: ['k1', 'k2', 'k3', 'k4'], colmap: 'OPENCV_FISHEYE' },
]
const MODEL_BY_ID = new Map(DISTORTION_MODELS.map((m) => [m.id, m]))
const BROWN_COEFFS = ['k1', 'k2', 'k3', 'p1', 'p2']
// Every coefficient a sensor can carry, in display order.
export const DISTORTION_COEFFS = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'p1', 'p2']

// Active coefficient keys for a model id. An unknown/undefined model returns the
// Brown set — back-compat for sensors saved before models existed (their non-zero
// coefficients are all applied, exactly as the old `distortionOf` did).
export function coeffsForModel(model) {
  return MODEL_BY_ID.get(model)?.coeffs ?? BROWN_COEFFS
}

// True for the Kannala–Brandt family (a sensor's `distortionModel` id).
export function isFisheyeModel(model) {
  return MODEL_BY_ID.get(model)?.family === 'fisheye'
}

// Pick the tightest model that covers a sensor's non-zero coefficients — used to
// seed the model of an imported calibration (which carries coefficients but no
// explicit model choice). Coefficients alone cannot say "fisheye": a fisheye
// import must name its model.
export function inferDistortionModel(sensor) {
  if (!sensor) return 'pinhole'
  if (sensor.k4 || sensor.k5 || sensor.k6) return 'rational'
  if (sensor.k3 || sensor.p1 || sensor.p2) return 'brown'
  if (sensor.k2) return 'radial2'
  if (sensor.k1) return 'radial'
  return 'pinhole'
}

// Read a lens-model name from a file — our own ids, COLMAP model names and the
// common spellings of other tools (OpenSfM, Metashape, ODM) — as a model id, or
// null when the text names no model this pipeline knows.
const MODEL_NAME_ALIASES = {
  perspective: 'pinhole', frame: 'pinhole', simple_pinhole: 'pinhole', none: 'pinhole',
  simple_radial: 'radial', opencv: 'brown', brown_conrady: 'brown',
  full_opencv: 'rational', opencv_rational: 'rational',
  simple_radial_fisheye: 'fisheye1', radial_fisheye: 'fisheye2',
  opencv_fisheye: 'fisheye', fisheye_opencv: 'fisheye', kannala_brandt: 'fisheye', equidistant: 'fisheye',
}
// COLMAP's names win when the text is written the COLMAP way (upper case): its
// RADIAL is k1,k2 where our own `radial` id is k1 alone.
const MODEL_BY_COLMAP = new Map(DISTORTION_MODELS.map((m) => [m.colmap, m.id]))
export function parseDistortionModelName(text) {
  const raw = String(text ?? '').trim()
  if (MODEL_BY_COLMAP.has(raw)) return MODEL_BY_COLMAP.get(raw)
  const t = raw.toLowerCase().replace(/[\s-]+/g, '_')
  if (!t) return null
  if (MODEL_BY_ID.has(t)) return t
  return MODEL_NAME_ALIASES[t] ?? null
}

// ── Brown–Conrady / rational ─────────────────────────────────────────────────
// Radial factor R(r²) = (1 + k1·r² + k2·r⁴ + k3·r⁶) / (1 + k4·r² + k5·r⁴ + k6·r⁶)
// and its slope dR/d(r²). k4…k6 absent ⇒ the denominator is 1: plain Brown.
function radialAndSlope(r2, k1, k2, k3, k4, k5, k6) {
  const num = 1 + r2 * (k1 + r2 * (k2 + r2 * k3))
  const den = 1 + r2 * (k4 + r2 * (k5 + r2 * k6))
  const dNum = k1 + r2 * (2 * k2 + 3 * k3 * r2)
  const dDen = k4 + r2 * (2 * k5 + 3 * k6 * r2)
  return [num / den, (dNum * den - num * dDen) / (den * den)]
}

function distortBrown(x, y, d) {
  const { k1 = 0, k2 = 0, k3 = 0, k4 = 0, k5 = 0, k6 = 0, p1 = 0, p2 = 0 } = d
  const r2 = x * x + y * y
  const [radial] = radialAndSlope(r2, k1, k2, k3, k4, k5, k6)
  const xy = x * y
  const xd = x * radial + 2 * p1 * xy + p2 * (r2 + 2 * x * x)
  const yd = y * radial + p1 * (r2 + 2 * y * y) + 2 * p2 * xy
  return [xd, yd]
}

// Newton on the exact forward model, with backtracking, to a tolerance — not a
// fixed count of fixed-point steps. The self-cal fold relies on this being the
// exact inverse of BA's forward model, and the fixed-point scheme (OpenCV's
// default 5–10 steps) stops short on strong barrel distortion: at the corner of a
// 4000×3000 / f=3000 frame it was off by 0.46 px at k1=−0.18 and 3.4 px at −0.20,
// errors the fold then baked into every keypoint. Newton converges quadratically
// wherever the forward map is invertible; where it is not (past the radius at
// which r·(1+k1r²+…) turns back) no inverse exists and the best point is returned.
function undistortBrown(xd, yd, d, iters) {
  const { k1 = 0, k2 = 0, k3 = 0, k4 = 0, k5 = 0, k6 = 0, p1 = 0, p2 = 0 } = d
  const residual = (x, y) => {
    const [fx, fy] = distortBrown(x, y, d)
    return [fx - xd, fy - yd]
  }
  let x = xd, y = yd
  let [ex, ey] = residual(x, y)
  let err = ex * ex + ey * ey
  for (let i = 0; i < iters && err > 1e-26; i++) {
    const r2 = x * x + y * y
    const [radial, g] = radialAndSlope(r2, k1, k2, k3, k4, k5, k6) // g = d radial / d r²
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

// ── Kannala–Brandt fisheye ───────────────────────────────────────────────────
// A pinhole point at radius r sits on a ray θ = atan(r) off the axis; the lens
// records it at radius θd = θ·(1 + k1θ² + k2θ⁴ + k3θ⁶ + k4θ⁸). All k zero is the
// equidistant fisheye (θd = θ). Same model and parameter order as OpenCV's
// cv::fisheye and COLMAP's OPENCV_FISHEYE (the 1- and 2-term forms are COLMAP's
// SIMPLE_RADIAL_FISHEYE and RADIAL_FISHEYE).
//
// A pinhole frame cannot hold a ray at or past 90° (r = tan θ runs to infinity), so
// the inverse returns NaN there; callers drop such points. Rays short of 90° but
// far off-axis are representable yet badly conditioned — see FISHEYE_MAX_RAY_DEG.
const thetaPoly = (t2, k1, k2, k3, k4) => 1 + t2 * (k1 + t2 * (k2 + t2 * (k3 + t2 * k4)))

function distortFisheye(x, y, d) {
  const { k1 = 0, k2 = 0, k3 = 0, k4 = 0 } = d
  const r = Math.hypot(x, y)
  if (r < 1e-12) return [x, y]
  const theta = Math.atan(r)
  const s = (theta * thetaPoly(theta * theta, k1, k2, k3, k4)) / r
  return [x * s, y * s]
}

function undistortFisheye(xd, yd, d, iters) {
  const { k1 = 0, k2 = 0, k3 = 0, k4 = 0 } = d
  const rd = Math.hypot(xd, yd)
  if (rd < 1e-12) return [xd, yd]
  // Newton on f(θ) = θ·P(θ²) − rd from θ = rd (exact for the equidistant lens).
  const residual = (t) => t * thetaPoly(t * t, k1, k2, k3, k4) - rd
  let theta = Math.min(rd, Math.PI / 2)
  for (let i = 0; i < iters; i++) {
    const t2 = theta * theta
    const df = 1 + t2 * (3 * k1 + t2 * (5 * k2 + t2 * (7 * k3 + t2 * 9 * k4)))
    // A non-increasing θd(θ) has folded back: no unique ray for this radius.
    if (!(df > 1e-9)) return [NaN, NaN]
    const step = residual(theta) / df
    theta -= step
    if (Math.abs(step) < 1e-15) break
  }
  if (!(Math.abs(residual(theta)) <= 1e-10 * Math.max(1, rd))) return [NaN, NaN]
  if (!(theta >= 0) || !(theta < Math.PI / 2 - 1e-9)) return [NaN, NaN]
  const s = Math.tan(theta) / rd
  return [xd * s, yd * s]
}

// Forward: ideal normalised (x,y) → distorted normalised [xd,yd].
export function distortNormalized(x, y, d = {}) {
  if (!d) return [x, y]
  return d.fisheye ? distortFisheye(x, y, d) : distortBrown(x, y, d)
}

// Inverse: distorted normalised (xd,yd) → ideal normalised [x,y]. `iters` caps the
// Newton steps (the common case converges in 2–4). A fisheye point with no pinhole
// image (a ray at or past 90°) comes back as [NaN, NaN].
export function undistortNormalized(xd, yd, d = {}, iters = 20) {
  if (!d) return [xd, yd]
  return d.fisheye ? undistortFisheye(xd, yd, d, Math.max(iters, 30)) : undistortBrown(xd, yd, d, iters)
}

// Largest off-axis ray angle a fisheye keypoint (or match) is kept at. A pinhole
// frame stretches a fisheye by 1/cos²θ in the radial direction: 1 px of detection
// noise at 60° is 4 px in the pinhole frame, at 80° it is 33 px, and the pixel
// gates downstream (RANSAC, PnP, the track filter) cannot tell such points from
// outliers. Past this angle a point costs more than it adds.
export const FISHEYE_MAX_RAY_DEG = 75
const FISHEYE_MAX_PINHOLE_R = Math.tan((FISHEYE_MAX_RAY_DEG * Math.PI) / 180)

// Undistort a pixel for the sparse pipeline: undistortPixel, but a fisheye point
// past FISHEYE_MAX_RAY_DEG comes back as NaN (dropped). Brown bags are untouched.
export function undistortKeypoint(u, v, K, d) {
  const p = undistortPixel(u, v, K, d)
  if (!d?.fisheye) return p
  const r = Math.hypot((p.x - K.cx) / K.fx, (p.y - K.cy) / K.fy)
  return r <= FISHEYE_MAX_PINHOLE_R ? p : { x: NaN, y: NaN }
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

// Pull the coefficients the sensor's lens model uses into a plain bag (or null when
// the model changes nothing) — the shape the worker/sfm marshalling forwards.
// Coefficients outside the active model are treated as zero (a model switch can't
// leave a stale term applied). No `distortionModel` ⇒ the five Brown terms (pre-model
// back-compat). A Brown bag has exactly k1,k2,k3,p1,p2; the rational model adds
// k4…k6; a fisheye bag is { fisheye: true, k1, k2, k3, k4 } and is never null.
export function distortionOf(sensor) {
  if (!sensor) return null
  const model = MODEL_BY_ID.get(sensor.distortionModel)
  const active = model?.coeffs ?? BROWN_COEFFS
  if (model?.family === 'fisheye') {
    const d = { fisheye: true, k1: 0, k2: 0, k3: 0, k4: 0 }
    for (const k of active) d[k] = sensor[k] || 0
    return d
  }
  const d = { k1: 0, k2: 0, k3: 0, p1: 0, p2: 0 }
  if (model?.id === 'rational') Object.assign(d, { k4: 0, k5: 0, k6: 0 })
  for (const k of active) d[k] = sensor[k] || 0
  return hasDistortion(d) ? d : null
}
