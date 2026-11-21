// Whether a solved model's focal length is weakly fixed by its geometry: the focal–height
// correlation of a flat nadir block held by survey-grade camera positions alone.
//
// Pointed straight down, a camera with a focal (1 + ε) longer, at a distance (1 + ε)
// greater from the ground, takes the same photo. With every camera at one height, the
// whole block can make that trade: the ground moves by ε·H (H the flying height above
// it) and no image residual changes. RTK or PPK positions fix the cameras, so the error
// lands on the ground's height. What breaks the trade is the cameras' height differences:
// with the ground fixed in the network, a focal error changes them by ε·Δh, which the
// positions can see. So the positions see the share Δh / H of what the focal does to the
// ground: the ratio this module measures, as the robust spread (NMAD) of the camera
// positions' heights over the flying height above the sparse cloud's median height.
// Obliques break the trade as well (the depth varies across their frames), and so does
// control: GCPs or a reference DEM fix the ground itself.
//
// Pure: plain data in, a plain record out (no log, no store).

import { NMAD_K } from '../constants.js'
import { cameraCenter } from './geometry.js'
import { fitSimilarity } from '../products/georef.js'
import { surveyGradePositions } from './cameraPriors.js'
import { SFM_TUNING } from '../tuning.js'

const median = (values) => {
  const v = Float64Array.from(values).sort()
  const n = v.length
  return n ? (n % 2 ? v[(n - 1) / 2] : 0.5 * (v[n / 2 - 1] + v[n / 2])) : NaN
}
const nmad = (values) => {
  const m = median(values)
  return NMAD_K * median(values.map((v) => Math.abs(v - m)))
}

// Enough tie points for a median of the ground: an even subsample keeps it cheap on a
// model of millions.
const MAX_GROUND_POINTS = 50000

/**
 * @param {object} input
 * @param {Array<{uuid:string, R:number[][], t:number[], sensorId?:string|null}>} input.cameras
 *   the solved cameras (SfM frame)
 * @param {ArrayLike<number>} input.points  tie point positions, flat x, y, z (SfM frame)
 * @param {object[]} input.cameraPriors  the camera positions the solve was held to (survey
 *   frame, Z up; cameraPriors.js buildCameraPriors)
 * @param {Iterable<string>} input.focalSensors  the camera groups (sensor ids) whose focal a
 *   solve held by the camera positions refined and kept
 * @param {boolean} input.control  GCPs or a reference DEM held the solve
 * @param {object} [opts]  thresholds (defaults from SFM_TUNING)
 * @returns {{ weak: boolean, reason: string, cameras: number, sensorIds: string[],
 *   flyingHeightM: number|null, spreadM: number|null, ratio: number|null,
 *   heightPer0_01PctM: number|null, obliqueShare: number|null, medianTiltDeg: number|null }}
 *   `reason`: 'weak' when it warns, else the first condition that keeps it quiet:
 *   'control', 'positions' (none survey grade), 'focal' (no group's focal refined under
 *   them), 'geometry' (too few placed cameras with positions), 'oblique', 'spread'.
 *   The numbers are filled whenever the positions and the model allow, whatever the reason.
 */
