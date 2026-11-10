// Features that work but have not yet been checked on enough real data to trust their
// results without a second look. Each shows an "Experimental" badge where it is chosen
// (ExperimentalBadge, SettingsStep's `experimental`); the hover text says what has not
// been checked yet, in the user's terms. When a feature's checks pass, delete its entry
// and its badges (a unit test fails on an entry nothing shows, or a badge with no entry).
//
// Pure data: no Vue, no DOM.

const LEAD = 'Experimental: not yet checked on enough real data.'

export const EXPERIMENTAL = {
  rollingShutter: {
    feature: 'Rolling shutter',
    unchecked: 'whether estimating the readout time improves accuracy on a DJI block with independent checkpoints',
  },
  cameraRig: {
    feature: 'Multispectral rig',
    unchecked: 'band registration and reflectance on a real multispectral flight',
  },
  reflectance: {
    feature: 'Reflectance map',
    unchecked: 'reflectance against a held-out calibration panel on a real flight',
  },
  targetTags: {
    feature: 'AprilTag and ArUco detection',
    unchecked: 'detection on real photos of printed tags',
  },
  addToModel: {
    feature: 'Add to the model',
    unchecked: 'adding photos to a finished model against a full rebuild on real projects',
  },
}

/** The hover text of a badge: what is experimental and what to do about it. */
export function experimentalTitle(id) {
  const e = EXPERIMENTAL[id]
  if (!e) return null
  return `${LEAD} Still open: ${e.unchecked}. Compare its results with a reference before you rely on them.`
}
