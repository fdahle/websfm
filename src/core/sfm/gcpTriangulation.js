// Triangulate GCP (ground control point) image observations into the current
// SfM frame, so they can be compared against their surveyed CRS position (the
// georeferencing fit + accuracy report) and, optionally, anchored into bundle
// adjustment. Pure, no Vue/Pinia/OPFS/DOM.
//
// A GCP's observations are `{ imageId, px, py, accuracyX, accuracyY }` pixel marks on one or more
// *registered* images (images with a camera pose in the current sparse
// cloud). Two-view DLT triangulation (reusing the same WASM path as SfM point
// triangulation) on the widest-baseline pair seeds the 3D position, which is
// then refined against *every* observation by Gauss-Newton on the summed
// reprojection error (`refineGcpPoint` below — pure JS: a handful of points,
// not millions, so this needs no new WASM routine). Pixel axes are weighted by
// their declared inverse variances.
//
// The refinement is what makes a 3rd..Nth mark worth placing: the DLT pair
// alone ignores them, so marking a GCP in eight images used to predict exactly
// what the best two predicted. Marks retain their declared measurement weights,
// with one exception: `opts.robust` (see ROBUST_* below), which
// drops marks that disagree wildly with the consensus. That is opt-in because
// it changes *which* evidence reaches the caller: the guide path wants it (a
// misclick shouldn't poison the aiming prediction for every other image), while
// the georeference fit / accuracy report must keep reporting on every mark the
// user actually placed — silently discarding a GCP observation from the fit
// would hide exactly the disagreement the report exists to surface.

import { triangulateDlt, makeP34flat } from './reconstruction.js'
import { cameraCenter, projectPoint } from './geometry.js'

// Gauss-Newton refinement (defaults co-located with the algorithm, per CLAUDE.md).
const GN_MAX_ITERS = 10
// Converged once the step moves the point by less than this *relative* to its
// distance from the seed camera — the SfM frame has arbitrary scale, so an
// absolute world-unit epsilon would be meaningless.
const GN_STEP_EPS_REL = 1e-9
// Levenberg-style damping on the 3×3 normal equations, keeping them invertible
// for a near-degenerate (tiny-parallax) view set where the ray directions are
// almost parallel and the point slides freely along depth.
const GN_DAMPING = 1e-9

// Robust rejection (opt-in), in two stages — the order matters:
//
//  1. An IRLS fit under a Huber loss, which *resists* the outlier instead of
//     averaging it in.
//  2. Only then, a median cut on that fit's residuals.
//
// Stage 1 cannot be skipped. Plain least-squares drags the point toward a bad
// mark until the bad mark no longer looks bad: for a 4-view GCP with one ~108px
// misclick, the LSQ fit smears it into residuals of 42/11/50/27 px — median 34,
// so a 3× cut of 103 clears the outlier's own 50 and rejects nothing. Under the
// Huber fit the bad mark is downweighted, the point lands on the consensus of
// the good marks, and the residuals separate (≈0 vs ≈108) so the cut fires.
// Never reorder these or drop the Huber stage back to plain LSQ.
const ROBUST_MEDIAN_FACTOR = 3
// Absolute floor on the cut, load-bearing in the other direction: on a clean set
// the median residual is ~0, and a pure multiple of it would reject honest marks
// over sub-pixel noise.
const ROBUST_FLOOR_PX = 25
// Never robustify below this many views: with 2 the fit is exact (nothing to
// disagree with), and rejection must always leave a triangulable pair.
const ROBUST_MIN_VIEWS = 3
// Huber transition (px) for stage 1. Residuals under this are weighted as plain
// least-squares, beyond it the loss grows linearly, so a wild mark pulls with
// bounded force rather than in proportion to how wrong it is. Deliberately
// absolute rather than scaled off the residuals: it marks "a mark this far off
// is no longer just noise", which is a property of GCP marking, not of the fit.
const HUBER_DELTA_PX = 2
// How many of the widest-baseline pairs to try as a DLT seed on the robust path
// (see triangulateGcp). Small: it exists to survive one poisoned pair, and each
// candidate costs a DLT plus a Huber fit.
const SEED_PAIR_CANDIDATES = 3

// Euclidean distance between two cameras' centres — a parallax proxy usable
// before the 3D point is known (the DLT pair is chosen by this, not by the
// true triangulation angle).
function baseline(camA, camB) {
  const Ca = cameraCenter(camA), Cb = cameraCenter(camB)
  return Math.hypot(Ca[0] - Cb[0], Ca[1] - Cb[1], Ca[2] - Cb[2])
}

