// Canonical/pinhole pixel → the raw scan pixel a viewer actually draws on. Pure,
// no Vue/Pinia/OPFS/DOM.
//
// Everything the pipeline computes after ingest lives in a *pinhole* frame:
// distortion is folded out of the keypoints once (core/sfm/distortion.js), and a
// film sensor's scan geometry is folded out on top of that into a per-sensor
// canonical pixel frame (core/sfm/fiducials.js). Store keypoints, GCP marks and the
// displayed image all stay in the original scan frame, so anything that draws a
// *computed* pixel position over the image has to come back — otherwise it lands
// offset by the distortion (a calibrated lens) or by the whole scan→canonical
// affine (a film scan, where the offset can be enormous).
//
// The chain is exactly the one workers/ops/dense.js applies to build its sample
// map, and this module is where both get it from:
//   canonical px →(self-cal bag, then any calibrated bag)→ distorted canonical
//                →(canonicalToScan)→ scan px
// The two distortion bags compose in that order because the self-cal fold happened
// *after* ingest removed the calibrated one, so undoing them runs newest-first.

import { distortPixel, undistortPixel, hasDistortion, distortionOf } from './distortion.js'
import { canonicalToScan, scanToCanonical } from './fiducials.js'

// Apply both distortion bags: ideal pinhole pixel → the pixel the lens recorded.
// `Kw` must be the K the coefficients were fitted against (working-res if the
// caller scaled it). A no-op when both bags are empty.
export function distortComposed(u, v, Kw, dist, selfCal) {
  let x = u, y = v
  if (hasDistortion(selfCal)) { const p = distortPixel(x, y, Kw, selfCal); x = p.x; y = p.y }
  if (hasDistortion(dist))    { const p = distortPixel(x, y, Kw, dist);    x = p.x; y = p.y }
  return { x, y }
}

// Build the canonical→scan mapper for one image, or **null** when the image needs
// no correction at all (no distortion bags, not a film scan) — callers treat null
// as identity and skip the per-point work, which is the common case.
//   K        — the canonical/pinhole intrinsics the positions were computed in
//   dist     — calibrated Brown bag removed at ingest (or null)
//   selfCal  — composed self-calibration bag from summary.selfCalDistortion (or null)
//   fiducial — { A, frame } from summary.fiducialTransforms for this image (or null)
export function makeCanonicalToScan({ K, dist = null, selfCal = null, fiducial = null } = {}) {
  return makeSampleMap({ K, dist, selfCal, fiducial })
}

// The same chain, but between two *scaled* grids — the form a resampler needs.
// `outScale` is the resolution of the (u,v) grid relative to K's own frame,
// `srcScale` the resolution of the source raster relative to the scan frame; both
// default to 1, which recovers makeCanonicalToScan exactly.
//
// Scaling the grid rather than K is safe and is why only one primitive is needed:
// distortPixel normalizes by K, so distortComposed(u, v, scaleK(K, s)) is
// identically s·distortComposed(u/s, v/s, K) — the normalized coordinates are the
// same number either way.
//
// Returns **null** when the whole chain is the identity (no bags, no fiducial, both
// scales 1); callers treat null as "no work to do", which is the common
// EXIF-only digital case.
export function makeSampleMap({
  K, dist = null, selfCal = null, fiducial = null, outScale = 1, srcScale = 1,
} = {}) {
  const needsDist = !!K && (hasDistortion(dist) || hasDistortion(selfCal))
  const needsScale = outScale !== 1 || srcScale !== 1
  if (!needsDist && !fiducial && !needsScale) return null
  return (u, v) => {
    // Into K's own (full-resolution canonical) frame.
    let x = outScale === 1 ? u : u / outScale
    let y = outScale === 1 ? v : v / outScale
    if (needsDist) { const d = distortComposed(x, y, K, dist, selfCal); x = d.x; y = d.y }
    if (fiducial) { const s = canonicalToScan(x, y, fiducial.transform ?? fiducial.A, fiducial.frame); x = s.x; y = s.y }
    // Into the source raster's grid.
    if (srcScale !== 1) { x *= srcScale; y *= srcScale }
    return { x, y }
  }
}

