// Pull "estimated" (bundle-adjusted) camera parameters out of a reconstruction
// camera record: { R: [[3×3]], t: [3], K: { fx, fy, cx, cy } }.
//
// Intrinsics (K) are in pixels and meaningful regardless of georeferencing.
// The camera centre C = -Rᵀ·t is in the reconstruction's own model space — it is
// NOT in the project CRS unless the model has been georeferenced, so callers
// should label it accordingly.

import { opkFromMatrix } from '../footprint.js'
import { applySimilarity } from '../products/georef.js'
import { DISTORTION_COEFFS, isFisheyeModel } from './distortion.js'

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

// The calibration bundle adjustment ended with, as sensor records for the CSV export
// (utils/exportCsv.js buildSensorsCsv): per camera group the mean focal length and
// principal point of its registered cameras, or with `perImage` each camera's own, in
// pixels of the frame the cameras were solved in (a film scan's fiducial frame). The
// lens is the one the run corrected (displayFrame.js makeFrameModelResolver,
// `frameModel`): the group's own model, or a self-calibrated fisheye in its place, and
// any radial terms self-calibration fitted on top of it as selfcalK1…selfcalK3.
export function estimatedCalibration({ cameras, images, sensors = [], frameModel = null, perImage = false }) {
  const sensorById = new Map(sensors.map((s) => [s.id, s]))
  const groups = new Map()
  for (const img of images) {
    const K = estimatedIntrinsics(cameras?.get(img.uuid))
    if (!K) continue
    const key = perImage || img.sensorId == null ? `image:${img.uuid}` : img.sensorId
    if (!groups.has(key)) groups.set(key, { img, sensor: sensorById.get(img.sensorId) ?? null, Ks: [] })
    groups.get(key).Ks.push(K)
  }
  const mean = (Ks, k) => {
    const xs = Ks.map((K) => K[k]).filter((v) => v != null)
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
  }
  return [...groups.values()].map(({ img, sensor, Ks }) => {
    const fm = frameModel?.(img) ?? null
    const fisheye = fm?.dist?.fisheye && !isFisheyeModel(sensor?.distortionModel)
    const lens = fisheye
      ? { distortionModel: 'fisheye', ...Object.fromEntries(['k1', 'k2', 'k3', 'k4'].map((k) => [k, fm.dist[k]])) }
      : Object.fromEntries(['distortionModel', ...DISTORTION_COEFFS].map((k) => [k, sensor?.[k] ?? null]))
    return {
      ...(perImage ? { image: img.name } : {}),
      label: sensor?.label ?? img.name,
      width: sensor?.width ?? img.meta?.width ?? null,
      height: sensor?.height ?? img.meta?.height ?? null,
      focal: mean(Ks, 'focal'),
      focalY: mean(Ks, 'focalY'),
      focalUnit: 'px',
      cx: mean(Ks, 'cx'),
      cy: mean(Ks, 'cy'),
      ...lens,
      pixelSize: sensor?.pixelSize ?? null,
      source: 'estimated',
      cameras: Ks.length,
      selfcalK1: fm?.selfCal?.k1 ?? null,
      selfcalK2: fm?.selfCal?.k2 ?? null,
      selfcalK3: fm?.selfCal?.k3 ?? null,
    }
  })
}