// Solve the 3×3 system M·x = b by Gaussian elimination with partial pivoting.
// Returns null when M is singular to working precision.
function solve3(M, b) {
  const A = [[M[0][0], M[0][1], M[0][2], b[0]],
             [M[1][0], M[1][1], M[1][2], b[1]],
             [M[2][0], M[2][1], M[2][2], b[2]]]
  for (let c = 0; c < 3; c++) {
    let piv = c
    for (let r = c + 1; r < 3; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r
    if (!(Math.abs(A[piv][c]) > 1e-15)) return null
    if (piv !== c) { const tmp = A[piv]; A[piv] = A[c]; A[c] = tmp }
    for (let r = c + 1; r < 3; r++) {
      const f = A[r][c] / A[c][c]
      for (let k = c; k < 4; k++) A[r][k] -= f * A[c][k]
    }
  }
  const x = [0, 0, 0]
  for (let r = 2; r >= 0; r--) {
    let s = A[r][3]
    for (let k = r + 1; k < 3; k++) s -= A[r][k] * x[k]
    x[r] = s / A[r][r]
  }
  return x.every(Number.isFinite) ? x : null
}

// Cost of point (x,y,z) over `views`: plain summed-squared reprojection error,
// or the Huber-loss version when `huberPx` is set. A view the point cannot project
// into (projectPoint null ⇒ the point landed on that camera's plane) contributes
// nothing — it can't steer the fit, and dropping the whole cost would make an
// otherwise-good step look infinitely bad.
//
// Returns `{ cost, valid }` rather than a bare number, because a cost summed over
// a *different* set of views is not comparable: a step that pushes the point onto
// some camera's plane silently removes that view's error from the total and would
// look like an improvement. Callers must check `valid` before trusting `cost`.
function reprojCost(views, x, y, z, huberPx = null) {
  let s = 0
  const valid = []
  for (const v of views) {
    const p = projectPoint(v.cam, x, y, z)
    if (!p) { valid.push(false); continue }
    valid.push(true)
    const ru = p.u - v.px, rv = p.v - v.py
    const wx = 1 / ((Number.isFinite(v.accuracyX) && v.accuracyX > 0 ? v.accuracyX : 1) ** 2)
    const wy = 1 / ((Number.isFinite(v.accuracyY) && v.accuracyY > 0 ? v.accuracyY : 1) ** 2)
    const weightedSq = wx * ru * ru + wy * rv * rv
    if (huberPx == null) { s += weightedSq; continue }
    const r = Math.hypot(ru, rv)
    const robustWeight = r <= huberPx ? 1 : huberPx / r
    s += robustWeight * weightedSq
  }
  return { cost: s, valid }
}

// Refine a seed 3D point against every view by Gauss-Newton on reprojection
// error. `views` is [{ px, py, cam:{R,t,K} }]; `seed` is { x, y, z }.
//
// For x_cam = R·X + t and u = fx·xc/zc + cx, the Jacobian rows w.r.t. X are
//   ∂u/∂X = (fx/zc)·(R[0] − (xc/zc)·R[2])
//   ∂v/∂X = (fy/zc)·(R[1] − (yc/zc)·R[2])
// Only the point moves — camera poses are fixed input here, not free
// parameters (that's bundle adjustment's job, `runGcpAnchoredBundleAdjust`).
//
// `opts.huberPx` switches the objective from least-squares to a Huber loss,
// minimised by IRLS (per-view weight w = min(1, δ/|r|), recomputed each
// iteration). Used by the robust path to get an outlier-resistant fit *before*
// deciding which views are outliers — see the ROBUST_* note above.
//
// Never returns worse than the seed: a diverging or non-improving step stops
// the iteration and the best-so-far estimate is returned.
export function refineGcpPoint(views, seed, opts = {}) {
  const { huberPx = null } = opts
  let [x, y, z] = [seed.x, seed.y, seed.z]
  if (![x, y, z].every(Number.isFinite) || views.length < 2) return { x, y, z }

  let { cost, valid } = reprojCost(views, x, y, z, huberPx)
  // Scale reference for the relative step test (see GN_STEP_EPS_REL).
  const C0 = cameraCenter(views[0].cam)
  const scale = Math.max(Math.hypot(x - C0[0], y - C0[1], z - C0[2]), 1e-12)

  for (let iter = 0; iter < GN_MAX_ITERS; iter++) {
    const H = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
    const g = [0, 0, 0]
    let used = 0

    for (const v of views) {
      const { R, t, K } = v.cam
      const xc = R[0][0] * x + R[0][1] * y + R[0][2] * z + t[0]
      const yc = R[1][0] * x + R[1][1] * y + R[1][2] * z + t[1]
      const zc = R[2][0] * x + R[2][1] * y + R[2][2] * z + t[2]
      if (!Number.isFinite(zc) || Math.abs(zc) < 1e-9) continue
      used++

      const ru = K.fx * (xc / zc) + K.cx - v.px
      const rv = K.fy * (yc / zc) + K.cy - v.py
      // IRLS: beyond δ the weight decays as δ/|r|, so the view's pull on the
      // normal equations saturates instead of growing with its error.
      let robustWeight = 1
      if (huberPx != null) {
        const rn = Math.hypot(ru, rv)
        if (rn > huberPx) robustWeight = huberPx / rn
      }
      const wx = robustWeight / ((Number.isFinite(v.accuracyX) && v.accuracyX > 0 ? v.accuracyX : 1) ** 2)
      const wy = robustWeight / ((Number.isFinite(v.accuracyY) && v.accuracyY > 0 ? v.accuracyY : 1) ** 2)
      const ju = [
        (K.fx / zc) * (R[0][0] - (xc / zc) * R[2][0]),
        (K.fx / zc) * (R[0][1] - (xc / zc) * R[2][1]),
        (K.fx / zc) * (R[0][2] - (xc / zc) * R[2][2]),
      ]
      const jv = [
        (K.fy / zc) * (R[1][0] - (yc / zc) * R[2][0]),
        (K.fy / zc) * (R[1][1] - (yc / zc) * R[2][1]),
        (K.fy / zc) * (R[1][2] - (yc / zc) * R[2][2]),
      ]
      for (let i = 0; i < 3; i++) {
        g[i] += wx * ju[i] * ru + wy * jv[i] * rv
        for (let j = 0; j < 3; j++) H[i][j] += wx * ju[i] * ju[j] + wy * jv[i] * jv[j]
      }
    }
    if (used < 2) break

    for (let i = 0; i < 3; i++) H[i][i] += GN_DAMPING * (H[i][i] || 1)
    const step = solve3(H, [-g[0], -g[1], -g[2]])
    if (!step) break

    const nx = x + step[0], ny = y + step[1], nz = z + step[2]
    if (![nx, ny, nz].every(Number.isFinite)) break
    const cand = reprojCost(views, nx, ny, nz, huberPx)
    // Refuse a step that costs us a view: its error would vanish from the sum and
    // make a geometrically worse point look cheaper. (A step that *gains* a view is
    // allowed — the extra term only makes the improvement test stricter.)
    if (valid.some((wasValid, i) => wasValid && !cand.valid[i])) break
    if (!(cand.cost < cost)) break // not an improvement — keep the current estimate
    x = nx; y = ny; z = nz; cost = cand.cost; valid = cand.valid

    if (Math.hypot(step[0], step[1], step[2]) / scale < GN_STEP_EPS_REL) break
  }
  return { x, y, z }
}

function perViewResiduals(views, x, y, z) {
  return views.map((v) => {
    const proj = projectPoint(v.cam, x, y, z)
    if (!proj) return { imageId: v.imageId, reprojPx: null, normalized: null }
    const dx = proj.u - v.px, dy = proj.v - v.py
    const sx = Number.isFinite(v.accuracyX) && v.accuracyX > 0 ? v.accuracyX : 1
    const sy = Number.isFinite(v.accuracyY) && v.accuracyY > 0 ? v.accuracyY : 1
    return { imageId: v.imageId, dx, dy, reprojPx: Math.hypot(dx, dy), normalized: Math.hypot(dx/sx, dy/sy) }
  })
}

function median(nums) {
  const s = nums.slice().sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// Triangulate one GCP's observations.
//   observations: [{ imageId, px, py }]
//   camerasByImageId: Map<imageId, { R, t, K }> — only *registered* images
//   opts.robust: drop views that disagree with the consensus and re-fit without
//     them (opt-in — see the header note on why the fit/report path must not).
// Returns { x, y, z, viewCount, perViewReprojPx: [{ imageId, reprojPx }],
// rejectedImageIds } or null when fewer than 2 observations resolve to a
// registered camera. `viewCount` and `perViewReprojPx` always cover *every*
// resolved view, including any rejected one — a rejected mark still gets its
// residual reported, it just didn't steer the point.
export async function triangulateGcp(observations, camerasByImageId, opts = {}) {
  const { robust = false } = opts
  const views = (observations || [])
    .map((o) => ({ ...o, cam: camerasByImageId.get(o.imageId) }))
    .filter((v) => v.cam && v.px != null && v.py != null)
  if (views.length < 2) return null

  // Widest-baseline pairs seed the DLT — the best-conditioned two-view solves
  // available before the 3D point is known.
  const pairs = []
  for (let i = 0; i < views.length; i++) {
    for (let j = i + 1; j < views.length; j++) {
      pairs.push({ a: views[i], b: views[j], d: baseline(views[i].cam, views[j].cam) })
    }
  }
  pairs.sort((p, q) => q.d - p.d)

  const normalize = (v) => ({ x: (v.px - v.cam.K.cx) / v.cam.K.fx, y: (v.py - v.cam.K.cy) / v.cam.K.fy })
  const dltSeed = async ({ a, b }) => {
    const PA = makeP34flat(a.cam.R, a.cam.t)
    const PB = makeP34flat(b.cam.R, b.cam.t)
    const tri = await triangulateDlt([normalize(a)], [normalize(b)], PA, PB)
    return tri.length ? tri[0] : null
  }

  const useRobust = robust && views.length >= ROBUST_MIN_VIEWS

  let seed = null
  if (!useRobust) {
    seed = await dltSeed(pairs[0])
  } else {
    // The widest baseline is the best-conditioned pair, but if one of *its* two
    // marks is the misclick the seed is poisoned — and the Huber fit below only
    // resists outliers, it does not escape a basin it was started in. So try the
    // few widest pairs and keep whichever seed the Huber objective likes best; a
    // pair containing the bad mark scores worse than one that doesn't.
    let best = Infinity
    for (const pair of pairs.slice(0, SEED_PAIR_CANDIDATES)) {
      const s = await dltSeed(pair)
      if (!s) continue
      const fit = refineGcpPoint(views, s, { huberPx: HUBER_DELTA_PX })
      const { cost } = reprojCost(views, fit.x, fit.y, fit.z, HUBER_DELTA_PX)
      if (cost < best) { best = cost; seed = s }
    }
  }
  if (!seed) return null

  const rejectedImageIds = []
  let keep = views

  if (useRobust) {
    // Stage 1 — an outlier-resistant fit to judge the marks against. Judging
    // them against a plain LSQ fit does not work; see the ROBUST_* note.
    const h = refineGcpPoint(views, seed, { huberPx: HUBER_DELTA_PX })
    const res = perViewResiduals(views, h.x, h.y, h.z)
    const finite = res.filter((r) => r.reprojPx != null).map((r) => r.reprojPx)
    if (finite.length >= ROBUST_MIN_VIEWS) {
      // Stage 2 — now the residuals are honest, cut on them.
      const cut = Math.max(ROBUST_MEDIAN_FACTOR * median(finite), ROBUST_FLOOR_PX)
      const kept = views.filter((v, i) => res[i].reprojPx != null && res[i].reprojPx <= cut)
      // Only reject when it leaves a still-triangulable set; otherwise the marks
      // disagree too broadly to call any one of them the outlier.
      if (kept.length >= 2 && kept.length < views.length) {
        for (const v of views) if (!kept.includes(v)) rejectedImageIds.push(v.imageId)
        keep = kept
      }
    }
  }

  // Final fit is plain least-squares over the surviving marks — the Huber stage
  // exists only to *identify* outliers, and once they're gone the efficient
  // unbiased estimate is the one we want.
  const { x, y, z } = refineGcpPoint(keep, seed)

  return { x, y, z, viewCount: views.length, perViewReprojPx: perViewResiduals(views, x, y, z), rejectedImageIds }
}

// Triangulate every enabled GCP against the current sparse cloud.
//   gcps: [{ id, enabled, observations }] (useGcpsStore shape)
//   sparseCameras: Map<imageUuid, { R, t, K }>
//   imagesById: Map<imageId, { uuid }> (or anything with a `.uuid` field)
// Returns [{ gcp, tri }] — `tri` is null when not triangulable (surfaced in
// the UI as "insufficient views").
export async function triangulateAllGcps(gcps, sparseCameras, imagesById) {
  const out = []
  for (const gcp of gcps) {
    if (gcp.enabled === false) { out.push({ gcp, tri: null }); continue }
    const camerasByImageId = new Map()
    for (const o of gcp.observations || []) {
      const uuid = imagesById.get(o.imageId)?.uuid
      const cam = uuid != null ? sparseCameras.get(uuid) : null
      if (cam) camerasByImageId.set(o.imageId, cam)
    }
    const tri = await triangulateGcp(gcp.observations, camerasByImageId)
    out.push({ gcp, tri })
  }
  return out
}
