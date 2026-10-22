// What each step of Sparse Reconstruction does to this project (ReconstructModal.vue):
// the one-line effects under its numbered steps.
import { plural } from './format.js'

const TERMS = {
  'f': 'the focal length',
  'f,cxcy': 'the focal length and principal point',
  'f,k1': 'the focal length and radial k1',
  'f,cxcy,k1,k2,k3': 'the focal length, principal point and radial k1–k3',
  'f,cxcy,k1,k2,k3,k4': 'the focal length, principal point and k1–k4 on a fisheye lens (k1–k3 on any other)',
}

// project: { linkedImages (images in a usable matched pair), pairs (usable pairs),
// sensors, autoReason (why `auto` self-calibrates as it does here, or null) }
export function sparseEffects(s, { linkedImages = 0, pairs = 0, sensors = 0, autoReason = null } = {}) {
  const register = !pairs
    ? 'Match features first: images join the model through their matched pairs.'
    : `${plural(linkedImages, 'image')} linked by ${plural(pairs, 'matched pair')} can join the model. An image ` +
      `is added once at least ${s.minMatchesForRegistration} of its tie points see points already in it, and ` +
      `RANSAC finds its pose from them to within ${s.reprjThreshold} px at the detection resolution.`

  const ba =
    s.baIterations > 0
      ? `Cameras and points are refined together, up to ${plural(s.baIterations, 'iteration')} each time the ` +
        'model is adjusted.'
      : 'Off: poses and points are never refined together, and self-calibration does not run.'

  const per = sensors ? ` (${plural(sensors, 'sensor')})` : ''
  const v = s.refineIntrinsics
  const calibration = !(s.baIterations > 0)
    ? 'Not used: it runs inside bundle adjustment, which is off.'
    : v === 'none'
      ? `Off: the sensor table's calibration is used as it is${per}.`
      : v === 'auto'
        ? autoReason
          ? `This project${per}: ${autoReason}`
          : `Staged as the model grows${per}, unless a sensor already has a calibrated model.`
        : `Solved for each sensor${per}: ${TERMS[v] ?? v}.`
  return { register, ba, calibration }
}
