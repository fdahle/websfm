// Pull "estimated" (bundle-adjusted) camera parameters out of a reconstruction
// camera record: { R: [[3×3]], t: [3], K: { fx, fy, cx, cy } }.
//
// Intrinsics (K) are in pixels and meaningful regardless of georeferencing.
// The camera centre C = -Rᵀ·t is in the reconstruction's own model space — it is
// NOT in the project CRS unless the model has been georeferenced, so callers
// should label it accordingly.

import { opkFromMatrix } from '../footprint.js'
import { applySimilarity } from '../products/georef.js'

export function estimatedIntrinsics(cam) {
  if (!cam?.K) return null
  const { fx, fy, cx, cy } = cam.K
  return {
    focal: fx ?? null,
    focalY: fy ?? null,
    cx: cx ?? null,
    cy: cy ?? null,
  }
}

// Camera centre in model space: C = -Rᵀ·t
export function estimatedCenter(cam) {
  if (!cam?.R || !cam?.t) return null
  const R = cam.R,
    t = cam.t
  const x = -(R[0][0] * t[0] + R[1][0] * t[1] + R[2][0] * t[2])
  const y = -(R[0][1] * t[0] + R[1][1] * t[1] + R[2][1] * t[2])
  const z = -(R[0][2] * t[0] + R[1][2] * t[1] + R[2][2] * t[2])
  return [x, y, z]
}

// A camera's pose as a pose import reads it back (core/io/pose.js, cameraPriors.js):
// the centre and omega/phi/kappa (degrees, footprint.js opkMatrix) in the frame the
// similarity `sim` maps the model into ({ scale, R, t, local? }, as
// products/exportFrame.js gives it), or in the model frame when `sim` is null.
// The solver's camera looks along +z with y down; a photogrammetric one along −z with
// y up, hence the flip D = diag(1, −1, −1) of cameraPriors.js orientationPriorInSfm.
// Angles are null at phi = ±90°.
export function estimatedPose(cam, sim = null) {
  const C = estimatedCenter(cam)
  if (!C) return null
  const [x, y, z] = sim ? applySimilarity(sim, C) : C
  // Export frame → camera: R·simRᵀ.
  const R = sim ? cam.R.map((row) => sim.R.map((s) => row[0] * s[0] + row[1] * s[1] + row[2] * s[2])) : cam.R
  const opk = opkFromMatrix([R[0], R[1].map((v) => -v), R[2].map((v) => -v)])
  return { x, y, z, omega: opk?.omega ?? null, phi: opk?.phi ?? null, kappa: opk?.kappa ?? null }
}
