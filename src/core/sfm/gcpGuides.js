// Guided GCP marking — predict where a GCP should land in an image the user is
// about to mark on, using the poses of the current sparse cloud. Pure, no
// Vue/Pinia/OPFS/DOM.
//
// Once the cameras are posed, a GCP already marked elsewhere is no longer free
// in a new image:
//   • 1 other observation  → the mark must lie on that observation's *epipolar
//     line* in this image (a 1-D constraint) — returned as `{ kind:'line' }`.
//   • ≥2 other observations → the GCP triangulates to a 3D point, which
//     reprojects to a single predicted pixel — returned as `{ kind:'point' }`.
// The viewer draws these as aiming guides (see ViewerImage.vue), the same idea
// as the fiducial ghost guides.
//
// A guide is drawn and NEVER applied — do not add snap-to-guide. A guide is
// derived from the reconstruction, so snapping a mark onto one would feed the
// model's own estimate back in as ground truth. GCPs must stay *independent*
// evidence that can correct the reconstruction; a snapped mark could only ever
// confirm it, and would silently erase the disagreement exactly when the
// reconstruction is wrong — i.e. when the user needs it most. The user places
// the mark; the guide only says where the model expects it.
//
// Frame caveat: like `gcpTriangulation.js` / `gcpAccuracyReport`, this works in
// the raw observation pixel frame against the pinhole model — no calibrated or
// self-cal-composed distortion is re-applied, and film scans are not mapped
// through `canonicalToScan`. Guides are therefore consistent with the
// reprojection errors shown next to each marker, but on a strongly distorted
// lens the true epipolar "line" is a slight curve and the guide is an
// approximation. See METHODS.md.

import { triangulateGcp } from './gcpTriangulation.js'
import { cameraCenter, projectWithDepth } from './geometry.js'

// ── Small 3×3 helpers (row-major, matching the R convention) ──────────────────

function transpose3(M) {
  return [
    [M[0][0], M[1][0], M[2][0]],
    [M[0][1], M[1][1], M[2][1]],
    [M[0][2], M[1][2], M[2][2]],
  ]
}

function mul3(A, B) {
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      C[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j]
  return C
}

function apply3(M, v) {
  return [
    M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2],
    M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2],
    M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2],
  ]
}

// Cross-product matrix [t]ₓ, so [t]ₓ·v ≡ t × v.
function skew3(t) {
  return [
    [0, -t[2], t[1]],
    [t[2], 0, -t[0]],
    [-t[1], t[0], 0],
  ]
}

// K⁻¹ for K = [[fx,0,cx],[0,fy,cy],[0,0,1]].
function invK({ fx, fy, cx, cy }) {
  return [
    [1 / fx, 0, -cx / fx],
    [0, 1 / fy, -cy / fy],
    [0, 0, 1],
  ]
}

// ── Fundamental matrix ────────────────────────────────────────────────────────

// F for the ordered pair (A → B): the epipolar line of a pixel xA in image B is
// F·xA, and corresponding pixels satisfy xBᵀ·F·xA = 0.
//
// Both poses are world→camera (websfm/OpenCV convention), so the relative pose
// A→B is R_rel = R_B·R_Aᵀ, t_rel = t_B − R_rel·t_A. Then E = [t_rel]ₓ·R_rel and
// F = K_B⁻ᵀ·E·K_A⁻¹. Returns null for a degenerate (≈ zero-baseline) pair,
// where no epipolar constraint exists.
export function fundamentalFromCams(camA, camB) {
  const Rrel = mul3(camB.R, transpose3(camA.R))
  const RtA = apply3(Rrel, camA.t)
  const trel = [camB.t[0] - RtA[0], camB.t[1] - RtA[1], camB.t[2] - RtA[2]]
  if (!(Math.hypot(trel[0], trel[1], trel[2]) > 1e-9)) return null
  const E = mul3(skew3(trel), Rrel)
  const F = mul3(mul3(transpose3(invK(camB.K)), E), invK(camA.K))
  return F.every((row) => row.every(Number.isFinite)) ? F : null
}

// Epipolar line of pixel (px, py) under F, as normalised coefficients
// [a, b, c] with a·u + b·v + c = 0 and a² + b² = 1 (so |a·u+b·v+c| is a true
// pixel distance). Null when the line degenerates to a point (a = b = 0).
export function epipolarLine(F, px, py) {
  if (!F) return null
  const l = apply3(F, [px, py, 1])
  const n = Math.hypot(l[0], l[1])
  if (!(n > 1e-12) || !Number.isFinite(n)) return null
  return [l[0] / n, l[1] / n, l[2] / n]
}

// ── Line geometry (for drawing) ───────────────────────────────────────────────

