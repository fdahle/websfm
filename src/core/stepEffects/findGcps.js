// What each step of Find GCPs does (FindGcpsModal.vue): match the orthophoto to the
// reference coarse to fine (or fit the sparse cloud to a reference DEM), keep sparse
// tracks near the matches spread over the block, then review them and fill their
// heights (composables/useFindGcps.js, core/sfm/referenceGcps.js).
import { fmtCount, plural } from './format.js'

const MATCHERS = {
  auto: 'DISK + LightGlue (SuperPoint + LightGlue when its weights are installed)',
  disk: 'DISK + LightGlue',
  superpoint: 'SuperPoint + LightGlue',
  sift: 'SIFT',
}

// s: { matcher, band ('rgb' | 1-based index), candidates (the limit) }
// project: { referenceName, bandCount, demName, sparsePoints, stableName,
//   stablePolygons, found: null before a run, else { total, selected, control,
//   check, withoutZ (selected rows without a height) } }
export function findGcpsEffects(
  s,
  {
    referenceName = '',
    bandCount = 1,
    demName = '',
    sparsePoints = 0,
    stableName = '',
    stablePolygons = 0,
    found = null,
  } = {},
) {
  const terrain = s.matcher === 'terrain'
  let match
  if (terrain)
    match = demName
      ? `The sparse cloud's ${fmtCount(sparsePoints)} points are fitted to "${demName}" by ICP with scale, in four ` +
        `passes from 600 m to 60 m, starting from the orthophoto's georeference, GPS or vertical photos' footprints.`
      : `Choose the reference DEM to fit the sparse cloud's ${fmtCount(sparsePoints)} points to.`
  else if (!referenceName) match = 'Choose a reference orthophoto to match the orthophoto to.'
  else {
    const band = bandCount < 2 ? '' : s.band === 'rgb' ? ' (mean of bands 1–3)' : ` (band ${s.band})`
    const coarse = s.matcher === 'sift' ? 'a 1,536-pixel look at both' : 'both at the same ground resolution'
    match =
      `${MATCHERS[s.matcher] ?? s.matcher} matches the orthophoto to "${referenceName}"${band}: first ${coarse}, ` +
      `then up to 6 × 6 tiles at the coarser of the two resolutions.`
  }

  const g = Math.max(1, Math.round(Math.sqrt(s.candidates || 1)))
  const pick =
    `Up to ${plural(s.candidates || 0, 'sparse track')} seen in two or more photos, ` +
    (terrain ? "each within three times the fit's RMS of the DEM" : 'each next to a verified match') +
    `, spread over a ${g} × ${g} grid of the block` +
    (stableName ? `; only inside the ${plural(stablePolygons, 'polygon')} of "${stableName}".` : '; anywhere.')

  let review, heights
  if (!found) {
    review = 'Find candidates first; they are listed here to check one by one.'
    heights = 'After review, fill the selected candidates’ heights from a reference DEM or type them in.'
  } else if (!found.total) {
    review = 'No candidates were found.'
    heights = 'No candidates to fill.'
  } else {
    review =
      `${fmtCount(found.selected)} of ${plural(found.total, 'candidate')} selected: ` +
      `${fmtCount(found.control)} control, ${plural(found.check, 'checkpoint')}. Only selected rows are added.`
    heights = !found.selected
      ? 'Select candidates to fill their heights.'
      : !found.withoutZ
        ? found.selected === 1
          ? 'The selected candidate has a height.'
          : `All ${fmtCount(found.selected)} selected have a height.`
        : `${fmtCount(found.withoutZ)} of the ${fmtCount(found.selected)} selected have no height; ` +
          `without one a candidate cannot constrain the adjustment.`
  }
  return { match, pick, review, heights }
}
