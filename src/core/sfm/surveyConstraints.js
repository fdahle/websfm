// Survey constraints for bundle adjustment — camera-position/orientation priors
// and GCP anchors — built from a model and the external evidence. Pure: the
// incremental pipeline (bundleSession.js) and the gradual-selection refinement
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
import { fitSimilarity, frameFromSimilarity, stripRollOpen, viewAxisPairs } from '../products/georef.js'
import { opkMatrix } from '../footprint.js'
import { precisionFromGcp, precisionInSfmFrame } from '../gcpAccuracy.js'
import { isGroundControl } from '../io/gcp.js'
import { median } from '../stats.js'
import { SFM_TUNING } from '../tuning.js'

const centreTarget = (antenna, arm) => (arm ? antenna.map((v, i) => v - arm[i]) : antenna)

// Rᵀ·diag(w)·R: per-axis inverse variances in the survey frame as a precision matrix in
// the SfM frame, R the SfM → survey rotation of the fit.
export function surveyToSfmPrecision(w, R) {
  return [0, 1, 2].map((i) =>
    [0, 1, 2].map((j) => R[0][i] * w[0] * R[0][j] + R[1][i] * w[1] * R[1][j] + R[2][i] * w[2] * R[2][j]),
  )
}

// A prior without accuracies gets 5 m, in its own unit (buildCameraPriors unitsPerMetre).
const priorSigma = (p) =>
  [p.accuracyX, p.accuracyY, p.accuracyZ].map((v) => (Number.isFinite(v) && v > 0 ? v : 5 * (p.unitsPerMetre ?? 1)))

// The GNSS lever arm of a prior (metres, camera axes) in the SfM frame: Rᵀ·a / s, the
// arm converted to the priors' unit and s the SfM → survey scale of the fit.
function leverArmInSfm(cam, p, scale) {
  if (!p.leverArm || !(scale > 0)) return null
  const { R } = cam
  const a = p.leverArm.map((v) => v * (p.unitsPerMetre ?? 1))
  return [0, 1, 2].map((i) => (R[0][i] * a[0] + R[1][i] * a[1] + R[2][i] * a[2]) / scale)
}

// The point of a camera a prior measures, in the SfM frame: its centre, or its antenna.
function antennaInSfm(cam, p, scale) {
  const C = cameraCenter(cam)
  const arm = leverArmInSfm(cam, p, scale)
  return arm ? [C[0] + arm[0], C[1] + arm[1], C[2] + arm[2]] : C
}

const datumOf = (d) => d ?? 'unknown'

// Whether the positions' heights may hold the joint solve with the GCPs (priorHeightRule).
// A datum offset and a focal error both move every camera height alike over a nadir
// block, so an unknown datum is judged by size: an offset larger than the positions'
// noise (`sigmas` σ Z) and than a plausible focal error (`heightFrac` of the height above
// the GCPs) is taken for a datum offset. Geoid undulations run to tens of metres.
// Heights that disagree are moved onto the GCPs' (buildCameraPriorConstraints).
//   control  { datums, groundZ } of the GCPs (buildGcpAnchors); usable  the priors;
//   camZ     each prior's camera (or antenna) height in the GCPs' survey frame
function priorHeights(control, usable, camZ, { sigmas, heightFrac }) {
  const rule = priorHeightRule(
    control.datums ?? [],
    usable.map((p) => p.verticalDatum),
  )
  const offset = median(usable.map((p, i) => p.z - camZ[i]))
  const sigmaZ = median(usable.map((p) => priorSigma(p)[2]))
  const height = Number.isFinite(control.groundZ) ? median(camZ) - control.groundZ : NaN
  const limit = Math.max(sigmas * sigmaZ, Number.isFinite(height) ? heightFrac * Math.abs(height) : 0)
  const held = rule === 'hold' || (rule === 'test' && !(Math.abs(offset) > limit))
  return {
    rule,
    held,
    offset,
    sigmaZ,
    height,
    limit,
    n: usable.length,
    perMetre: usable[0]?.unitsPerMetre ?? 1,
    datums: { gcps: control.datums ?? [], priors: [...new Set(usable.map((p) => datumOf(p.verticalDatum)))] },
  }
}

/**
 * How camera heights may enter a solve held to GCPs. The two agree only in one vertical
 * datum: an RTK block's ellipsoidal heights and GCPs in a national height system differ
 * by the geoid undulation (tens of metres), and with both at centimetre σ the solve
 * settles the conflict through the focal–height trade-off of a nadir block (focal error
 * ≈ offset / flying height, relief scaled with it), with every residual small.
 *   gcpDatums, priorDatums  the vertical datums of the control GCPs and the positions
 * → 'hold'  one known datum: the positions hold all three axes as they are;
 *   'plan'  known to differ (the store converts what converts): their heights are moved
 *           onto the GCPs' by the offset between the two;
 *   'test'  a datum is unknown: moved likewise when the offset is too large to be noise
 *           or a focal error (buildCameraPriorConstraints).
 */
