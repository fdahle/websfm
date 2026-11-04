// What Reconstruct ▸ Georeference… does with each method (GeoreferenceModal.vue): adjust
// the reconstruction with GCPs, hold it to a reference DEM (demHold.js), or only fit
// a similarity into the project CRS (stores/reconstruction/georeferencing.js).
import { plural } from './format.js'

// project: { crs (code), crsName, geographic (the CRS is in degrees), hasMatches,
//   gcps (enabled control with coordinates), poses (camera positions),
//   adjustReady (≥ 3 of those GCPs each marked in two aligned photos),
//   transformReady (a similarity can be fitted: those GCPs, or ≥ 3 aligned camera positions) }

const DEGREES = 'The project CRS is in degrees: choose a projected CRS in Project Settings.'

// Why each method cannot run, or null: the disabled cards' tooltips and the warning.
export function georeferenceReasons({
  geographic = false,
  hasMatches = false,
  gcps = 0,
  poses = 0,
  adjustReady = false,
  transformReady = false,
} = {}) {
  const adjust = geographic
    ? DEGREES
    : !hasMatches
      ? 'Match features first.'
      : !adjustReady
        ? 'Needs three enabled GCPs with coordinates, each marked in two aligned photos.'
        : null
  const dem = geographic
    ? DEGREES
    : !hasMatches
      ? 'Match features first.'
      : gcps < 3 && poses < 3
        ? 'Needs three or more GCPs or camera positions to place the model on the reference DEM.'
        : null
  const transform = geographic
    ? DEGREES
    : !transformReady
      ? 'Needs a sparse model with three GCPs marked in two aligned photos each, or three aligned camera positions.'
      : null
  return { adjust, dem, transform }
}

// The method cards: [{ id, label, blurb, disabled, reason }].
export function georeferenceMethods(project = {}) {
  const why = georeferenceReasons(project)
  return [
    {
      id: 'adjust',
      label: 'Adjust with GCPs',
      blurb: 'Rebuild with the GCPs in the bundle adjustment. Best after adding control.',
      disabled: !!why.adjust,
      reason: why.adjust,
    },
    {
      id: 'dem',
      label: 'Hold to a reference DEM',
      blurb: 'Rebuild with the tie points held to a DEM, so the block cannot bend.',
      disabled: !!why.dem,
      reason: why.dem,
    },
    {
      id: 'transform',
      label: 'Transform only',
      blurb: 'Fit scale, rotation and shift. Cameras and points keep their shape.',
      disabled: !!why.transform,
      reason: why.transform,
    },
  ]
}

// The Source group's read-outs: { crs, control }.
export function georeferenceSource({ crs = '', crsName = '', gcps = 0, poses = 0 } = {}) {
  return {
    crs: crs ? (crsName && crsName !== crs ? `${crs} · ${crsName}` : crs) : 'Not set',
    control: `${plural(gcps, 'GCP')} with coordinates · ${plural(poses, 'camera position')}`,
  }
}

// The fit step's effect for the adjust and transform methods.
export function georeferenceFitEffect(mode, { crs = '', gcps = 0, adjustReady = false } = {}) {
  const into = crs || 'the project CRS'
  if (mode === 'adjust')
    return (
      `Build Sparse Model opens next and rebuilds the model with ${plural(gcps, 'GCP')} held in the bundle ` +
      `adjustment, so cameras and points move to agree with them; then the model is fitted into ${into}.`
    )
  const from = adjustReady ? 'the GCPs' : 'the aligned camera positions'
  return `Scale, rotation and shift that carry the model into ${into}, fitted to ${from}. Cameras and points keep their shape; nothing is rebuilt.`
}