// The reverse chain: a raw scan pixel (a GCP mark, anything the user clicked) →
// the pinhole/canonical pixel the reconstructed cameras project into. Exactly the
// steps ingest and the self-cal fold apply to keypoints, in order: scan→canonical
// (film), remove the calibrated bag, remove the composed self-cal bag. Triangulating
// raw marks against pinhole cameras instead is off by the whole lens distortion —
// and on a film scan by the entire scan→canonical affine. Null ⇒ identity.
export function makeScanToPinhole({ K, dist = null, selfCal = null, fiducial = null } = {}) {
  const undoDist = !!K && hasDistortion(dist), undoSelf = !!K && hasDistortion(selfCal)
  if (!undoDist && !undoSelf && !fiducial) return null
  return (px, py) => {
    let x = px, y = py
    if (fiducial) { const c = scanToCanonical(x, y, fiducial.transform ?? fiducial.A, fiducial.frame); x = c.x; y = c.y }
    if (undoDist) { const p = undistortPixel(x, y, K, dist); x = p.x; y = p.y }
    if (undoSelf) { const p = undistortPixel(x, y, K, selfCal); x = p.x; y = p.y }
    return { x, y }
  }
}

// ONE join from the persisted run record to each image's frame model — the
// calibrated bag of its sensor, the composed self-cal bag, the film transform.
// Dense, exports, the GCP tools and the image overlays all need it, and copies
// of this join had drifted (one normalised an all-zero self-cal bag, others
// passed it raw). Returns image → { dist, selfCal, fiducial, filmMissing }.
//   summary  — the sparse run summary ({ selfCalDistortion, fiducialTransforms })
//   sensors  — the sensor list (plain or reactive)
export function makeFrameModelResolver({ summary = null, sensors = [] } = {}) {
  const sensorById = new Map((sensors || []).map((s) => [s.id, s]))
  const selfCalBySensor = new Map((summary?.selfCalDistortion ?? []).map((d) => [d.sensorId, d]))
  const fidByUuid = new Map((summary?.fiducialTransforms ?? []).map((t) =>
    [t.uuid, { A: t.A ?? null, transform: t.transform ?? null, frame: t.frame }]))
  return (image) => {
    const sensor = image?.sensorId != null ? sensorById.get(image.sensorId) : null
    const sc = image?.sensorId != null ? selfCalBySensor.get(image.sensorId) : null
    const selfCal = sc && (sc.k1 || sc.k2 || sc.k3) ? { k1: sc.k1 || 0, k2: sc.k2 || 0, k3: sc.k3 || 0 } : null
    const fiducial = image?.uuid != null ? fidByUuid.get(image.uuid) ?? null : null
    return { dist: sensor ? distortionOf(sensor) : null, selfCal, fiducial,
      filmMissing: sensor?.kind === 'film' && !fiducial }
  }
}

// GCP / marker observations → the cameras' pinhole frame, for triangulation.
// `gcps` keep their identity fields; only observations whose image is registered
// and needs a correction are copied with mapped px/py (store state is never
// mutated — the marks themselves stay in scan pixels, where they were clicked).
//   imagesById    Map<imageId, image>       sparseCameras  Map<uuid, { K }>
//   frameModel    image → { dist, selfCal, fiducial } (makeFrameModelResolver)
export function gcpsInPinholeFrame(gcps, { imagesById, sparseCameras, frameModel }) {
  if (!frameModel) return gcps
  const maps = new Map()
  const mapperFor = (imageId) => {
    if (maps.has(imageId)) return maps.get(imageId)
    const im = imagesById.get(imageId), cam = im ? sparseCameras.get(im.uuid) : null
    const m = cam?.K ? makeScanToPinhole({ K: cam.K, ...frameModel(im) }) : null
    maps.set(imageId, m)
    return m
  }
  return (gcps || []).map((g) => {
    let changed = false
    const observations = (g.observations || []).map((o) => {
      const m = o.px != null && o.py != null ? mapperFor(o.imageId) : null
      if (!m) return o
      changed = true
      const p = m(o.px, o.py)
      return { ...o, px: p.x, py: p.y }
    })
    return changed ? { ...g, observations } : g
  })
}

// A guide computed in the pinhole frame → the scan pixels the viewer draws on.
// A point maps exactly. An epipolar line is a line only in the pinhole frame: it
// is re-fitted through two of its points either side of the principal point, mapped
// to the scan (exact for a film affine, a chord of the true curve under lens
// distortion — the same approximation the guide already documents).
export function guideToScan(guide, toScan, K) {
  if (!guide || !toScan) return guide
  if (guide.kind === 'point') { const p = toScan(guide.u, guide.v); return { ...guide, u: p.x, v: p.y } }
  if (guide.kind !== 'line' || !guide.line || !K) return guide
  const [a, b, c] = guide.line
  const off = a * K.cx + b * K.cy + c
  const fx = K.cx - off * a, fy = K.cy - off * b, D = Math.max(K.cx, K.cy, 1)
  const p = toScan(fx - D * b, fy + D * a), q = toScan(fx + D * b, fy - D * a)
  const la = q.y - p.y, lb = p.x - q.x, n = Math.hypot(la, lb)
  if (!(n > 1e-12)) return null
  return { ...guide, line: [la / n, lb / n, -(la * p.x + lb * p.y) / n] }
}
