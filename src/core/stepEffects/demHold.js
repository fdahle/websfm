// What Georeference ▸ Hold to a reference DEM does (GeoreferenceModal.vue): the tie
// points over stable ground held to a reference DEM in the bundle adjustment
// (core/sfm/bundleSession.js runDemAnchoredBundleAdjust, core/sfm/demAnchors.js).
import { SFM_TUNING } from '../tuning.js'
import { fmtCount, plural } from './format.js'

// s: { sigma (m) }
// project: { referenceName, referenceSigma (its declared vertical accuracy, m, or null),
//   stableName (null: everywhere), gcps (enabled control with coordinates), poses
//   (camera positions), geographic (the project CRS is in degrees), hasMatches }
// → { reference, stable, blocked } — `blocked` is why it cannot run, or null.
export function demHoldEffects(
  s,
  {
    referenceName = null,
    referenceSigma = null,
    stableName = null,
    gcps = 0,
    poses = 0,
    geographic = false,
    hasMatches = false,
  } = {},
) {
  const ref = referenceName ? `"${referenceName}"` : 'the reference DEM'
  const frame = gcps >= 3 ? plural(gcps, 'GCP') : plural(poses, 'camera position')
  const why =
    referenceSigma != null && s.sigma === referenceSigma
      ? ', its declared vertical accuracy'
      : referenceSigma == null && referenceName
        ? '; it declares no vertical accuracy'
        : ''
  const reference =
    `Each tie point seen in three or more photos is held to the height of ${ref} there, ±\u00a0${s.sigma}\u00a0m${why}, ` +
    'along the vertical only: the photos keep where it lies. ' +
    `Up to ${fmtCount(SFM_TUNING.demHoldMaxAnchors)} tie points spread over the block, in ` +
    `${SFM_TUNING.demHoldRounds} rounds, with the focal length and distortion re-estimated; ` +
    (gcps >= 3
      ? `the ${frame} place the model on it.`
      : `the ${frame} place the model on it, its height set between them and the DEM by their accuracies.`)
  const stable = stableName
    ? `Only tie points inside "${stableName}" are held: ground that changed stays free.`
    : `Tie points anywhere on ${ref} are held, except those far from its height. Ground that changed since ` +
      '(ice, pits, new buildings) is better left out with a layer of stable ground.'
  let blocked = null
  if (geographic) blocked = 'The project CRS is in degrees: choose a projected CRS in Project Settings.'
  else if (!hasMatches) blocked = 'Match features first.'
  else if (gcps < 3 && poses < 3)
    blocked = 'Needs three or more GCPs or camera positions to place the model on the reference DEM.'
  else if (!referenceName)
    blocked = 'Import a reference DEM (Import ▸ Reference DEM / Ortho), or fetch the Copernicus DEM.'
  else if (!(s.sigma > 0)) blocked = 'The height uncertainty must be above 0.'
  return { reference, stable, blocked }
}
