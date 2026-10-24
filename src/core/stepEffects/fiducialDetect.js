// What each step of Detect Fiducials does (FiducialDetectModal.vue): search the
// expected slots around the film frame, match the template, then store the marks
// (core/film/ via useImagesStore.detectFiducialsForSensor).
import { plural } from './format.js'

const WHERE = {
  'corners': 'the four corners',
  'sides': 'the four edge midpoints',
  'corners+sides': 'the corners and edge midpoints',
}
const POLARITY = {
  auto: 'dark and light marks are both tried',
  dark: 'marks darker than the film',
  light: 'marks lighter than the film',
}

// project: { images (searched) }
export function fiducialDetectEffects(s, { images = 0 } = {}) {
  const search = !images
    ? 'No images are assigned to this film sensor.'
    : `${plural(images, 'image')} are searched at ${WHERE[s.positions] ?? WHERE.corners} of the film frame; ` +
      `at ${Math.round(s.tolerance * 100)} % tolerance, the higher the more weak candidates go to review instead of being dropped.`
  const match =
    s.family === 'frame'
      ? 'Not used: the Frame type measures the film corner, not a mark.'
      : `Polarity: ${POLARITY[s.polarity] ?? POLARITY.auto}.`
  const store =
    `${s.overwrite ? 'Existing detections are replaced' : 'Existing accepted detections are kept'}` +
    `${s.generateMasks ? '; a background mask outside the film frame is added' : ''}.`
  return { search, match, store }
}
