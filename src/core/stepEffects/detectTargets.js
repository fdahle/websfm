// What each step of Detect Targets does to this project (DetectTargetsModal.vue):
// the target's size in these photos, where the search runs, and which marks it keeps.
import { plural } from './format.js'

// project: { halfPx (median half-size of the target in the photos, null without a
// scale), predictions, photos, gcps (how many places, in how many photos, for how many
// GCPs the search will look), unplaced (GCPs with nothing to place them by) }; for
// AprilTags and ArUco markers { photos (enabled), gcps, tagged (GCPs with a number in their
// name) }.
export function detectTargetsEffects(s, project = {}) {
  if (s.kind === 'apriltag' || s.kind === 'aruco') return tagEffects(s, project)
  const { halfPx = null, predictions = 0, photos = 0, gcps = 0, unplaced = 0 } = project
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

function tagEffects(s, { photos = 0, gcps = 0, tagged = 0 }) {
  const what = s.kind === 'aruco' ? `ArUco ${String(s.arucoDict).toUpperCase()} markers` : 'AprilTag 36h11 tags'
  const targets = !gcps
    ? `${what}; no GCPs yet, ` +
      (s.addMarkers ? 'so each tag found becomes a marker.' : 'and new markers are off: nothing will be placed.')
    : `${what}: a GCP stands for the tag with the number in its name ` +
      `(${tagged} of ${plural(gcps, 'GCP')} ${tagged === 1 ? 'has' : 'have'} one).`
  const search = photos
    ? `Every tag in each of ${plural(photos, 'photo')}, the whole frame at full resolution; no model needed.`
    : 'No photos to search.'
  const marks =
    'Marks you placed stay' +
    (s.replaceDetected ? ', earlier detections are replaced' : ', and so do earlier detections') +
    (s.addMarkers
      ? '; a tag no GCP is named after becomes a marker "Tag N".'
      : '; a tag no GCP is named after is left out.')
  return { targets, search, marks }
}
