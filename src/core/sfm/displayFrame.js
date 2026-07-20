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

import { distortPixel, hasDistortion } from './distortion.js'
import { canonicalToScan } from './fiducials.js'

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
  const needsDist = !!K && (hasDistortion(dist) || hasDistortion(selfCal))
  if (!needsDist && !fiducial) return null
  return (u, v) => {
    let x = u, y = v
    if (needsDist) { const d = distortComposed(x, y, K, dist, selfCal); x = d.x; y = d.y }
    if (fiducial) { const s = canonicalToScan(x, y, fiducial.transform ?? fiducial.A, fiducial.frame); x = s.x; y = s.y }
    return { x, y }
  }
}
