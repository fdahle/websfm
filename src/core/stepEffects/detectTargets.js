// What each step of Detect Targets does to this project (DetectTargetsModal.vue):
// the target's size in these photos, where the search runs, and which marks it keeps.
import { plural } from './format.js'

// project: { halfPx (median half-size of the target in the photos, null without a
// scale), predictions, photos, gcps (how many places, in how many photos, for how many
// GCPs the search will look), unplaced (GCPs with nothing to place them by) }
export function detectTargetsEffects(s, { halfPx = null, predictions = 0, photos = 0, gcps = 0, unplaced = 0 } = {}) {
  const targets =
    halfPx > 0
      ? `Checker mats of ${s.sizeM} m, about ${Math.round(2 * halfPx)} px across in these photos.`
      : 'Checker mats: the model has no scale, so a middle size is assumed; a georeference or scale bars size them.'
  const search = !predictions
    ? 'Nothing to look for: a GCP needs coordinates and a georeference, or marks in two photos.'
    : `${plural(predictions, 'place')} in ${plural(photos, 'photo')} for ${plural(gcps, 'GCP')}, each searched ` +
      `within ${s.searchPx} px of where the model puts it` +
      (unplaced ? `; ${plural(unplaced, 'GCP')} without coordinates or two marks left out.` : '.')
  const marks =
    `A detection needs a score of ${s.minScore} or more; marks you placed stay` +
    (s.replaceDetected ? ', earlier detections are replaced.' : ', and so do earlier detections.')
  return { targets, search, marks }
}
