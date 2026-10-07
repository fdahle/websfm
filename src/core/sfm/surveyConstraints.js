// Survey constraints for bundle adjustment — camera-position/orientation priors
// and GCP anchors — built from a model and the external evidence. Pure: the
// incremental pipeline (sfm.js) and the gradual-selection refinement
// (gradualSelection.js) both build their constraints here, so a refinement BA can
// never quietly drop what the original solve was held to (a GCP doming correction
// undone by an unconstrained re-solve was the bug that motivated the split).
//
// Coordinates: GCP x/y/z and prior positions must already be in ONE Cartesian
// survey frame (cameraPriors.js surveyFrameFor — a projected CRS with its scale
// factor divided out and curvature restored), and GCP image marks in the cameras'
// pinhole frame. Both callers guarantee that before calling in.

import { cameraCenter } from './geometry.js'
import { triangulateGcp } from './gcpTriangulation.js'
import { orientationPriorInSfm } from './cameraPriors.js'
import { fitSimilarity, frameFromSimilarity } from '../products/georef.js'
import { precisionFromGcp, precisionInSfmFrame } from '../gcpAccuracy.js'
import { isGroundControl } from '../io/gcp.js'

const centreTarget = (antenna, arm) => (arm ? antenna.map((v, i) => v - arm[i]) : antenna)

const priorSigma = (p) => [p.accuracyX, p.accuracyY, p.accuracyZ].map((v) => (Number.isFinite(v) && v > 0 ? v : 5))

/**
 * Camera-centre (and, when imported, orientation) priors as BA constraints.
 *   cameras      Map<uuid, { R, t }>
 *   cameraPriors [{ uuid, x, y, z, accuracy*, omega/phi/kappa… }] (survey frame)
 *   uuidList     the BA's camera order
 *   minCameras   fewest usable priors that may define the frame on their own
 *   reference    { fit, frame } to reuse (the joint GCP pass) instead of fitting
 * Returns { fit, priors } or null.
 */
export function buildCameraPriorConstraints({ cameras, cameraPriors, uuidList, minCameras = 3, reference = null }) {
  const camIdxOf = new Map(uuidList.map((uuid, i) => [uuid, i]))
  const usable = (cameraPriors || []).filter((p) => camIdxOf.has(p.uuid)
    && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z))
  if (usable.length < (reference ? 1 : minCameras)) return null
  // A prior with a `leverArm` (metres, camera frame) is the GNSS ANTENNA position,
  // which sits at C + Rᵀ·a, not at the camera centre C. Holding C to it pulls every
  // centre onto its antenna (GeoScan: a constant 0.41 m horizontal residual). In the
  // SfM frame the offset is Rᵀ·a / s, s = the SfM→survey scale of the fit, so the fit
  // pairs antenna points and the BA target moves back by the same offset. R is the
  // pose when the constraint is built; the prior BA rebuilds it every round, and a 1°
  // rotation change moves a 0.4 m arm by 7 mm.
  const armInSfm = (p, scale) => {
    if (!p.leverArm || !(scale > 0)) return null
    const { R } = cameras.get(p.uuid)
    const a = p.leverArm
    return [0, 1, 2].map((i) => (R[0][i] * a[0] + R[1][i] * a[1] + R[2][i] * a[2]) / scale)
  }
  const pairsAt = (scale) => usable.map((p) => {
    const C = cameraCenter(cameras.get(p.uuid))
    const arm = armInSfm(p, scale)
    return {
      src: arm ? [C[0] + arm[0], C[1] + arm[1], C[2] + arm[2]] : C, dst: [p.x, p.y, p.z],
      weight: 3 / priorSigma(p).reduce((sum, v) => sum + v * v, 0),
    }
  })
  let fit = reference?.fit ?? null
  if (!fit) {
    // The offset needs the scale and the scale comes from the fit: fit the centres
    // first, then refit the antenna points at the latest scale. Converges in two or
    // three refits (each shrinks the scale error by about arm / block size).
    fit = fitSimilarity(pairsAt(0))
    if (fit && usable.some((p) => p.leverArm)) {
      for (let it = 0; it < 4; it++) {
        const next = fitSimilarity(pairsAt(fit.scale))
        if (!next) break
        const converged = Math.abs(next.scale - fit.scale) <= 1e-9 * fit.scale
        fit = next
        if (converged) break
      }
    }
  }
  if (!fit) return null
  const frame = reference?.frame ?? frameFromSimilarity(fit, 'camera-prior')
  const priors = usable.map((p) => ({
    camIdx: camIdxOf.get(p.uuid), target: centreTarget(frame.toSfm([p.x, p.y, p.z]), armInSfm(p, fit.scale)),
    // sigma_sfm = sigma_project / scale, hence inverse variance scales by s².
    weights: priorSigma(p).map((v) => fit.scale * fit.scale / (v * v)),
    ...(orientationPriorInSfm(p, fit.R) ?? {}),
  }))
  return { fit, priors }
}

