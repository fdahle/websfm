// What each step of Classify Points does (ClassifyGroundModal.vue): drop a cloth onto
// the upside-down cloud, label the points by their distance to it
// (core/products/groundFilter.js), then find buildings and vegetation among the points
// above it (core/products/pointClasses.js).
import { fmtLength, fmtCount } from './format.js'
import { GROUND_FILTER_LIMITS } from '../products/groundFilter.js'
import { CLASSIFY_DEFAULTS } from '../defaults.user.js'

const TERRAIN = { 1: 'soft for steep slopes', 2: 'medium for rolling relief', 3: 'stiff for flat ground' }

// The cloth's size over the cloud: a cloud in memory gets one cloth, coarsened past the
// particle cap as groundFilter.js classifyGround does; a streamed one is cut into tiles
// (core/lod/transform.js planTiledEdit), each coarsening its own cloth past the cap.
function clothSize(res, [w, h], streamed) {
  const cells = (w / res + 1) * (h / res + 1)
  const over = `Over the cloud's ${fmtLength(w, 'm')} × ${fmtLength(h, 'm')}`
  const cap = GROUND_FILTER_LIMITS.maxParticles
  if (streamed || cells <= cap)
    return (
      ` ${over}: about ${fmtCount(Math.round(cells))} cloth cells` +
      (streamed && cells > cap ? `, in tiles; a tile that needs more than ${fmtCount(cap)} uses a coarser cloth.` : '.')
    )
  let used = Math.sqrt(((w + res) * (h + res)) / cap) * 1.01
  while ((w / used + 1) * (h / used + 1) > cap) used *= 1.05
  return ` ${over} it would need ${fmtCount(Math.round(cells))} cells, more than one cloth holds (${fmtCount(cap)}): it is coarsened to ${fmtLength(used, 'm')}.`
}

// project: { noScale, extent: [w, h] the cloud's horizontal extent in metres (null when
//   unknown), streamed, colour (the cloud has colours) }
export function classifyGroundEffects(s, { noScale = false, extent = null, streamed = false, colour = true } = {}) {
  s = { ...CLASSIFY_DEFAULTS, ...s }
  if (noScale) {
    const why = 'Needs real-world scale: georeference the model or add scale bars first.'
    return { cloth: why, label: why, buildings: why, vegetation: why }
  }
  const cloth =
    `A cloth of ${fmtLength(s.clothResolution, 'm')} cells, ${TERRAIN[s.rigidness] ?? TERRAIN[2]}, settles onto the cloud seen from below` +
    `${s.slopeSmoothing ? '; slope smoothing spreads it onto continuous steep ground' : ''}.` +
    (extent && s.clothResolution > 0 ? clothSize(s.clothResolution, extent, streamed) : '')
  const label =
    `Points within ${fmtLength(s.classThreshold, 'm')} of the cloth are ground, the rest above ground` +
    `${s.extent === 'core' ? '; outside the dense core points stay unclassified' : ', over the whole cloud'}.`
  const buildings =
    s.buildings === false
      ? 'Off: roofs and walls stay above ground, unclassified.'
      : `Flat surfaces, roofs and walls, that reach ${fmtLength(s.minBuildingHeight, 'm')} above the cloth and cover ` +
        `${fmtLength(s.minBuildingArea, 'm²')} are buildings, with their edges` +
        `${colour ? ', unless they are green' : ''}; smaller ones (a car, a low wall) stay unclassified.`
  const vegetation =
    s.vegetation === false
      ? 'Off: trees and shrubs stay above ground, unclassified.'
      : `${colour ? 'What is green, or ' : 'This cloud has no colour, so vegetation is found by its shape alone: '}` +
        `what scatters rather than forming a surface, is vegetation: low up to ${fmtLength(s.lowVegetationMax, 'm')} ` +
        `above the cloth, medium up to ${fmtLength(s.mediumVegetationMax, 'm')}, high above.`
  return { cloth, label, buildings, vegetation }
}
