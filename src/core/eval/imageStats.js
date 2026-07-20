// Pure per-image residual statistics for Evaluate ▸ Image Errors
// (PLAN-eval-views step 3). Cameras + points in, one row per registered camera out
// — uuids in, uuids out (name joins happen in the modal, keeping core pure).

import { projectPoint } from '../sfm/geometry.js'

// One entry per camera in `cameras`, including registered cameras with zero
// surviving observations (nObs 0, rms/median/max null — do not drop them, "this
// image registered but has no tracks" is itself a signal). For each observation
// (`point.viewsPx`) of a camera, projects the point and measures the pixel residual.
// Sorting the result by rmsPx desc names the cameras poisoning the reconstruction —
// the whole point of the view.
export function perImageResiduals(cameras, points) {
  const acc = new Map()   // uuid → number[]
  for (const uuid of cameras.keys()) acc.set(uuid, [])

  for (const p of points || []) {
    if (!p.viewsPx || !p.viewsPx.size) continue
    for (const [uuid, px] of p.viewsPx) {
      const cam = cameras.get(uuid)
      if (!cam) continue                       // observation of an image not in this model
      const proj = projectPoint(cam, p.x, p.y, p.z)
      if (!proj) continue
      acc.get(uuid).push(Math.hypot(proj.u - px[0], proj.v - px[1]))
    }
  }

  const out = []
  for (const [uuid, res] of acc) {
    const nObs = res.length
    if (!nObs) { out.push({ uuid, nObs: 0, rmsPx: null, medianPx: null, maxPx: null }); continue }
    res.sort((a, b) => a - b)
    const rms = Math.sqrt(res.reduce((a, b) => a + b * b, 0) / nObs)
    out.push({ uuid, nObs, rmsPx: rms, medianPx: res[nObs >> 1], maxPx: res[nObs - 1] })
  }
  return out
}

// Why an image failed to register — the first derivable reason from the cheap facts
// we already have (WS2). Ordered most-fundamental first: no features can't match, no
// accepted pairs can't triangulate, a disconnected image can't join the main block.
// `facts`: { kpCount, degree, componentIndex } (componentIndex 0 = largest component,
// null when the image has no component). Returns a short label, or null if none of
// these explains it (registration deferred/failed for a subtler reason).
export function unregisteredReason({ kpCount, degree, componentIndex } = {}) {
  if (kpCount != null && kpCount === 0) return 'no features'
  if (degree != null && degree === 0) return 'no accepted pairs'
  if (componentIndex != null && componentIndex > 0) return `disconnected (component ${componentIndex + 1})`
  return null
}

// Per-observation reprojection residual vectors for one image (WS3 residual overlay).
// For every point observed in `uuid`, returns the observation pixel and the vector
// from the projected 3D point TO the observation (du,dv = obs − projection). A radial
// pattern = distortion misfit, a coherent translation = bad pose, random speckle =
// fine. Empty when the camera is absent.
//
// Both endpoints are computed in the **BA pinhole frame** (distortion folded out; for
// a film sensor, the canonical fiducial frame), which is NOT the frame the viewer
// displays. Pass `toScan` — `core/sfm/displayFrame.js` `makeCanonicalToScan` for this
// image — to map the drawn positions back onto the raw image; without it a calibrated
// lens draws its arrows off by the distortion and a film scan by the whole
// scan→canonical affine. `mag` deliberately stays the pinhole-frame length: it is the
// reprojection error every other view reports, and re-measuring it in scan pixels
// would make the overlay disagree with the tables.
export function imageResidualVectors(cam, points, uuid, toScan = null) {
  if (!cam) return []
  const out = []
  for (const p of points || []) {
    const px = p.viewsPx?.get?.(uuid)
    if (!px) continue
    const proj = projectPoint(cam, p.x, p.y, p.z)
    if (!proj) continue
    const du = px[0] - proj.u
    const dv = px[1] - proj.v
    const mag = Math.hypot(du, dv)
    if (!toScan) {
      out.push({ px: px[0], py: px[1], du, dv, mag })
      continue
    }
    // Map both endpoints, then re-derive the vector: the transform is not a pure
    // translation, so mapping the tail and reusing (du,dv) would skew the arrow.
    const a = toScan(px[0], px[1])
    const b = toScan(proj.u, proj.v)
    out.push({ px: a.x, py: a.y, du: a.x - b.x, dv: a.y - b.y, mag })
  }
  return out
}