/** Enabled ground control with ≥2 marks on registered cameras (marks keyed by `uuid`). */
export function qualifyingGcps(gcps, cameras) {
  return (gcps || []).filter((g) => {
    // One spelling of the ground-control rule (core/io/gcp.js): a marker — image
    // marks, no surveyed position — never anchors, whatever coordinates it carries.
    if (!isGroundControl(g, { precision: precisionFromGcp })) return false
    return (g.observations || []).filter((o) => cameras.has(o.uuid)).length >= 2
  })
}

/**
 * GCP anchors for one anchored-BA pass: triangulate each qualifying GCP from its
 * marks, Horn/GLS-fit the SfM→survey similarity, and express every surveyed
 * position (and its full precision) in the SfM frame.
 *   cameras          Map<uuid, { R, t, K }>
 *   qualifying       from qualifyingGcps
 *   camIdxOf         Map<uuid, camIdx> of the BA's camera order
 *   firstPointIndex  where the synthetic anchor points start (after the real ones)
 * Returns { fit, frame, anchorPts, anchors, observations } or { error }.
 */
export async function buildGcpAnchors({ cameras, qualifying, camIdxOf, firstPointIndex }) {
  const tri = []
  for (const g of qualifying) {
    const obsWithCam = (g.observations || []).filter((o) => cameras.has(o.uuid))
    const t = await triangulateGcp(
      obsWithCam.map((o) => ({ imageId: o.uuid, px: o.px, py: o.py, accuracyX: o.accuracyX, accuracyY: o.accuracyY })),
      cameras,
    )
    tri.push({ g, tri: t, obsWithCam })
  }
  const pairs = tri.filter((r) => r.tri).map((r) => ({
    src: [r.tri.x, r.tri.y, r.tri.z], dst: [r.g.x, r.g.y, r.g.z],
    weight: 3 / (r.g.accuracyX ** 2 + r.g.accuracyY ** 2 + r.g.accuracyZ ** 2),
    precision: precisionFromGcp(r.g),
  }))
  if (pairs.length < 3) return { error: 'fewer than 3 GCPs triangulated' }
  const fit = fitSimilarity(pairs)
  if (!fit) return { error: 'similarity fit failed — degenerate configuration' }
  const frame = frameFromSimilarity(fit, 'gcp')

  // Anchor points are extra 3D points (their own index range, after the real ones)
  // with ordinary reprojection observations of their marks PLUS the one anchor
  // residual pulling them toward the GCP-implied SfM-frame position.
  const anchorPts = [], anchors = [], observations = []
  for (const { g, tri: t, obsWithCam } of tri) {
    if (!t) continue
    const precision = precisionInSfmFrame(g, fit)
    if (!precision) continue
    const ptIdx = firstPointIndex + anchorPts.length
    anchorPts.push({ x: t.x, y: t.y, z: t.z })
    anchors.push({ ptIdx, target: frame.toSfm([g.x, g.y, g.z]), precision })
    for (const o of obsWithCam) {
      const camIdx = camIdxOf.get(o.uuid)
      if (camIdx != null) observations.push({ camIdx, ptIdx, x: o.px, y: o.py,
        weightX: 1 / ((o.accuracyX ?? 1) ** 2), weightY: 1 / ((o.accuracyY ?? 1) ** 2) })
    }
  }
  if (!anchors.length) return { error: 'no GCP had a usable precision' }
  return { fit, frame, anchorPts, anchors, observations }
}
