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
// timedImages (images with a capture time), rigs (multispectral rigs: [{ label, bands,
// captures, reference }]), sensors, autoReason (why `auto` self-calibrates as it does here, or null),
// splits (the camera groups that may hold photos of more than one camera:
// [{ label, groups }], from core/sensors/splitSuggestions.js) }
// `splits` is the warning above the steps, '' when there is none.
// With `s.addToModel` (Add to the model), project also has { modelCameras, newImages,
// hasProducts }, and the effects describe adding the new images to the model.
export function sparseEffects(
  s,
  {
    linkedImages = 0,
    pairs = 0,
    timedImages = 0,
    rigs = [],
    sensors = 0,
    autoReason = null,
    modelCameras = 0,
    newImages = 0,
    splits = [],
  } = {},
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
      rollingShutter: 'Off while adding images: the new cameras are solved as a global shutter.',
      cameraRig: 'Off while adding images: every new photo gets a pose of its own.',
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
  const rollingShutter =
    s.rollingShutter !== 'on'
      ? 'Off: every row of a photo is taken as read at the same instant, right for a mechanical or global shutter.'
      : !(s.baIterations > 0)
        ? 'Not used: the readout time is estimated inside bundle adjustment, which is off.'
        : timedImages < 3
          ? `Nothing to estimate: ${timedImages ? `only ${plural(timedImages, 'image')} has` : 'no image has'} a capture time, which the cameras' motion is taken from.`
          : `${plural(timedImages, 'image')} with a capture time: each camera's motion is taken from the photos ` +
            'taken just before and after it, and each camera group gets a readout time.'
  const rig = rigs[0]
  const cameraRig = !rig
    ? 'No multispectral camera among the photos: every photo gets a pose of its own.'
    : s.cameraRig === 'off'
      ? `Off: each of the ${rig.bands} band photos of a ${rig.label} capture gets a pose of its own.`
      : `${plural(rig.captures, `${rig.label} capture`)}: the ${rig.bands} band photos of a capture share one ` +
        `pose, each band at its lens offset to ${rig.reference || 'the reference band'}, refined from the photos; ` +
        "a band that matches nothing (thermal) takes its capture's pose." +
        (rigs.length > 1 ? ` (and ${plural(rigs.length - 1, 'other camera')})` : '')
  return { register, ba, calibration, rollingShutter, cameraRig, splits: splitWarning(splits) }
}

// The steps' short facts for the dialog's step chain (≤ SHORT_MAX characters).
export function sparseShorts(s, { linkedImages = 0, pairs = 0, timedImages = 0, rigs = [], newImages = 0 } = {}) {
  const ba = s.baIterations > 0
  if (s.addToModel)
    return {
      register: `${plural(newImages, 'new image')}`,
      ba: ba ? 'new cameras only' : 'off',
      calibration: "the model's",
      rollingShutter: 'off',
      cameraRig: 'off',
    }
  const v = s.refineIntrinsics
  return {
    register: !pairs ? 'match first' : `${plural(linkedImages, 'image')} · ${s.reprjThreshold} px`,
    ba: ba ? `≤ ${plural(s.baIterations, 'iteration')}` : 'off',
    calibration: !ba ? 'not used' : v === 'none' ? 'off' : v === 'auto' ? 'auto' : v.replace(/,/g, ', '),
    rollingShutter: s.rollingShutter !== 'on' ? 'off' : timedImages < 3 ? 'no capture times' : 'readout estimated',
    cameraRig: !rigs.length ? 'no rig' : s.cameraRig === 'off' ? 'off' : `${plural(rigs[0].captures, 'capture')}`,
  }
}

// A camera group with photos of more than one camera gets one calibration for all of
// them, whatever self-calibration does.
function splitWarning(splits) {
  if (!splits.length) return ''
  const [first, ...rest] = splits
  const which = rest.length
    ? `${first.label} and ${plural(rest.length, 'other camera group')} may each hold photos of more than one camera`
    : `${first.label} may hold photos of ${first.groups} cameras`
  return `${which}, which would share one calibration: split ${rest.length ? 'them' : 'it'} in Sensors first (right-click ▸ Split camera group…).`
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
