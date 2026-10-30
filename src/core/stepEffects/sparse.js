// What each step of Sparse Reconstruction does to this project (ReconstructModal.vue):
// the one-line effects under its numbered steps.
import { plural } from './format.js'
import { resolveExistingCameras } from '../sfm/extendModel.js'

const TERMS = {
  'f': 'the focal length',
  'f,cxcy': 'the focal length and principal point',
  'f,k1': 'the focal length and radial k1',
  'f,cxcy,k1,k2,k3': 'the focal length, principal point and radial k1–k3',
  'f,cxcy,k1,k2,k3,k4': 'the focal length, principal point and k1–k4 on a fisheye lens (k1–k3 on any other)',
}

// project: { linkedImages (images in a usable matched pair), pairs (usable pairs),
// sensors, autoReason (why `auto` self-calibrates as it does here, or null) }
// With `s.addToModel` (Add to the model), project also has { modelCameras, newImages,
// hasProducts }, and the effects describe adding the new images to the model.
export function sparseEffects(
  s,
  { linkedImages = 0, pairs = 0, sensors = 0, autoReason = null, modelCameras = 0, newImages = 0 } = {},
) {
  if (s.addToModel) {
    return {
      register:
        `${plural(newImages, 'new image')} can join the model's ${plural(modelCameras, 'camera')}. An image is ` +
        `added once at least ${s.minMatchesForRegistration} of its tie points see points already in it, and ` +
        `RANSAC finds its pose from them to within ${s.reprjThreshold} px at the detection resolution.`,
      ba:
        s.baIterations > 0
          ? `The new cameras and the points they see are refined, up to ${plural(s.baIterations, 'iteration')} ` +
            "each time; the model's cameras hold them in place."
          : 'Off: the new cameras keep the poses registration found.',
      calibration: "Off while adding images: every camera keeps the model's calibration.",
    }
  }
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

// The mode line above the steps: what Add to the model or Rebuild does to this project.
//   project: { modelCameras, newImages, hasProducts, blocker (extensionBlocker, or null) }
export function sparseModeEffect(s, { modelCameras = 0, newImages = 0, hasProducts = false, blocker = null } = {}) {
  if (!s.addToModel)
    return modelCameras
      ? `A new model from every image replaces the one with ${plural(modelCameras, 'camera')}` +
          (hasProducts ? '; what was built from it is kept, marked outdated.' : '.')
      : ''
  if (blocker) return `Cannot add: ${blocker}.`
  const mode = resolveExistingCameras(s.existingCameras, { hasProducts })
  const auto = s.existingCameras === 'auto'
  return mode === 'fixed'
    ? `${plural(newImages, 'new image')} join the model; its ${plural(modelCameras, 'camera')} stay where they are` +
        (hasProducts ? ', so depth maps, clouds and rasters built from them stay current' : '') +
        (auto ? ' (Auto: something was built from them).' : '.')
    : `${plural(newImages, 'new image')} join the model, then Optimize cameras refines every camera with them` +
        (hasProducts ? '; depth maps and the georeference are retired, and what was built is marked outdated' : '') +
        (auto ? ' (Auto: nothing was built from the model yet).' : '.')
}
