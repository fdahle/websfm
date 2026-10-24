// What each step of Classify Ground does (ClassifyGroundModal.vue): drop a cloth onto
// the upside-down cloud, then label the points by their distance to it
// (core/products/groundFilter.js).
import { fmtLength } from './format.js'

const TERRAIN = { 1: 'soft for steep slopes', 2: 'medium for rolling relief', 3: 'stiff for flat ground' }

export function classifyGroundEffects(s, { noScale = false } = {}) {
  if (noScale) {
    const why = 'Needs real-world scale: georeference the model or add scale bars first.'
    return { cloth: why, label: why }
  }
  const cloth =
    `A cloth of ${fmtLength(s.clothResolution, 'm')} cells, ${TERRAIN[s.rigidness] ?? TERRAIN[2]}, settles onto the cloud seen from below` +
    `${s.slopeSmoothing ? '; slope smoothing spreads it onto continuous steep ground' : ''}.`
  const label =
    `Points within ${fmtLength(s.classThreshold, 'm')} of the cloth are ground, the rest above ground` +
    `${s.extent === 'core' ? '; outside the dense core points stay unclassified' : ', over the whole cloud'}.`
  return { cloth, label }
}
