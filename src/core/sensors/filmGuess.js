// Do the photos of a camera group look like scanned film? (pure)
//
// A sensor is film only when the user says so (Sensors ▸ Kind, or a calibration
// import): film means a focal and a film format in millimetres and fiducial marks,
// and an unanswered question costs more than it should. Rachel, a TMA block imported
// with nothing but the scans, ran as twelve "digital" cameras with a focal guessed at
// the scan width (10,141 px against a true ≈ 6,140): registration placed 16 of its
// 58 photos. This reads the signs of a scan so the app can ask.
//
// A group is a candidate when its photos carry no camera tags (no make, model or
// focal: a scanner writes none, or writes its own, `meta.scan`) and either name a
// scanner, or show at least two of: roll numbers in the file names (CA214732V0046),
// a large near-square frame (aerial film is 9 × 9 in), one colour channel. A digital
// photo stripped of its tags is 3:2 or 4:3 and in colour (ETH3D's DSC_0001.JPG has a
// roll-like name and nothing else), so it is not asked about. Groups the user already
// classified (kind 'film' or 'digital') are never candidates.

import { rollOf } from '../io/sensor.js'

const SQUARE_MAX_ASPECT = 1.15 // long side ÷ short side of a "square" frame
const SQUARE_MIN_PX = 4000 // a film scan is large; a square thumbnail is not one
const MIN_SIGNS = 2 // of roll / square / greyscale, without scanner tags

const hasCameraTags = (m) =>
  !!(m?.make || m?.model || m?.focalLength != null || m?.focalLength35 != null || m?.videoSource || m?.band)

const isSquareScan = (m) => {
  const a = Math.max(m?.width || 0, m?.height || 0),
    b = Math.min(m?.width || 0, m?.height || 0)
  return b > 0 && a >= SQUARE_MIN_PX && a / b <= SQUARE_MAX_ASPECT
}

// Which signs every photo of a group shows: { scanner, roll, square, grey }, or null
// when one of them has camera tags or no metadata yet.
function groupSigns(images) {
  if (!images.length || images.some((im) => !im.meta || hasCameraTags(im.meta))) return null
  return {
    scanner: images.some((im) => im.meta.scan),
    roll: images.every((im) => rollOf(im.name)),
    square: images.every((im) => isSquareScan(im.meta)),
    grey: images.every((im) => im.meta.channels === 1),
  }
}

/**
 * The camera groups that look like scanned film and are not classified yet.
 *   sensors — [{ id, kind }]; images — [{ name, sensorId, meta }]
 * → { sensorIds, images, signs: ['scanner' | 'roll' | 'square' | 'grey'] } (the signs
 *   every candidate shows), or null when there is nothing to ask.
 */
export function filmScanGuess({ sensors = [], images = [] } = {}) {
  const sensorIds = []
  let count = 0,
    shared = null
  for (const s of sensors) {
    if (s.kind === 'film' || s.kind === 'digital') continue
    const own = images.filter((im) => im.sensorId === s.id)
    const signs = groupSigns(own)
    if (!signs) continue
    const n = ['roll', 'square', 'grey'].filter((k) => signs[k]).length
    if (!signs.scanner && n < MIN_SIGNS) continue
    sensorIds.push(s.id)
    count += own.length
    shared = shared ? Object.fromEntries(Object.keys(shared).map((k) => [k, shared[k] && signs[k]])) : signs
  }
  if (!sensorIds.length) return null
  return { sensorIds, images: count, signs: Object.keys(shared).filter((k) => shared[k]) }
}