export function priorHeightRule(gcpDatums, priorDatums) {
  const g = new Set(gcpDatums.map(datumOf)),
    p = new Set(priorDatums.map(datumOf))
  if (g.has('unknown') || p.has('unknown')) return 'test'
  return g.size === 1 && p.size === 1 && [...g][0] === [...p][0] ? 'hold' : 'plan'
}

/**
 * Camera-centre (and, when imported, orientation) priors as BA constraints.
 *   cameras      Map<uuid, { R, t }>
 *   cameraPriors [{ uuid, x, y, z, accuracy*, omega/phi/kappa, verticalDatum… }] (survey frame)
 *   uuidList     the BA's camera order
 *   minCameras   fewest usable priors that may define the frame on their own
 *   reference    { fit, frame, control } to reuse (the joint GCP pass) instead of fitting;
 *                `control` (buildGcpAnchors) { datums, groundZ } decides the heights
 *   heightTest   { sigmas, heightFrac }: how far apart (in the positions' σ Z, and as a
 *                share of the height above the GCPs) heights of unknown datum may sit
 * Returns { fit, priors, heights } or null. `heights` (joint pass only):
 *   { rule, held, offset, sigmaZ, height, n }: offset the median of position − camera
 *   height in the GCPs' frame; held false when the heights are moved by it.
 */
export function buildCameraPriorConstraints({
  cameras,
  cameraPriors,
  uuidList,
  minCameras = 3,
  reference = null,
  heightTest = {
    sigmas: SFM_TUNING.priorHeightOffsetSigmas,
    heightFrac: SFM_TUNING.priorHeightOffsetHeightFrac,
  },
}) {
  const camIdxOf = new Map(uuidList.map((uuid, i) => [uuid, i]))
  const usable = (cameraPriors || []).filter(
    (p) => camIdxOf.has(p.uuid) && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z),
  )
  if (usable.length < (reference ? 1 : minCameras)) return null
  // A prior with a `leverArm` (metres, camera frame) is the GNSS ANTENNA position,
  // which sits at C + Rᵀ·a, not at the camera centre C. Holding C to it pulls every
  // centre onto its antenna (GeoScan: a constant 0.41 m horizontal residual). In the
  // SfM frame the offset is Rᵀ·a / s, s = the SfM→survey scale of the fit, so the fit
  // pairs antenna points and the BA target moves back by the same offset. R is the
  // pose when the constraint is built; the prior BA rebuilds it every round, and a 1°
  // rotation change moves a 0.4 m arm by 7 mm.
  const armInSfm = (p, scale) => leverArmInSfm(cameras.get(p.uuid), p, scale)
  const pairsAt = (scale) =>
    usable.map((p) => ({
      src: antennaInSfm(cameras.get(p.uuid), p, scale),
      dst: [p.x, p.y, p.z],
      weight: 3 / priorSigma(p).reduce((sum, v) => sum + v * v, 0),
    }))
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
  // Centres along one line leave the roll about it open (georef.js stripRollOpen). It
  // moves no centre, but the orientation priors are built in this frame: where every
  // prior carries omega/phi/kappa, its viewing direction fixes the roll.
  if (!reference && stripRollOpen(fit) && usable.every((p) => [p.omega, p.phi, p.kappa].every(Number.isFinite))) {
    const axes = usable.map((p) => {
      const M = opkMatrix(p.omega, p.phi, p.kappa)
      const pair = pairsAt(fit.scale)[usable.indexOf(p)]
      return {
        src: pair.src,
        srcAxis: cameras.get(p.uuid).R[2],
        dst: pair.dst,
        dstAxis: [-M[0][2], -M[1][2], -M[2][2]],
      }
    })
    fit = fitSimilarity([...pairsAt(fit.scale), ...viewAxisPairs(axes)]) ?? fit
  }
  const frame = reference?.frame ?? frameFromSimilarity(fit, 'camera-prior')
  const heights = reference?.control
    ? priorHeights(
        reference.control,
        usable,
        pairsAt(fit.scale).map((pair) => frame.fromSfm(pair.src)[2]),
        heightTest,
      )
    : null
  const priors = usable.map((p) => {
    // sigma_sfm = sigma_project / scale, hence inverse variance scales by s². The σ are
    // per SURVEY axis (E, N, Up): `weights` keeps them so (the DEM hold reads the
    // vertical one), and the solver gets them turned into SfM axes,
    // P = s²·Rᵀ·diag(1/σ²)·R with dst = s·R·src + t, so an RTK block's loose height
    // stays vertical whatever pair seeded the model. Heights the GCPs' disagree with are
    // moved onto them by the offset measured between the two: the GCPs set the heights,
    // and the positions' height differences still hold the block. (Giving them no weight
    // instead lost those: quarry checkpoints V 5.2 cm against 3.3 shifted, 2.9 in one datum.)
    const weights = priorSigma(p).map((v) => (fit.scale * fit.scale) / (v * v))
    const z = heights && !heights.held ? p.z - heights.offset : p.z
    return {
      camIdx: camIdxOf.get(p.uuid),
      target: centreTarget(frame.toSfm([p.x, p.y, z]), armInSfm(p, fit.scale)),
      weights,
      positionPrecision: surveyToSfmPrecision(weights, fit.R),
      ...(orientationPriorInSfm(p, fit.R) ?? {}),
    }
  })
  return { fit, priors, ...(heights ? { heights } : {}) }
}

