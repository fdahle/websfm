// Detection ops for the compute worker: keypoints (SIFT and learned detectors, photo
// quality), film scans (fiducials, réseau, panoramic strips) and targets, joined into one
// op table. Their shared bitmap reads are detectBitmaps.js.

import { makeKeypointOps } from './keypoints.js'
import { makeFilmOps } from './film.js'
import { makeTargetOps } from './targets.js'

// `rasterize` (injected) decodes a photo to RGBA for the detectors.
export function makeDetectOps({ rasterize }) {
  return { ...makeKeypointOps({ rasterize }), ...makeFilmOps(), ...makeTargetOps() }
}