// Clip a line to the rect [0,w]×[0,h]. Returns [{x,y},{x,y}] (the two border
// crossings) or null when the line misses the image entirely.
export function clipLineToRect(line, w, h) {
  if (!line) return null
  const [a, b, c] = line
  const eps = 1e-9
  const pts = []
  const push = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    if (x < -1e-6 || x > w + 1e-6 || y < -1e-6 || y > h + 1e-6) return
    // A line through a corner produces the same crossing from two edges.
    if (pts.some((p) => Math.abs(p.x - x) < 1e-6 && Math.abs(p.y - y) < 1e-6)) return
    pts.push({ x, y })
  }
  if (Math.abs(b) > eps) { push(0, -c / b); push(w, -(a * w + c) / b) }
  if (Math.abs(a) > eps) { push(-c / a, 0); push(-(b * h + c) / a, h) }
  return pts.length >= 2 ? [pts[0], pts[1]] : null
}

// ── Guides ────────────────────────────────────────────────────────────────────

// Euclidean camera-centre distance — the parallax proxy used to pick the most
// informative source view (same rationale as gcpTriangulation's pair choice).
function baseline(camA, camB) {
  const Ca = cameraCenter(camA), Cb = cameraCenter(camB)
  return Math.hypot(Ca[0] - Cb[0], Ca[1] - Cb[1], Ca[2] - Cb[2])
}

// Guide for one GCP in one target image.
//   observations:     the GCP's [{ imageId, px, py }] (the target's own mark, if
//                     any, is ignored — a guide is always an *independent*
//                     prediction from the other views)
//   targetImageId:    image the guide is drawn in
//   targetCam:        that image's { R, t, K } (null ⇒ unregistered ⇒ no guide)
//   camerasByImageId: Map<imageId, { R, t, K }> for *registered* images only
// Returns { kind:'point', u, v, viewCount } | { kind:'line', line, viewCount } | null.
export async function gcpGuideForImage(observations, targetImageId, targetCam, camerasByImageId) {
  if (!targetCam) return null
  const views = (observations || []).filter(
    (o) => o.imageId !== targetImageId && o.px != null && o.py != null && camerasByImageId.get(o.imageId)
  )
  if (!views.length) return null

  // ≥2 views → triangulate and reproject to a single predicted pixel.
  if (views.length >= 2) {
    const tri = await triangulateGcp(views, camerasByImageId)
    if (tri && Number.isFinite(tri.x)) {
      // projectWithDepth enforces cheirality: a point behind the target camera
      // would still project to a (meaningless) pixel via projectPoint.
      const p = projectWithDepth(targetCam, tri.x, tri.y, tri.z)
      if (p) return { kind: 'point', u: p.u, v: p.v, viewCount: views.length }
    }
    // Fall through: a failed or behind-camera triangulation still leaves the
    // (weaker but valid) epipolar constraint from a single view.
  }

  // 1 view — or a triangulation we couldn't use — → epipolar line. Pick the
  // widest-baseline source: the most stable line, and the least foreshortened.
  let src = null, best = -1
  for (const v of views) {
    const d = baseline(camerasByImageId.get(v.imageId), targetCam)
    if (d > best) { best = d; src = v }
  }
  const F = fundamentalFromCams(camerasByImageId.get(src.imageId), targetCam)
  const line = epipolarLine(F, src.px, src.py)
  return line ? { kind: 'line', line, viewCount: views.length } : null
}

// Guides for every enabled GCP not yet marked on the target image (an already
// marked GCP needs no aiming help — its marker and reprojection error are
// already drawn).
//   gcps:            [{ id, name, enabled, observations }] (useGcpsStore shape)
//   sparseCameras:   Map<imageUuid, { R, t, K }>
//   imagesById:      Map<imageId, { uuid }>
// Returns [{ gcpId, name, kind, u, v, line, viewCount }].
export async function gcpGuidesForImage(gcps, targetImageId, sparseCameras, imagesById) {
  const targetUuid = imagesById.get(targetImageId)?.uuid
  const targetCam = targetUuid != null ? sparseCameras.get(targetUuid) : null
  if (!targetCam) return [] // unregistered image — nothing constrains the mark

  const out = []
  for (const gcp of gcps || []) {
    if (gcp.enabled === false) continue
    const obs = gcp.observations || []
    if (obs.some((o) => o.imageId === targetImageId && o.px != null && o.py != null)) continue

    const camerasByImageId = new Map()
    for (const o of obs) {
      const uuid = imagesById.get(o.imageId)?.uuid
      const cam = uuid != null ? sparseCameras.get(uuid) : null
      if (cam) camerasByImageId.set(o.imageId, cam)
    }
    const guide = await gcpGuideForImage(obs, targetImageId, targetCam, camerasByImageId)
    if (guide) out.push({ gcpId: gcp.id, name: gcp.name, ...guide })
  }
  return out
}