/**
 * The mean height of the camera positions against their cameras (or antennas) after a
 * joint solve, in the survey frame of the GCP fit `frame`: an offset too small for the
 * test before the solve (priorHeights) shows here, as a mean several σ Z from zero.
 * Returns { offset, sigmaZ, n } or null.
 */
export function priorHeightResidual({ cameras, cameraPriors, uuidList, frame }) {
  const inBlock = new Set(uuidList)
  const dz = [],
    sz = []
  for (const p of cameraPriors || []) {
    const cam = cameras.get(p.uuid)
    if (!inBlock.has(p.uuid) || !cam || !Number.isFinite(p.z)) continue
    const z = frame.fromSfm(antennaInSfm(cam, p, frame.scale))[2]
    if (!Number.isFinite(z)) continue
    dz.push(p.z - z)
    sz.push(priorSigma(p)[2])
  }
  if (!dz.length) return null
  return { offset: dz.reduce((s, v) => s + v, 0) / dz.length, sigmaZ: median(sz), n: dz.length }
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
 * Returns { fit, frame, anchorPts, anchors, observations, control } or { error };
 * `control` { datums, groundZ }: the GCPs' vertical datums and median height, which
 * decide whether camera heights may join them (buildCameraPriorConstraints).
 */
export async function buildGcpAnchors({ cameras, qualifying, camIdxOf, firstPointIndex }) {
  const tri = []
  for (const g of qualifying) {
    // A mark with no pinhole image (a fisheye ray past 90°) comes out of ingest as NaN.
    const obsWithCam = (g.observations || []).filter(
      (o) => cameras.has(o.uuid) && Number.isFinite(o.px) && Number.isFinite(o.py),
    )
    const t = await triangulateGcp(
      obsWithCam.map((o) => ({ imageId: o.uuid, px: o.px, py: o.py, accuracyX: o.accuracyX, accuracyY: o.accuracyY })),
      cameras,
    )
    tri.push({ g, tri: t, obsWithCam })
  }
  const pairs = tri
    .filter((r) => r.tri)
    .map((r) => ({
      src: [r.tri.x, r.tri.y, r.tri.z],
      dst: [r.g.x, r.g.y, r.g.z],
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
  const anchorPts = [],
    anchors = [],
    observations = []
  for (const { g, tri: t, obsWithCam } of tri) {
    if (!t) continue
    const precision = precisionInSfmFrame(g, fit)
    if (!precision) continue
    const ptIdx = firstPointIndex + anchorPts.length
    anchorPts.push({ x: t.x, y: t.y, z: t.z })
    anchors.push({ ptIdx, target: frame.toSfm([g.x, g.y, g.z]), precision })
    for (const o of obsWithCam) {
      const camIdx = camIdxOf.get(o.uuid)
      if (camIdx != null)
        observations.push({
          camIdx,
          ptIdx,
          x: o.px,
          y: o.py,
          weightX: 1 / (o.accuracyX ?? 1) ** 2,
          weightY: 1 / (o.accuracyY ?? 1) ** 2,
        })
    }
  }
  if (!anchors.length) return { error: 'no GCP had a usable precision' }
  const control = {
    datums: [...new Set(qualifying.map((g) => datumOf(g.verticalDatum)))],
    groundZ: median(pairs.map((p) => p.dst[2])),
  }
  return { fit, frame, anchorPts, anchors, observations, control }
}