export function focalHeightCheck(
  { cameras = [], points = [], cameraPriors = [], focalSensors = [], control = false } = {},
  {
    maxSigma = SFM_TUNING.selfCalDecentringHeldSigma,
    minCameras = SFM_TUNING.cameraPriorBaMinCameras,
    maxRatio = SFM_TUNING.focalHeightMaxSpreadRatio,
    maxTiltDeg = SFM_TUNING.focalHeightNadirMaxTiltDeg,
    maxObliqueShare = SFM_TUNING.focalHeightMaxObliqueShare,
  } = {},
) {
  const camById = new Map(cameras.map((c) => [c.uuid, c]))
  const paired = (cameraPriors ?? []).filter((p) => camById.has(p.uuid) && [p.x, p.y, p.z].every(Number.isFinite))
  const focal = new Set(focalSensors ?? [])
  const sensorIds = [
    ...new Set(paired.map((p) => camById.get(p.uuid).sensorId).filter((s) => s != null && focal.has(s))),
  ]
  const out = {
    weak: false,
    reason: 'geometry',
    cameras: paired.length,
    sensorIds,
    flyingHeightM: null,
    spreadM: null,
    ratio: null,
    heightPer0_01PctM: null,
    obliqueShare: null,
    medianTiltDeg: null,
  }

  // The SfM → survey similarity of the solved cameras onto their positions: in the survey
  // frame Z is up, which the tilts and the ground's height need.
  const fit =
    paired.length >= Math.max(3, minCameras)
      ? fitSimilarity(paired.map((p) => ({ src: cameraCenter(camById.get(p.uuid)), dst: [p.x, p.y, p.z] })))
      : null
  if (fit) {
    const R2 = fit.R[2]
    // Tilt: the viewing direction (the camera's +z, Rᵀ·e3) against straight down.
    const tilts = paired.map((p) => {
      const { R } = camById.get(p.uuid)
      const d = [R[2][0], R[2][1], R[2][2]]
      const down = -(R2[0] * d[0] + R2[1] * d[1] + R2[2] * d[2])
      return (Math.acos(Math.max(-1, Math.min(1, down))) * 180) / Math.PI
    })
    const nPts = Math.floor((points?.length ?? 0) / 3)
    const step = Math.max(1, Math.ceil(nPts / MAX_GROUND_POINTS))
    const ground = []
    for (let i = 0; i < nPts; i += step) {
      const x = points[3 * i],
        y = points[3 * i + 1],
        z = points[3 * i + 2]
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))
        ground.push(fit.scale * (R2[0] * x + R2[1] * y + R2[2] * z) + fit.t[2])
    }
    const heights = paired.map((p) => p.z)
    // The priors' unit (a ftUS state plane keeps feet; cameraPriors.js unitsPerMetre).
    const perMetre = paired[0].unitsPerMetre ?? 1
    const flying = ground.length ? median(heights) - median(ground) : NaN
    const spread = nmad(heights)
    if (flying > 0) {
      out.flyingHeightM = flying / perMetre
      out.spreadM = spread / perMetre
      out.ratio = spread / flying
      out.heightPer0_01PctM = (flying / perMetre) * 1e-4
    }
    out.obliqueShare = tilts.filter((a) => a > maxTiltDeg).length / tilts.length
    out.medianTiltDeg = median(tilts)
  }

  const grade = surveyGradePositions(cameraPriors ?? [], maxSigma, minCameras)
  if (control) out.reason = 'control'
  else if (!grade.held) out.reason = 'positions'
  else if (!sensorIds.length) out.reason = 'focal'
  else if (out.ratio == null) out.reason = 'geometry'
  else if (out.obliqueShare > maxObliqueShare) out.reason = 'oblique'
  else if (out.ratio >= maxRatio) out.reason = 'spread'
  else {
    out.reason = 'weak'
    out.weak = true
  }
  return out
}

const cm = (m) => (100 * m).toLocaleString('en', { maximumFractionDigits: 1 })
const metres = (m) => m.toLocaleString('en', { maximumFractionDigits: m < 10 ? 1 : 0 })

/** The Sparse Model warning for a weak check (English, as the log stays); '' otherwise. */
export function focalHeightNote(check) {
  if (!check?.weak) return ''
  return (
    `Focal length weakly fixed: the survey-grade camera positions span ${metres(check.spreadM)} m in height ` +
    `(robust spread) against ${metres(check.flyingHeightM)} m of flying height ` +
    `(${(100 * check.ratio).toLocaleString('en', { maximumFractionDigits: 1 })} %), the photos look straight down ` +
    'and no GCPs control the solve, so the self-calibrated focal length and the heights trade against each other ' +
    `unseen: each 0.01 % of focal error moves the heights by ${cm(check.heightPer0_01PctM)} cm. For heights you can ` +
    'trust, use GCPs as control (Georeferencing) or a calibration from a block flown with control (Import ▸ ' +
    "Calibration, or Use for next run on the group's Estimated values in the Sensor table); keep some GCPs as " +
    'checkpoints to measure it'
  )
}
